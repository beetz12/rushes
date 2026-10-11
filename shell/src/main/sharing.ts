import { readFile, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON } from './atomic';
type Reservation = { id: string; url: string; manifest: Record<string, any> };
type Asset = { file: string; bytes: number; sha256: string; kind: string };
export interface ShareProvider {
  reserve(input: { id?: string; title: string; durationMs?: number }): Promise<Reservation>;
  upload(
    reservation: Reservation,
    input: {
      path: string;
      kind: 'video' | 'captions' | 'transcript';
      onProgress?: (value: any) => void;
    },
  ): Promise<Asset>;
  publish(
    reservation: Reservation,
    input: { video: Asset; width: number; height: number; durationMs: number; title?: string },
  ): Promise<Reservation>;
  updateMetadata(reservation: Reservation, metadata: Record<string, unknown>): Promise<Reservation>;
  delete(reservation: Reservation): Promise<void>;
  setupCheck(): Promise<unknown>;
}
type State = {
  schema: 'rushes.shell-share/1';
  provider: string;
  reservation: Reservation;
  state: 'processing' | 'ready' | 'unshared';
  updatedAt: string;
  assets?: Record<string, Asset>;
};
export class SharingService {
  private running = new Map<string, Promise<{ url: string }>>();
  constructor(
    private engine: {
      request(cmd: string, args?: Record<string, unknown>, timeout?: number): Promise<any>;
    },
    private provider: () => Promise<ShareProvider>,
    private providerIdentity: () => string,
    private notify: (event: Record<string, unknown>) => void,
  ) {}
  private async read(path: string): Promise<State | undefined> {
    try {
      const v = JSON.parse(await readFile(path, 'utf8'));
      if (v.schema !== 'rushes.shell-share/1' || !v.reservation?.id || !v.reservation?.url)
        throw new Error('Malformed share state');
      return v;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
  }
  private checkProvider(state: State) {
    if (state.provider !== this.providerIdentity())
      throw Object.assign(
        new Error(
          'This video was shared with another provider. Restore that provider before changing or deleting its share.',
        ),
        { code: 'share-provider-mismatch' },
      );
  }
  share(id: string) {
    const current = this.running.get(id);
    if (current) return current;
    const operation = this.doShare(id).finally(() => this.running.delete(id));
    this.running.set(id, operation);
    return operation;
  }
  private async doShare(id: string) {
    const show = await this.engine.request('show', { id });
    const provider = await this.provider();
    const statePath = join(show.packagePath, 'share', 'state.json');
    const existing = await this.read(statePath);
    if (existing && existing.state !== 'unshared') this.checkProvider(existing);
    this.notify({ event: 'share-progress', id, state: 'rendering' });
    const output = join(show.packagePath, 'renders', 'share.mp4');
    await mkdir(join(show.packagePath, 'renders'), { recursive: true });
    const rendered = await this.engine.request(
      'export',
      { id, preset: 'share', path: output },
      30 * 60 * 1000,
    );
    const title = show.manifest.title ?? 'Untitled recording';
    const reservation =
      existing && existing.state !== 'unshared'
        ? existing.reservation
        : await provider.reserve({ title, durationMs: rendered.durationMs });
    let state: State = {
      schema: 'rushes.shell-share/1',
      provider: this.providerIdentity(),
      reservation,
      state: existing?.state === 'ready' ? 'ready' : 'processing',
      updatedAt: new Date().toISOString(),
      assets: existing?.assets,
    };
    await atomicJSON(statePath, state);
    this.notify({ event: 'share-progress', id, state: 'uploading' });
    const video = await provider.upload(reservation, {
      path: output,
      kind: 'video',
      onProgress: (value) => this.notify({ event: 'share-progress', id, ...value }),
    });
    const published = await provider.publish(reservation, {
      video,
      width: rendered.width,
      height: rendered.height,
      durationMs: rendered.durationMs,
      title,
    });
    state = {
      ...state,
      reservation: published,
      state: 'ready',
      assets: { ...state.assets, video },
      updatedAt: new Date().toISOString(),
    };
    await atomicJSON(statePath, state);
    await this.enrichState(id, show.packagePath, provider, state, statePath).catch((error) =>
      this.notify({
        event: 'warning',
        code: 'share-enrichment-pending',
        message: `Video is shared. Extra metadata will need retry: ${String(error)}`,
      }),
    );
    this.notify({ event: 'share-progress', id, state: 'complete', url: published.url });
    return { url: published.url };
  }
  private async enrichState(
    id: string,
    packagePath: string,
    provider: ShareProvider,
    state: State,
    statePath: string,
  ) {
    let metadata: Record<string, unknown> = {};
    try {
      const m = await this.engine.request('meta.get', { id });
      metadata = { title: m.title, summary: m.summary, chapters: m.chapters };
    } catch {}
    let reservation = state.reservation;
    const assets = { ...state.assets };
    for (const [kind, filename] of [
      ['captions', 'captions.vtt'],
      ['transcript', 'transcript.json'],
    ] as const) {
      const path = join(packagePath, filename);
      try {
        await access(path);
      } catch {
        continue;
      }
      const asset = await provider.upload(reservation, { path, kind });
      assets[kind] = asset;
      if (kind === 'captions') metadata.captions = [{ file: asset.file, lang: 'en' }];
      else metadata.transcript = asset.file;
    }
    if (!Object.keys(metadata).length) return;
    reservation = await provider.updateMetadata(reservation, metadata);
    await atomicJSON(statePath, {
      ...state,
      reservation,
      assets,
      updatedAt: new Date().toISOString(),
    });
  }
  async enrich(id: string) {
    const show = await this.engine.request('show', { id }),
      statePath = join(show.packagePath, 'share', 'state.json');
    const state = await this.read(statePath);
    if (!state || state.state !== 'ready') return { updated: false };
    this.checkProvider(state);
    await this.enrichState(id, show.packagePath, await this.provider(), state, statePath);
    return { updated: true, url: state.reservation.url };
  }
  async unshare(id: string) {
    const show = await this.engine.request('show', { id }),
      statePath = join(show.packagePath, 'share', 'state.json');
    const state = await this.read(statePath);
    if (!state || state.state === 'unshared') return { id, unshared: true };
    this.checkProvider(state);
    await (await this.provider()).delete(state.reservation);
    await atomicJSON(statePath, {
      ...state,
      state: 'unshared',
      updatedAt: new Date().toISOString(),
    });
    return { id, unshared: true };
  }
}
