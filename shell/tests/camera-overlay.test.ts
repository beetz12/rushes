import { describe, expect, it, vi } from 'vitest';
import { CameraOverlayLifecycle } from '../src/main/camera-overlay';
function gate<T>() {
  const completion = { resolve(_value: T): void {} };
  const pending = new Promise<T>((ready) => {
    completion.resolve = ready;
  });
  return { promise: pending, resolve: (value: T) => completion.resolve(value) };
}
describe('camera overlay lifetime', () => {
  it('clears the idle preview at native armed, rejects its callback, and keeps a camera-less take clear', async () => {
    const overlay = new CameraOverlayLifecycle();
    let bubbleVisible = true;
    const warming = gate<boolean>();
    const idlePreview = overlay.showWhenReady(
      () => warming.promise,
      () => {
        bubbleVisible = true;
      },
    );
    // The production engine emits armed first, followed by recording-started.
    if (overlay.newTake('idle', 'armed')) bubbleVisible = false;
    const hasCamera = false;
    await overlay.showWhenReady(
      async () => hasCamera,
      (camera) => {
        if (camera) bubbleVisible = true;
      },
    );
    warming.resolve(true);
    await idlePreview;
    expect(bubbleVisible).toBe(false);
    expect(overlay.newTake('armed', 'recording')).toBe(false);
    expect(overlay.newTake('paused', 'recording')).toBe(false);
    expect(overlay.newTake('idle', 'preparing')).toBe(true);
    expect(overlay.newTake('preparing', 'armed')).toBe(false);
  });
  it.each(['Stop', 'close recorder', 'hide bubble', 'Quit', 'disconnect'])(
    'rejects a camera warm-up callback after %s',
    async () => {
      const overlay = new CameraOverlayLifecycle();
      const warm = gate<string>();
      const show = vi.fn();
      const pending = overlay.showWhenReady(() => warm.promise, show);
      overlay.hide();
      warm.resolve('ready');
      expect(await pending).toBe('ready');
      expect(show).not.toHaveBeenCalled();
    },
  );
  it('allows a newer explicit preview while rejecting the old device callback', async () => {
    const overlay = new CameraOverlayLifecycle();
    const old = gate<string>(),
      show = vi.fn();
    const pending = overlay.showWhenReady(() => old.promise, show);
    await overlay.showWhenReady(async () => 'new device', show);
    old.resolve('old device');
    await pending;
    expect(show.mock.calls).toEqual([['new device']]);
  });
  it('invalidates deferred idle cleanup when a newer camera preview is requested', async () => {
    const overlay = new CameraOverlayLifecycle();
    overlay.begin();
    const unsubscribe = gate<void>(),
      stopPreview = vi.fn();
    const hidden = overlay.hide();
    const cleanup = unsubscribe.promise.then(() => {
      if (overlay.sameGeneration(hidden)) stopPreview();
    });
    await overlay.showWhenReady(
      async () => 'new preview',
      () => {},
    );
    unsubscribe.resolve();
    await cleanup;
    expect(stopPreview).not.toHaveBeenCalled();
    const last = overlay.hide();
    expect(overlay.sameGeneration(last)).toBe(true);
  });
  it('does not subscribe after an old take lookup returns, and supports a new take', async () => {
    const overlay = new CameraOverlayLifecycle();
    const lookup = gate<string>(),
      subscribe = vi.fn(),
      show = vi.fn();
    const pending = overlay.showWhenReady(async (current) => {
      const result = await lookup.promise;
      if (current()) subscribe(result);
      return result;
    }, show);
    overlay.hide();
    lookup.resolve('stopped take');
    await pending;
    expect(subscribe).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    await overlay.showWhenReady(async () => 'new take', show);
    expect(show).toHaveBeenCalledWith('new take');
  });
});
