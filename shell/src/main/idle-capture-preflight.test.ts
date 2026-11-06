/// <reference lib="es2024.promise" />
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdleCapturePreflight } from './idle-capture-preflight';
import { finishPreviewCleanup } from './preview-cleanup';
import {
  defaultOptions,
  preflightInputs,
  microphoneLevelSchema,
  screenPreviewSchema,
} from '../shared/contracts';

const previews: IdleCapturePreflight[] = [];
function fixture() {
  let allowed = true;
  const actions = {
    allowed: () => allowed,
    start: vi.fn(
      async (
        selectionToken: string,
        selectionRevision: number,
        args: Record<string, unknown>,
      ): Promise<unknown> => ({
        selectionToken,
        selectionRevision,
        previewToken: randomUUID(),
        microphone: args.mic === 'none' ? null : args.mic,
        source: args.display ?? args.window ?? null,
      }),
    ),
    stop: vi.fn(async (_token: string, _revision: number): Promise<unknown> => ({
      quiescent: true,
    })),
    snapshot: vi.fn(async (_token: string): Promise<unknown> => ({})),
    clear: vi.fn(),
    ready: vi.fn(),
    image: vi.fn(),
    error: vi.fn(),
  };
  const preview = new IdleCapturePreflight(actions);
  previews.push(preview);
  return {
    preview,
    actions,
    hide: () => {
      allowed = false;
    },
  };
}
afterEach(async () => {
  await Promise.all(previews.splice(0).map((preview) => preview.stop().catch(() => {})));
  vi.useRealTimers();
});

describe('selected native feedback lifecycle', () => {
  it('correlates acknowledgment, resolved microphone and finite meter values', async () => {
    const { preview, actions } = fixture();
    await preview.select({ mic: 'native-id' });
    const ack = actions.ready.mock.calls[0][0];
    const level = {
      previewToken: ack.previewToken,
      microphone: 'native-id',
      available: true,
      measuredAtMs: 100,
      rms: 0.3,
      peak: 1,
      clipping: true,
      frames: 1024,
    };
    expect(preview.acceptsLevel(level)).toBe(true);
    // Milliseconds remain JSON-safe even after long machine uptimes.
    expect(preview.acceptsLevel({ ...level, measuredAtMs: 17_280_000_000 })).toBe(true);
    for (const bad of [
      { ...level, previewToken: randomUUID() },
      { ...level, microphone: 'browser-default' },
      { ...level, rms: NaN },
      { ...level, peak: Infinity },
      { ...level, frames: 0 },
    ])
      expect(preview.acceptsLevel(bad)).toBe(false);
    expect(
      preview.acceptsLevel({
        previewToken: ack.previewToken,
        microphone: 'native-id',
        available: false,
        measuredAtMs: 101,
      }),
    ).toBe(true);
    expect(microphoneLevelSchema.safeParse({ available: false }).success).toBe(false);
  });

  it('cancels before an old acknowledgment and waits for native drain before a replacement', async () => {
    const { preview, actions } = fixture();
    const first = Promise.withResolvers<unknown>(),
      stopped = Promise.withResolvers<unknown>();
    actions.start.mockImplementationOnce(() => first.promise);
    actions.stop.mockImplementationOnce(() => stopped.promise);
    const a = preview.select({ mic: 'a' });
    await vi.waitFor(() => expect(actions.start).toHaveBeenCalledTimes(1));
    const [token, revision] = actions.start.mock.calls[0];
    const b = preview.select({ mic: 'b' });
    expect(actions.stop).toHaveBeenCalledWith(token, revision);
    first.resolve({
      selectionToken: token,
      selectionRevision: revision,
      previewToken: randomUUID(),
      microphone: 'a',
      source: null,
    });
    await a;
    expect(actions.ready).not.toHaveBeenCalled();
    expect(actions.start).toHaveBeenCalledTimes(1);
    stopped.resolve({ quiescent: true });
    await b;
    expect(actions.ready).toHaveBeenCalledTimes(1);
    expect(actions.ready.mock.calls[0][0].microphone).toBe('b');
    expect(actions.start.mock.calls[1][1]).toBeGreaterThan(revision);
  });

  it('hide invalidates a pending source immediately and late success cannot restore it', async () => {
    const { preview, actions, hide } = fixture(),
      pending = Promise.withResolvers<unknown>();
    actions.start.mockImplementationOnce(() => pending.promise);
    const warm = preview.select({ mic: 'a' });
    await vi.waitFor(() => expect(actions.start).toHaveBeenCalledTimes(1));
    const [token, revision] = actions.start.mock.calls[0],
      previewToken = randomUUID();
    hide();
    const closing = preview.stop();
    pending.resolve({
      selectionToken: token,
      selectionRevision: revision,
      previewToken,
      microphone: 'a',
      source: null,
    });
    await warm;
    await closing;
    expect(actions.ready).not.toHaveBeenCalled();
    expect(
      preview.acceptsLevel({ previewToken, microphone: 'a', available: false, measuredAtMs: 1 }),
    ).toBe(false);
  });

  it('polls only after completion and rejects a screenshot returning after hide', async () => {
    vi.useFakeTimers();
    const { preview, actions, hide } = fixture(),
      pending = Promise.withResolvers<unknown>();
    actions.snapshot.mockImplementation(() => pending.promise);
    await preview.select({ mic: 'none', display: 'display-one' });
    const ack = actions.ready.mock.calls[0][0];
    expect(actions.snapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(actions.snapshot).toHaveBeenCalledTimes(1);
    hide();
    await preview.stop();
    pending.resolve({
      previewToken: ack.previewToken,
      source: 'display-one',
      mime: 'image/jpeg',
      width: 640,
      height: 480,
      jpeg: 'AQID',
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(actions.image).not.toHaveBeenCalled();
    expect(actions.snapshot).toHaveBeenCalledTimes(1);
  });

  it('closes an unconfirmed acknowledgment and bounds image bytes and geometry', async () => {
    const { preview, actions } = fixture();
    actions.start.mockResolvedValueOnce({ previewToken: randomUUID() });
    await expect(preview.select({ mic: 'a' })).rejects.toThrow();
    expect(actions.stop).toHaveBeenCalledTimes(1);
    expect(actions.ready).not.toHaveBeenCalled();
    const value = {
      previewToken: randomUUID(),
      source: 'd',
      mime: 'image/jpeg',
      width: 640,
      height: 480,
      jpeg: 'AQID',
    };
    expect(screenPreviewSchema.safeParse(value).success).toBe(true);
    for (const bad of [
      { ...value, width: 641 },
      { ...value, jpeg: 'A'.repeat(349_532) },
      { ...value, jpeg: 'not base64?' },
      { ...value, mime: 'image/svg+xml' },
    ])
      expect(screenPreviewSchema.safeParse(bad).success).toBe(false);
  });

  it('turns off screen feedback in camera-only and waits for a chosen area', () => {
    expect(preflightInputs({ ...defaultOptions, mode: 'camera-only', mic: 'native' })).toEqual({
      mic: 'native',
    });
    expect(preflightInputs({ ...defaultOptions, mode: 'area', area: undefined })).toEqual({
      mic: 'none',
    });
    expect(preflightInputs({ ...defaultOptions, mode: 'window', source: 'window-42' })).toEqual({
      mic: 'none',
      window: 'window-42',
    });
  });
  it('retries outstanding cleanup after a failed Stop rather than forgetting its native lease', async () => {
    const { preview, actions } = fixture();
    await preview.select({ mic: 'a' });
    actions.stop.mockRejectedValueOnce(
      Object.assign(new Error('still draining'), { code: 'preflight-busy' }),
    );
    await expect(preview.stop()).rejects.toThrow('still draining');
    await preview.stop();
    expect(actions.stop).toHaveBeenCalledTimes(2);
  });
  it('camera cleanup still runs when another source cleanup rejects or remains parked', async () => {
    const camera = vi.fn(async () => {}),
      subscription = vi.fn(async () => {});
    await expect(
      finishPreviewCleanup([
        async () => {
          throw new Error('mic cleanup failed');
        },
        subscription,
        camera,
      ]),
    ).rejects.toThrow('mic cleanup failed');
    expect(subscription).toHaveBeenCalledTimes(1);
    expect(camera).toHaveBeenCalledTimes(1);
    const parked = Promise.withResolvers<void>();
    const closing = finishPreviewCleanup([() => parked.promise, subscription, camera]);
    await Promise.resolve();
    await Promise.resolve();
    expect(camera).toHaveBeenCalledTimes(2);
    parked.resolve();
    await closing;
  });
});
