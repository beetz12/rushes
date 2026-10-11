import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SharingService, type ShareProvider } from '../src/main/sharing';
function rig(root: string) {
  const reservation = {
    id: 'stable-share-id',
    url: 'https://example.invalid/stable-share-id',
    manifest: { state: 'processing' },
  };
  const provider: ShareProvider = {
    reserve: vi.fn(async () => reservation),
    upload: vi.fn(async (_r, input) => ({
      file: input.kind + '-hash.mp4',
      bytes: 10,
      sha256: 'test-hash',
      kind: input.kind,
    })),
    publish: vi.fn(async (r) => ({ ...r, manifest: { state: 'ready' } })),
    updateMetadata: vi.fn(async (r) => ({ ...r, manifest: { ...r.manifest, enriched: true } })),
    delete: vi.fn(async () => {}),
    setupCheck: vi.fn(async () => ({ ok: true })),
  };
  const engine = {
    request: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'show') return { packagePath: root, manifest: { title: 'Fixture' } };
      if (cmd === 'export') {
        expect(String(args?.path)).toBe(join(root, 'renders', 'share.mp4'));
        await writeFile(String(args?.path), 'synthetic fixture export');
        return { width: 640, height: 480, durationMs: 1200 };
      }
      throw new Error('No metadata fixture');
    }),
  };
  return {
    provider,
    engine,
    service: new SharingService(
      engine,
      async () => provider,
      () => 'bucket:fixture',
      () => {},
    ),
  };
}
describe('stable share state', () => {
  it('keeps one real reservation across re-renders and supplies the latest reservation to delete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rushes-share-'));
    const r = rig(root);
    expect(await r.service.share('take')).toEqual({
      url: 'https://example.invalid/stable-share-id',
    });
    expect(await r.service.share('take')).toEqual({
      url: 'https://example.invalid/stable-share-id',
    });
    expect(r.provider.reserve).toHaveBeenCalledTimes(1);
    expect(r.provider.publish).toHaveBeenCalledTimes(2);
    const state = JSON.parse(await readFile(join(root, 'share', 'state.json'), 'utf8'));
    expect(state.state).toBe('ready');
    expect(state.reservation.manifest.state).toBe('ready');
    await r.service.unshare('take');
    expect(r.provider.delete).toHaveBeenCalledWith(state.reservation);
    await rm(root, { recursive: true });
  });
  it('persists the reservation before upload failure and reuses it on retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rushes-retry-'));
    const r = rig(root);
    vi.mocked(r.provider.upload).mockRejectedValueOnce(new Error('Fixture transport lost'));
    await expect(r.service.share('take')).rejects.toThrow('transport lost');
    const pending = JSON.parse(await readFile(join(root, 'share', 'state.json'), 'utf8'));
    expect(pending.state).toBe('processing');
    expect(pending.reservation.id).toBe('stable-share-id');
    await r.service.share('take');
    expect(r.provider.reserve).toHaveBeenCalledTimes(1);
    await rm(root, { recursive: true });
  });
  it('de-duplicates concurrent requests and refuses a changed provider for unshare', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rushes-provider-'));
    const r = rig(root);
    await Promise.all([r.service.share('take'), r.service.share('take')]);
    expect(r.provider.reserve).toHaveBeenCalledTimes(1);
    expect(r.provider.upload).toHaveBeenCalledTimes(1);
    const changed = new SharingService(
      r.engine,
      async () => r.provider,
      () => 'worker:other',
      () => {},
    );
    await expect(changed.unshare('take')).rejects.toMatchObject({
      code: 'share-provider-mismatch',
    });
    expect(r.provider.delete).not.toHaveBeenCalled();
    await rm(root, { recursive: true });
  });
  it('uploads only existing transcript sidecars and retains the same share URL on enrichment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rushes-enrich-'));
    const r = rig(root);
    await writeFile(join(root, 'captions.vtt'), 'WEBVTT\n\n00:00.000 --> 00:01.000\nFixture');
    await writeFile(join(root, 'transcript.json'), '{"locale":"en-US","words":[]}');
    await r.service.share('take');
    expect(vi.mocked(r.provider.upload).mock.calls.map((c) => c[1].kind)).toEqual([
      'video',
      'captions',
      'transcript',
    ]);
    const state = JSON.parse(await readFile(join(root, 'share', 'state.json'), 'utf8'));
    expect(state.reservation.url).toBe('https://example.invalid/stable-share-id');
    expect(state.reservation.manifest.enriched).toBe(true);
    expect(r.provider.updateMetadata).toHaveBeenCalledWith(expect.anything(), {
      captions: [{ file: 'captions-hash.mp4', lang: 'en' }],
      transcript: 'transcript-hash.mp4',
    });
    await rm(root, { recursive: true });
  });
});
