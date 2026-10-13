import { describe, expect, it } from 'vitest';
import { reviewVideoSources } from './review-video';

describe('review video source availability', () => {
  it.each(['camera-only', 'bubble', 'screen-only'])(
    'keeps a sole camera playable with hidden overlay and %s layout',
    (layout) => {
      expect(reviewVideoSources(false, true, layout, false)).toEqual({
        screen: false,
        camera: true,
        cameraPrimary: true,
      });
    },
  );
  it('shows camera-only video even when its recorded floating overlay was hidden', () => {
    expect(reviewVideoSources(true, true, 'camera-only', false)).toEqual({
      screen: false,
      camera: true,
      cameraPrimary: true,
    });
  });
  it('retains an intentionally hidden overlay on a screen recording', () => {
    expect(reviewVideoSources(true, true, 'bubble', false)).toEqual({
      screen: true,
      camera: false,
      cameraPrimary: false,
    });
  });
  it('falls back to the screen if no camera exists', () => {
    expect(reviewVideoSources(true, false, 'camera-only', false)).toEqual({
      screen: true,
      camera: false,
      cameraPrimary: false,
    });
  });
});
