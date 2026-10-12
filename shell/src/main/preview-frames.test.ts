import { describe, expect, it, vi } from 'vitest';
import { PreviewFrames } from './preview-frames';
import { IdleCameraPreview } from './idle-camera-preview';
import { CameraOverlayLifecycle } from './camera-overlay';
import { EngineClient } from './engine';
import { previewAcknowledgment } from '../shared/contracts';

describe('native camera lifetime correlation', () => {
  it('requires an acknowledged native token and never falls back to untagged JPEGs', () => {
    const frames = new PreviewFrames();
    expect(frames.accepts({ jpeg: 'AQID' })).toBe(false);
    for (const bad of [{}, null, { previewToken: '' }, { previewToken: 4 }])
      expect(() => previewAcknowledgment(bad)).toThrow('could not be confirmed');
    expect(() => frames.install({ enabled: true })).toThrow('could not be confirmed');
    frames.install({ previewToken: 'current-source', enabled: true });
    expect(frames.accepts({ jpeg: 'AQID' })).toBe(false);
    expect(frames.accepts({ jpeg: 'AQID', previewToken: 'obsolete-source' })).toBe(false);
    expect(frames.accepts({ jpeg: 'AQID', previewToken: 'current-source' })).toBe(true);
    expect(() => frames.install({ enabled: true })).toThrow('could not be confirmed');
    expect(frames.accepts({ jpeg: 'AQID', previewToken: 'current-source' })).toBe(false);
  });
  it.each(['before', 'after'])(
    'drops an old pending socket JPEG delivered %s a new source acknowledgment',
    (order) => {
      const frames = new PreviewFrames(),
        client = new EngineClient(),
        seen: string[] = [];
      client.on('event', (event) => {
        if (frames.accepts(event.result)) seen.push(event.result.jpeg);
      });
      frames.install({ previewToken: 'old' });
      const pendingSocketLine =
        JSON.stringify({ event: 'camera-preview', result: { previewToken: 'old', jpeg: 'OLD' } }) +
        '\n';
      const generation = frames.clear();
      if (order === 'before') client.ingest(pendingSocketLine);
      frames.install({ previewToken: 'new' }, generation);
      if (order === 'after') client.ingest(pendingSocketLine);
      const fresh =
        JSON.stringify({ event: 'camera-preview', result: { previewToken: 'new', jpeg: 'NEW' } }) +
        '\n';
      client.ingest(fresh.slice(0, 30));
      client.ingest(fresh.slice(30));
      expect(seen).toEqual(['NEW']);
    },
  );
  it('rejects obsolete acknowledgments after Close or after a newer source wins', () => {
    const frames = new PreviewFrames(),
      old = frames.clear();
    const next = frames.clear();
    frames.install({ previewToken: 'new' }, next);
    expect(frames.install({ previewToken: 'old' }, old)).toBe(false);
    expect(frames.install({}, old)).toBe(false);
    expect(frames.accepts({ previewToken: 'new' })).toBe(true);
    frames.clear();
    expect(frames.install({ previewToken: 'new' }, next)).toBe(false);
    expect(frames.accepts({ previewToken: 'new' })).toBe(false);
  });
  it('does not enable an idle preview or show its bubble if the current warm ack lacks its token', async () => {
    const frames = new PreviewFrames(),
      show = vi.fn();
    const preview = new IdleCameraPreview({
      allowed: () => true,
      start: async () => ({ running: true }),
      stop: async () => {},
      clear: () => {
        frames.clear();
      },
      show,
    });
    await expect(preview.select('camera')).rejects.toMatchObject({ code: 'preview-token-invalid' });
    expect(show).not.toHaveBeenCalled();
    expect(preview.acceptsFrames).toBe(false);
    expect(frames.accepts({ jpeg: 'AQID' })).toBe(false);
  });
  it('rejects a delayed obsolete idle warm ack while accepting the newer selected camera token', async () => {
    const frames = new PreviewFrames(),
      displayed: string[] = [];
    let completeOld!: (value: unknown) => void;
    const parkedOld = new Promise<unknown>((deliverOld) => {
      completeOld = deliverOld;
    });
    const acquire = vi
      .fn()
      .mockImplementationOnce(() => parkedOld)
      .mockResolvedValue({ previewToken: 'new' });
    const preview = new IdleCameraPreview({
      allowed: () => true,
      start: acquire,
      stop: async () => {},
      clear: () => {
        frames.clear();
      },
      show: (ack) => {
        frames.install(ack);
        displayed.push(ack.previewToken);
      },
    });
    const obsolete = preview.select('old-camera');
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
    const current = preview.select('new-camera');
    completeOld({ previewToken: 'old' });
    await Promise.all([obsolete, current]);
    expect(displayed).toEqual(['new']);
    expect(frames.accepts({ previewToken: 'old' })).toBe(false);
    expect(frames.accepts({ previewToken: 'new' })).toBe(true);
  });
  it.each(['Close', 'Cancel', 'Stop', 'new take'])(
    'keeps the recording bubble closed after a subscription ack arrives after %s',
    async () => {
      const frames = new PreviewFrames(),
        overlay = new CameraOverlayLifecycle(),
        show = vi.fn();
      let completeSubscription!: (value: unknown) => void;
      const subscription = new Promise<unknown>((deliverSubscription) => {
        completeSubscription = deliverSubscription;
      });
      const generation = frames.clear();
      const pending = overlay.showWhenReady(
        async (current) => {
          const ack = await subscription;
          return current() && frames.install(ack, generation);
        },
        (confirmed) => {
          if (confirmed) show();
        },
      );
      overlay.hide();
      frames.clear();
      completeSubscription({ enabled: true, previewToken: 'recording-source' });
      await pending;
      expect(show).not.toHaveBeenCalled();
      expect(frames.accepts({ previewToken: 'recording-source' })).toBe(false);
    },
  );
});
