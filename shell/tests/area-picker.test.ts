import { describe, expect, it, vi } from 'vitest';
import { openAreaPicker } from '../src/main/area-picker';
import { globalCaptureArea } from '../src/shared/geometry';
import type { BrowserWindowConstructorOptions } from 'electron';

function rig(visible = true) {
  let closed = () => {};
  const picker = { once: vi.fn((_event: 'closed', listener: () => void) => (closed = listener)) };
  const recorder = {
    isVisible: () => visible,
    isDestroyed: vi.fn(() => false),
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
  const create = vi.fn((_options: BrowserWindowConstructorOptions) => picker);
  return { picker, recorder, create, close: () => closed() };
}

describe('area picker over the current desktop', () => {
  it('covers the selected display without a new Space and preserves global crop coordinates', () => {
    const r = rig();
    const display = { x: -1728, y: -100, width: 1728, height: 1117 };
    expect(openAreaPicker(display, r.create, r.recorder, () => true)).toBe(r.picker);
    const config = r.create.mock.calls[0][0];
    expect(config).toMatchObject({ ...display, fullscreen: false, fullscreenable: false });
    expect(config.backgroundColor).toBe('#00000000');
    expect(globalCaptureArea({ x: 40, y: 80, width: 600, height: 400 }, display)).toEqual({
      x: -1688,
      y: -20,
      width: 600,
      height: 400,
    });
    expect(r.recorder.hide).toHaveBeenCalledOnce();
    expect(r.recorder.show).not.toHaveBeenCalled();
    r.close(); // Both confirmation and cancellation close the same window.
    expect(r.recorder.show).toHaveBeenCalledOnce();
    expect(r.recorder.focus).toHaveBeenCalledOnce();
  });
  it('does not reopen a hidden, destroyed or superseded recorder, or reopen while quitting/recording', () => {
    const display = { x: 0, y: 0, width: 1728, height: 1117 };
    for (const reason of ['hidden', 'destroyed', 'quit-or-active-or-replaced']) {
      const r = rig(reason !== 'hidden');
      let restoreAllowed = true;
      openAreaPicker(display, r.create, r.recorder, () => restoreAllowed);
      if (reason === 'destroyed') r.recorder.isDestroyed.mockReturnValue(true);
      if (reason === 'quit-or-active-or-replaced') restoreAllowed = false;
      r.close();
      expect(r.recorder.show).not.toHaveBeenCalled();
    }
  });
  it('leaves the recorder visible if window creation fails', () => {
    const r = rig();
    expect(() =>
      openAreaPicker(
        { x: 0, y: 0, width: 1000, height: 800 },
        () => {
          throw new Error('window creation failed');
        },
        r.recorder,
        () => true,
      ),
    ).toThrow('window creation failed');
    expect(r.recorder.hide).not.toHaveBeenCalled();
  });
});
