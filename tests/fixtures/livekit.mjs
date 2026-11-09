export const RoomEvent = Object.fromEntries(['TrackSubscribed','TrackUnsubscribed','TrackMuted','TrackUnmuted','ParticipantDisconnected','Disconnected'].map(x => [x,x]));
export const Track = {Kind:{Video:'video',Audio:'audio'},Source:{Camera:'camera'}};
export class Room {
  static instances = [];
  static connect = async () => {};
  constructor(options) {
    this.options = options;
    this.listeners = new Map();
    this.remoteParticipants = new Map();
    this.calls = [];
    this.localParticipant = {
      identity: 'local', trackPublications: new Map(),
      setMicrophoneEnabled: async on => { this.calls.push(['mic',on]); },
      setCameraEnabled: async on => { this.calls.push(['cam',on]); },
      getTrackPublication: () => null,
    };
    Room.instances.push(this);
  }
  on(name, fn) { this.listeners.set(name,fn); return this; }
  emit(name,...args) { this.listeners.get(name)?.(...args); }
  async connect() { await Room.connect(); }
  async disconnect() { this.disconnected = true; }
}
