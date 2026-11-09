import { Video } from '../implementation/web/video';

export function connectMedia(canCapture: () => boolean, soundOn: () => boolean, changed: () => void) {
  return new Video(changed, { canCapture, soundOn, modeEvent: 'example:mode' });
}
