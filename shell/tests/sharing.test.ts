import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
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
    publish: vi.fn(async (r, input) => ({
      ...r,
      manifest: { ...r.manifest, ...input, state: 'ready' },
    })),
    updateMetadata: vi.fn(async (r) => ({ ...r, manifest: { ...r.manifest, enriched: true } })),
    delete: vi.fn(async () => {}),
    setupCheck: vi.fn(async () => ({ ok: true })),
  };
  const engine = {
    request: vi.fn(async (cmd: string) => {
      if (cmd === 'show')
        return {
          packagePath: root,
          manifest: { title: 'Fixture', clock: { durationNs: 1200000000 } },
        };
      if (cmd === 'share.assets') {
        const folder = join(root, 'renders', 'shared_assets', 'fixture-key');
        await mkdir(folder, { recursive: true });
        const videoPath = join(folder, 'share.mp4'),
          posterPath = join(folder, 'poster.jpg');
        await writeFile(videoPath, 'synthetic fixture export');
        await writeFile(posterPath, 'synthetic fixture poster');
        return {
          id: 'take',
          videoPath,
          posterPath,
          width: 640,
          height: 480,
          durationMs: 1200,
          title: 'Edited fixture',
          summary: 'Fixture summary',
          chapters: [{ startMs: 0, title: 'Edited chapter' }],
          cacheKey: 'fixture-key',
          editRevision: 2,
          editSnapshot: {
            schema: 'rushes.edit/1',
            revision: 2,
            clips: [{ sourceStartMs: 100, sourceEndMs: 1200, speed: 2 }],
          },
          cached: true,
        };
      }
      throw new Error('No fixture for command');
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
  it('keeps one reservation across re-renders and supplies the latest reservation to delete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rushes-share-'));
    const r = rig(root);
    expect(await r.service.share('take', true)).toEqual({
      url: 'https://example.invalid/stable-share-id',
      state: 'ready',
    });
    expect(await r.service.share('take', true)).toEqual({
      url: 'https://example.invalid/stable-share-id',
      state: 'ready',
    });
    expect(r.provider.reserve).toHaveBeenCalledTimes(1);
    expect(r.provider.publish).toHaveBeenCalledTimes(2);
    const state = JSON.parse(await readFile(join(root, 'share', 'state.json'), 'utf8'));
    expect(state.state).toBe('ready');
    expect(state.reservation.manifest.state).toBe('ready');
    expect(state.editRevision).toBe(2);
    await r.service.unshare('take');
    expect(r.provider.delete).toHaveBeenCalledWith(state.reservation);
    await rm(root, { recursive: true });
  });
  it('persists the reservation before upload failure and reuses it on retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rushes-retry-'));
    const r = rig(root);
    vi.mocked(r.provider.upload).mockRejectedValueOnce(new Error('Fixture transport lost'));
    await expect(r.service.share('take', true)).rejects.toThrow('transport lost');
    const pending = JSON.parse(await readFile(join(root, 'share', 'state.json'), 'utf8'));
    expect(pending.state).toBe('failed');
    expect(pending.reservation.id).toBe('stable-share-id');
    await r.service.share('take', true);
    expect(r.provider.reserve).toHaveBeenCalledTimes(1);
    await rm(root, { recursive: true });
  });
  it('de-duplicates concurrent requests and refuses changed provider unshare', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rushes-provider-'));
    const r = rig(root);
    await Promise.all([r.service.share('take', true), r.service.share('take', true)]);
    expect(r.provider.reserve).toHaveBeenCalledTimes(1);
    expect(r.provider.upload).toHaveBeenCalledTimes(2);
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
  it('uploads only projected snapshot sidecars and retains URL on enrichment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rushes-enrich-'));
    const r = rig(root);
    const original = r.engine.request.getMockImplementation()!;
    vi.mocked(r.engine.request).mockImplementation(async (cmd: string) => {
      const value = await original(cmd);
      if (cmd === 'share.assets')
        return {
          ...value,
          captionsPath: join(root, 'renders', 'shared_assets', 'fixture-key', 'projected.vtt'),
          transcriptPath: join(root, 'renders', 'shared_assets', 'fixture-key', 'projected.json'),
        };
      return value;
    });
    await r.service.share('take', true);
    expect(vi.mocked(r.provider.upload).mock.calls.map((c) => c[1].kind)).toEqual([
      'video',
      'poster',
      'captions',
      'transcript',
    ]);
    expect(
      vi.mocked(r.provider.upload).mock.calls.every((c) => c[1].path.includes('shared_assets')),
    ).toBe(true);
    const state = JSON.parse(await readFile(join(root, 'share', 'state.json'), 'utf8'));
    expect(state.reservation.url).toBe('https://example.invalid/stable-share-id');
    expect(state.reservation.manifest.transcript).toBe('transcript-hash.mp4');
    expect(r.provider.updateMetadata).not.toHaveBeenCalled();
    expect(r.provider.publish).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'stable-share-id' }),
      expect.objectContaining({
        title: 'Edited fixture',
        summary: 'Fixture summary',
        chapters: [{ startMs: 0, title: 'Edited chapter' }],
        captions: [{ file: 'captions-hash.mp4', lang: 'en' }],
        transcript: 'transcript-hash.mp4',
      }),
    );
    await rm(root, { recursive: true });
  });
  it('returns a persisted real reservation before render and waits only when requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rushes-reserve-'));
    const r = rig(root);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const implementation = r.engine.request.getMockImplementation()!;
    r.engine.request.mockImplementation(async (cmd: string) => {
      if (cmd === 'share.assets') await gate;
      return implementation(cmd);
    });
    const immediate = await r.service.share('take');
    expect(immediate).toEqual({
      url: 'https://example.invalid/stable-share-id',
      state: 'processing',
    });
    expect(r.provider.upload).not.toHaveBeenCalled();
    const state = JSON.parse(await readFile(join(root, 'share', 'state.json'), 'utf8'));
    expect(state.state).toBe('processing');
    await expect(r.service.enrich('take')).rejects.toMatchObject({ code: 'share-processing' });
    const waiting = r.service.share('take', true);
    release();
    expect(await waiting).toEqual({ url: immediate.url, state: 'ready' });
    await rm(root, { recursive: true });
  });
  it('late enrichment reuses the successfully published video and frozen edit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rushes-frozen-'));
    const r = rig(root);
    await r.service.share('take', true);
    const state = JSON.parse(await readFile(join(root, 'share', 'state.json'), 'utf8'));
    expect(await r.service.enrich('take')).toMatchObject({ updated: true });
    expect(r.engine.request).toHaveBeenLastCalledWith(
      'share.assets',
      {
        id: 'take',
        editSnapshot: state.publishedEdit,
        publishedVideoPath: state.publishedVideoPath,
      },
      1800000,
    );
    const saved = JSON.parse(await readFile(join(root, 'share', 'state.json'), 'utf8'));
    delete saved.publishedEdit;
    await writeFile(join(root, 'share', 'state.json'), JSON.stringify(saved));
    await expect(r.service.enrich('take')).rejects.toMatchObject({ code: 're-share-required' });
    await rm(root, { recursive: true });
  });
});
