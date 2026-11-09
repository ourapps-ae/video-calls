import { Room, RoomEvent, Track, type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant } from "livekit-client";

export interface VideoSettings {
  canCapture: () => boolean;
  soundOn: () => boolean;
  modeEvent: string;
}

function element(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

export class Video {
  room: Room | null = null;
  connected = false;
  micOn = true;
  camOn = true;
  camUsable = true;
  paused = false;
  failed = false;
  private held = false;
  private last: { url: string; token: string; room: string } | null = null;
  private idle = 0;
  private videos = new Map<string, HTMLVideoElement>();
  private generation = 0;
  private audio = new Set<HTMLMediaElement>();
  private onChange: () => void;
  private settings: VideoSettings;
  private modeChanged = () => { if (!this.settings.canCapture()) this.disconnect(); };

  constructor(onChange: () => void, settings: VideoSettings) {
    this.onChange = onChange;
    this.settings = settings;
    window.addEventListener(settings.modeEvent, this.modeChanged);
  }

  async connect(url: string, token: string, roomName: string) {
    if (!this.settings.canCapture()) return;
    this.last = { url, token, room: roomName };
    this.paused = false;
    this.failed = false;
    if (this.room && this.connected) return;
    this.disconnect();
    this.last = { url, token, room: roomName };
    const generation = this.generation;
    const room = new Room({ adaptiveStream: true, dynacast: true, videoCaptureDefaults: { resolution: { width: 320, height: 240, frameRate: 15 }, facingMode: "user" } });
    this.room = room;
    const refresh = () => { if (generation === this.generation) this.onChange(); };
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (generation !== this.generation || !this.settings.canCapture()) { track.detach().forEach((e) => e.remove()); return; }
      if (track.kind === Track.Kind.Video) this.attach(participant.identity, track.attach() as HTMLVideoElement);
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        el.muted = !this.settings.soundOn();
        this.audio.add(el);
        document.body.append(el);
      }
      refresh();
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      track.detach().forEach((e) => e.remove());
      if (generation === this.generation && track.kind === Track.Kind.Video) this.videos.delete(participant.identity);
      refresh();
    });
    room.on(RoomEvent.TrackMuted, refresh);
    room.on(RoomEvent.TrackUnmuted, refresh);
    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => { if (generation === this.generation) this.videos.delete(participant.identity); refresh(); });
    room.on(RoomEvent.Disconnected, () => { if (generation === this.generation) { this.connected = false; this.failed = true; refresh(); } });
    try {
      await room.connect(url, token);
      if (generation !== this.generation || !this.settings.canCapture()) { await room.disconnect(); return; }
      this.connected = true;
    } catch {
      if (generation !== this.generation) return;
      this.connected = false;
      this.failed = true;
      this.room = null;
      refresh();
      return;
    }
    await this.applyMedia();
    this.armIdle();
    refresh();
  }

  hold(on: boolean) {
    if (on === this.held) return;
    this.held = on;
    void this.applyMedia().then(() => this.onChange());
  }

  private async applyMedia() {
    const room = this.room;
    const generation = this.generation;
    if (!room || !this.connected || !this.settings.canCapture()) return;
    try { await room.localParticipant.setMicrophoneEnabled(this.micOn && !this.held); } catch { this.micOn = false; }
    if (generation !== this.generation || !this.settings.canCapture()) { await room.disconnect(); return; }
    try {
      await room.localParticipant.setCameraEnabled(this.camOn && !this.held);
      if (generation !== this.generation || !this.settings.canCapture()) { await room.disconnect(); return; }
      const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      if (pub?.track && !this.videos.has(room.localParticipant.identity)) this.attach(room.localParticipant.identity, pub.track.attach() as HTMLVideoElement);
    } catch { this.camOn = false; this.camUsable = false; }
  }

  private attach(identity: string, el: HTMLVideoElement) {
    el.muted = identity === this.room?.localParticipant.identity;
    el.playsInline = true;
    this.videos.set(identity, el);
  }

  hasVideo(playerId: string, isMe: boolean): boolean {
    const room = this.room;
    if (!this.connected || !room) return false;
    if (isMe) return this.camOn && !this.held && this.videos.has(room.localParticipant.identity);
    const pub = room.remoteParticipants.get(playerId)?.getTrackPublication(Track.Source.Camera);
    return !!pub && pub.isSubscribed && !pub.isMuted && this.videos.has(playerId);
  }

  monitor(playerId: string, isMe: boolean, name: string, width: number, aspect = 0.75): HTMLElement {
    const el = element(`monitor${isMe ? " me" : ""}`);
    if (width) { el.style.width = `${width}px`; el.style.height = `${width * aspect}px`; }
    this.appendVideo(el, playerId, name);
    return el;
  }

  cell(playerId: string, isMe: boolean, initial: string): HTMLElement {
    const el = element(`vcell${isMe ? " me" : ""}`);
    if (!this.appendVideo(el, playerId, "")) {
      const placeholder = element("vcell-ph");
      placeholder.textContent = initial.slice(0, 1);
      el.append(placeholder);
    }
    return el;
  }

  private appendVideo(el: HTMLElement, playerId: string, initial: string): boolean {
    const v = this.connected ? this.videos.get(playerId) : undefined;
    if (!v) { el.textContent = initial.slice(0, 1); return false; }
    const clone = v.cloneNode(true) as HTMLVideoElement;
    clone.srcObject = v.srcObject;
    clone.muted = true;
    clone.playsInline = true;
    clone.autoplay = true;
    el.append(clone);
    return true;
  }

  setSpeaker(on: boolean) { for (const el of this.audio) el.muted = !on; }
  get granted(): boolean { return !!this.last; }
  get stalled(): boolean { return !this.connected && !!this.last && (this.paused || this.failed); }
  async setMic(on: boolean) { if (!this.settings.canCapture()) return; this.micOn = on; await this.applyMedia(); }
  async setCam(on: boolean) { if (!this.settings.canCapture()) return; this.camOn = on; await this.applyMedia(); }

  armIdle() {
    if (!this.settings.canCapture()) return;
    clearTimeout(this.idle);
    this.idle = window.setTimeout(() => {
      if (this.connected) {
        const last = this.last;
        this.disconnect();
        this.last = last;
        this.paused = true;
        this.onChange();
      }
    }, 5 * 60 * 1000);
  }

  resume() { if (this.last) void this.connect(this.last.url, this.last.token, this.last.room); }

  disconnect() {
    this.generation++;
    clearTimeout(this.idle);
    this.room?.localParticipant.trackPublications.forEach((pub) => pub.track?.stop());
    void this.room?.disconnect();
    this.room = null;
    this.connected = false;
    this.videos.clear();
    for (const el of this.audio) { el.pause(); el.srcObject = null; el.remove(); }
    this.audio.clear();
    this.last = null;
    this.failed = false;
  }

  close() {
    this.disconnect();
    window.removeEventListener(this.settings.modeEvent, this.modeChanged);
  }
}
