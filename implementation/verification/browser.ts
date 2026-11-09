import { Video } from '../web/video';
import { Track } from 'livekit-client';
import { createVideoBinding } from './binding';

const configuration = (window as unknown as { mediaVerificationConfiguration: { application: boolean; publisherIdentity: string } }).mediaVerificationConfiguration;

let mode = 'player';
const binding = createVideoBinding(configuration.application, () => new Video(() => {}, { canCapture: () => mode === 'player', soundOn: () => false, modeEvent: 'verification-mode' }));
let grant: { url: string; token: string; room: string };
const captures: MediaStream[] = [];
const timers: number[] = [];
let finalCaptureCount: number | null = null;
const active = () => captures.flatMap(stream => stream.getTracks()).filter(track => track.readyState === 'live').length;

async function publish() {
  const video = binding.session();
  const canvas = document.createElement('canvas');
  canvas.width = 160; canvas.height = 120;
  const paint = canvas.getContext('2d')!;
  let frame = 0;
  timers.push(window.setInterval(() => {
    paint.fillStyle = ++frame % 2 ? '#ff0000' : '#00ff00';
    paint.fillRect(0, 0, canvas.width, canvas.height);
  }, 50));
  const stream = canvas.captureStream(10);
  captures.push(stream);
  if (!video.room) throw new Error('assertion-failed');
  await video.room.localParticipant.publishTrack(stream.getVideoTracks()[0], { source: Track.Source.Camera });
}

const client = {
  bindVideo: binding.bindVideo,
  setGrant(value: typeof grant) { grant = value; },
  async connect() {
    const video = binding.session();
    if (configuration.application) {
      const deadline = performance.now() + 30000;
      while (!video.connected || video.room?.name !== grant.room) {
        if (performance.now() >= deadline) throw new Error('timeout');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    } else await video.connect(grant.url, grant.token, grant.room);
    if (!video.connected || video.room?.name !== grant.room) throw new Error('assertion-failed');
  },
  publishSynthetic: publish,
  async attemptPublish() {
    try { await publish(); return true; } catch { return false; }
    finally { captures.forEach(stream => stream.getTracks().forEach(track => track.stop())); }
  },
  async waitForFrames(minimum: number, timeoutMilliseconds: number) {
    const video = binding.session();
    const start = performance.now();
    while (!video.hasVideo(configuration.publisherIdentity, false)) {
      if (performance.now() - start > timeoutMilliseconds) throw new Error('timeout');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const monitor = video.monitor(configuration.publisherIdentity, false, 'Publisher', 160);
    document.body.append(monitor);
    const element = monitor.querySelector('video')!;
    await element.play();
    return await new Promise<number>((resolve, reject) => {
      let frames = 0;
      const timer = setTimeout(() => { monitor.remove(); reject(new Error('timeout')); }, timeoutMilliseconds);
      const observed = () => {
        frames++;
        if (frames >= minimum) { clearTimeout(timer); monitor.remove(); resolve(frames); }
        else element.requestVideoFrameCallback(observed);
      };
      element.requestVideoFrameCallback(observed);
    });
  },
  async disconnect() { const video = binding.session(); const room = video.room; video.disconnect(); await room?.disconnect(); },
  async reconnect() { const video = binding.session(); await video.connect(grant.url, grant.token, grant.room); if (!video.connected) throw new Error('assertion-failed'); },
  async enterDisplay() {
    const video = binding.session();
    const room = video.room;
    mode = 'board';
    document.documentElement.dataset.mode = mode;
    window.dispatchEvent(new CustomEvent('verification-mode', { detail: { mode } }));
    await room?.disconnect();
    await new Promise(resolve => setTimeout(resolve, 50));
  },
  async activeCaptureCount() { return finalCaptureCount ?? active(); },
  async close() {
    try {
      const video = binding.session();
      const room = video.room;
      video.close();
      await room?.disconnect();
      await new Promise(resolve => setTimeout(resolve, 50));
      finalCaptureCount = active();
      return finalCaptureCount;
    } finally {
      timers.forEach(clearInterval);
      captures.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    }
  },
};

Object.assign(window, { mediaVerification: client });
