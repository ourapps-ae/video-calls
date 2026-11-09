import type { Video } from '../web/video';

export function createVideoBinding(application: boolean, createFixture: () => Video) {
  let bound: Video | null = application ? null : createFixture();
  if (bound) { bound.micOn = false; bound.camOn = false; }
  return {
    bindVideo(actual: Video) {
      if (!application || (bound && bound !== actual)) throw new Error('assertion-failed');
      if (bound !== null && bound === actual) return;
      if (!actual || ['connect', 'disconnect', 'close', 'hasVideo', 'monitor'].some(name => typeof actual[name as keyof Video] !== 'function') ||
          typeof actual.micOn !== 'boolean' || typeof actual.camOn !== 'boolean' || actual.connected !== false || actual.room !== null) throw new Error('assertion-failed');
      actual.micOn = false;
      actual.camOn = false;
      bound = actual;
    },
    session(): Video {
      if (!bound) throw new Error('assertion-failed');
      return bound;
    },
  };
}
