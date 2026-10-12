import { describe, expect, it, vi } from 'vitest';
import { IdleCameraPreview } from './idle-camera-preview';
import { CountdownSignals, RecordingStartup, RecordingWindowLifecycle } from './recording-controls';
import {
  defaultOptions,
  recordingOptionsSchema,
  recordingStartArguments,
  selectedExportPreset,
} from '../shared/contracts';

function deferred<T>() {
  let releasePreview!: (previewValue: T) => void;
  const previewPromise = new Promise<T>((openedPreview) => {
    releasePreview = openedPreview;
  });
  return { promise: previewPromise, resolve: releasePreview };
}
function rig() {
  let allowed = true;
  const actions = {
    allowed: () => allowed,
    start: vi.fn(async (_camera: string) => ({})),
    stop: vi.fn(async () => ({})),
    clear: vi.fn(),
    show: vi.fn(),
  };
  return {
    actions,
    preview: new IdleCameraPreview(actions),
    allow: (value: boolean) => {
      allowed = value;
    },
  };
}
describe('camera-only request and original export selections', () => {
  it('round-trips camera-only through settings and excludes every screen parameter and system audio', () => {
    const options = recordingOptionsSchema.parse({
      ...defaultOptions,
      mode: 'camera-only',
      camera: 'fixture-camera',
      mic: 'fixture-mic',
      systemAudio: true,
      cursor: 'data',
      source: 'stale-window',
      area: { x: 10, y: 20, width: 100, height: 90 },
    });
    expect(recordingStartArguments(options)).toEqual({
      camera: 'fixture-camera',
      mic: 'fixture-mic',
      systemAudio: false,
      countdownSeconds: 3,
    });
    expect(() => recordingStartArguments({ ...options, camera: 'none' })).toThrow(
      'Choose a camera',
    );
  });
  it('retains real screen/window/area targets, optional input-off settings and validates missing sources', () => {
    expect(recordingStartArguments(defaultOptions)).toMatchObject({
      display: 'main',
      camera: 'none',
      mic: 'none',
      cursor: 'baked',
    });
    expect(
      recordingStartArguments({ ...defaultOptions, mode: 'window', source: 'window-23' }),
    ).toMatchObject({ window: 'window-23' });
    expect(
      recordingStartArguments({ ...defaultOptions, mode: 'window', source: 'window-23' }),
    ).not.toHaveProperty('display');
    expect(() =>
      recordingStartArguments({ ...defaultOptions, mode: 'window', source: '' }),
    ).toThrow('Choose a window');
    expect(() => recordingStartArguments({ ...defaultOptions, mode: 'area' })).toThrow(
      'Select a recording area',
    );
    const area = { x: -300, y: 40, width: 100, height: 90 };
    expect(recordingStartArguments({ ...defaultOptions, mode: 'area', area })).toMatchObject({
      display: 'main',
      area,
    });
  });
  it('routes an explicit separate choice through the existing original-track exporter regardless of video format', () => {
    for (const format of ['share', 'full', 'youtube', 'audio-wav'] as const) {
      expect(selectedExportPreset('separate', format)).toBe('editor-tracks');
      expect(selectedExportPreset('combined', format)).toBe(format);
    }
  });
});
describe('selected camera preview lifetime', () => {
  it('warms restored/navigated camera once and publishes only after acquisition succeeds', async () => {
    const r = rig(),
      warm = deferred<unknown>();
    r.actions.start.mockImplementationOnce(() => warm.promise as Promise<{}>);
    const first = r.preview.select('selected-camera');
    await vi.waitFor(() => expect(r.actions.start).toHaveBeenCalledTimes(1));
    expect(r.preview.acceptsFrames).toBe(false);
    expect(r.actions.show).not.toHaveBeenCalled();
    const repeated = r.preview.select('selected-camera');
    warm.resolve({ running: true });
    await Promise.all([first, repeated]);
    expect(r.preview.acceptsFrames).toBe(true);
    expect(r.actions.show).toHaveBeenCalledTimes(1);
    expect(r.actions.start).toHaveBeenCalledExactlyOnceWith('selected-camera');
  });
  it('serializes switches and rejects stale camera frames and a late old device callback', async () => {
    const r = rig(),
      old = deferred<unknown>();
    r.actions.start.mockImplementationOnce(() => old.promise as Promise<{}>);
    const first = r.preview.select('old-camera');
    await vi.waitFor(() => expect(r.actions.start).toHaveBeenCalledTimes(1));
    const next = r.preview.select('new-camera');
    expect(r.preview.acceptsFrames).toBe(false);
    old.resolve({ running: true });
    await Promise.all([first, next]);
    expect(r.actions.start.mock.calls).toEqual([['old-camera'], ['new-camera']]);
    expect(r.actions.show).toHaveBeenCalledTimes(1);
    expect(r.preview.acceptsFrames).toBe(true);
    expect(r.actions.stop).toHaveBeenCalledTimes(2);
  });
  it.each(['Camera off', 'Hide bubble', 'Close recorder'])(
    'clears immediately and stops a late warm-up after %s',
    async () => {
      const r = rig(),
        warm = deferred<unknown>();
      r.actions.start.mockImplementationOnce(() => warm.promise as Promise<{}>);
      const pending = r.preview.select('camera');
      await vi.waitFor(() => expect(r.actions.start).toHaveBeenCalledTimes(1));
      const stopping = r.preview.stop();
      expect(r.preview.acceptsFrames).toBe(false);
      warm.resolve({ running: true });
      await Promise.all([pending, stopping]);
      expect(r.actions.show).not.toHaveBeenCalled();
      expect(r.actions.stop).toHaveBeenCalledTimes(2);
      await r.preview.select('camera');
      expect(r.actions.show).toHaveBeenCalledTimes(1);
    },
  );
  it('does not publish or show if a recording or hidden recorder takes over during warm-up', async () => {
    const r = rig(),
      warm = deferred<unknown>();
    r.actions.start.mockImplementationOnce(() => warm.promise as Promise<{}>);
    const pending = r.preview.select('camera');
    await vi.waitFor(() => expect(r.actions.start).toHaveBeenCalledTimes(1));
    r.allow(false);
    r.preview.invalidate();
    warm.resolve({ running: true });
    await pending;
    expect(r.preview.acceptsFrames).toBe(false);
    expect(r.actions.show).not.toHaveBeenCalled();
  });
  it('allows retry after failed acquisition without retaining a broken current selection', async () => {
    const r = rig();
    r.actions.start.mockRejectedValueOnce(new Error('Unavailable camera'));
    await expect(r.preview.select('camera')).rejects.toThrow('Unavailable camera');
    expect(r.preview.acceptsFrames).toBe(false);
    await r.preview.select('camera');
    expect(r.actions.start).toHaveBeenCalledTimes(2);
    expect(r.actions.show).toHaveBeenCalledTimes(1);
  });
});
describe('native countdown and active window gate', () => {
  it('cancels before the native Start request while idle camera cleanup is pending', async () => {
    const startup = new RecordingStartup(),
      cleanup = deferred<unknown>(),
      issue = vi.fn();
    const attempt = startup.begin();
    const pending = cleanup.promise.then(() => {
      startup.issue(attempt);
      issue();
    });
    expect(() => startup.begin()).toThrow('already starting');
    expect(startup.cancelBeforeIssue()).toBe(true);
    expect(startup.canceling).toBe(true);
    cleanup.resolve({});
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(issue).not.toHaveBeenCalled();
    startup.finish(attempt);
    const next = startup.begin();
    startup.issue(next);
    expect(next.issued).toBe(true);
    startup.finish(next);
    expect(startup.canceling).toBe(false);
  });
  it('forwards Cancel to native after Start has been issued and releases failed startup for retry', () => {
    const startup = new RecordingStartup(),
      attempt = startup.begin();
    startup.issue(attempt);
    expect(startup.cancelBeforeIssue()).toBe(false);
    expect(startup.canceling).toBe(true);
    startup.finish(attempt);
    expect(startup.canceling).toBe(false);
    expect(startup.cancelBeforeIssue()).toBe(false);
    const failed = startup.begin();
    startup.finish(failed);
    expect(startup.begin()).toEqual({ canceled: false, issued: false });
  });
  it.each([0, 3, 5])(
    'plays exactly the positive native steps for a %s-second countdown',
    (seconds) => {
      const cues = new CountdownSignals(),
        ticks: number[] = [];
      cues.event({ event: 'state-changed', state: 'armed', recordingId: 'take' });
      for (let remaining = seconds; remaining >= 0; remaining--) {
        const event = { event: 'countdown', recordingId: 'take', result: { remaining } };
        const tick = cues.event(event);
        if (tick !== undefined) ticks.push(tick);
        expect(cues.event(event)).toBeUndefined();
      }
      expect(ticks).toEqual(Array.from({ length: seconds }, (_, index) => seconds - index));
    },
  );
  it.each(['cancel', 'recording-started', 'recording-stopped', 'engine-reconnected', 'failed'])(
    'rejects queued native steps after %s',
    (ending) => {
      const cues = new CountdownSignals();
      cues.event({ event: 'state-changed', state: 'armed', recordingId: 'take' });
      expect(cues.event({ event: 'countdown', recordingId: 'take', remaining: 3 })).toBe(3);
      if (ending === 'cancel') cues.cancel();
      else cues.event({ event: ending === 'failed' ? 'state-changed' : ending, state: ending });
      expect(cues.event({ event: 'countdown', recordingId: 'take', remaining: 2 })).toBeUndefined();
      cues.event({ event: 'state-changed', state: 'armed', recordingId: 'new-take' });
      expect(cues.event({ event: 'countdown', recordingId: 'take', remaining: 1 })).toBeUndefined();
      expect(cues.event({ event: 'countdown', recordingId: 'new-take', remaining: 5 })).toBe(5);
    },
  );
  it('never minimizes on startup response, preparing, armed, failure, cancellation, pause or recovery; once at the real gate', () => {
    const lifecycle = new RecordingWindowLifecycle(),
      minimize = vi.fn();
    for (const event of [
      { event: 'record.start', state: 'recording', recordingId: 'take' },
      ...['preparing', 'armed', 'idle', 'failed', 'paused', 'recording'].map((state) => ({
        event: 'state-changed',
        state,
        recordingId: 'take',
      })),
      { event: 'engine-reconnected', state: 'recording', recordingId: 'take' },
    ])
      expect(lifecycle.event(event, minimize)).toBe(false);
    expect(minimize).not.toHaveBeenCalled();
    expect(lifecycle.event({ event: 'recording-started', recordingId: 'take' }, minimize)).toBe(
      true,
    );
    expect(lifecycle.event({ event: 'recording-started', recordingId: 'take' }, minimize)).toBe(
      false,
    );
    expect(minimize).toHaveBeenCalledTimes(1);
    expect(
      lifecycle.event({ event: 'recording-started', recordingId: 'next-take' }, minimize),
    ).toBe(true);
    expect(minimize).toHaveBeenCalledTimes(2);
  });
});
