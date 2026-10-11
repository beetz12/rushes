import { readFile } from 'node:fs/promises';
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
      kind: 'video' | 'poster' | 'captions' | 'transcript';
      signal?: AbortSignal;
      onProgress?: (value: any) => void;
    },
  ): Promise<Asset>;
  publish(
    reservation: Reservation,
    input: {
      video: Asset;
      poster?: Asset;
      width: number;
      height: number;
      durationMs: number;
      title?: string;
      summary?: string | null;
      chapters?: Array<{ startMs: number; title: string }>;
      captions?: Array<{ file: string; lang: string }>;
      transcript?: string | null;
    },
  ): Promise<Reservation>;
  updateMetadata(reservation: Reservation, metadata: Record<string, unknown>): Promise<Reservation>;
  delete(reservation: Reservation): Promise<void>;
  setupCheck(): Promise<unknown>;
}
type Snapshot = {
  id: string;
  videoPath: string;
  posterPath: string;
  captionsPath?: string;
  transcriptPath?: string;
  durationMs: number;
  width: number;
  height: number;
  title: string;
  summary?: string;
  chapters: Array<{ startMs: number; title: string }>;
  cacheKey: string;
  cached: boolean;
  editRevision: number;
};
type State = {
  schema: 'rushes.shell-share/1';
  recordingId?: string;
  provider: string;
  reservation: Reservation;
  state: 'processing' | 'ready' | 'failed' | 'unshared';
  updatedAt: string;
  assets?: Record<string, Asset>;
  generation?: string;
  editRevision?: number;
  lastError?: { code?: string; message: string };
};
type Job = { promise: Promise<{ url: string; state: 'ready' }>; abort: AbortController };
export class SharingService {
  private running = new Map<string, Job>();
  private reserving = new Map<
    string,
    Promise<{ show: any; state: State; path: string; provider: ShareProvider }>
  >();
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
  private checkProvider(state: State, identity = this.providerIdentity()) {
    if (state.provider !== identity)
      throw Object.assign(
        new Error(
          'This video was shared with another provider. Restore that provider before changing or deleting its share.',
        ),
        { code: 'share-provider-mismatch' },
      );
  }
  private async prepare(id: string) {
    const current = this.reserving.get(id);
    if (current) return current;
    const operation = (async () => {
      const show = await this.engine.request('show', { id }),
        path = join(show.packagePath, 'share', 'state.json');
      const identity = this.providerIdentity(),
        provider = await this.provider();
      const existing = await this.read(path);
      if (existing && existing.state !== 'unshared') this.checkProvider(existing, identity);
      this.notify({ event: 'share-progress', id, state: 'reserving' });
      const reservation =
        existing && existing.state !== 'unshared'
          ? existing.reservation
          : await provider.reserve({
              title: show.manifest.title ?? 'Untitled recording',
              durationMs: Math.round((show.manifest.clock?.durationNs ?? 0) / 1e6),
            });
      const state: State = {
        ...existing,
        schema: 'rushes.shell-share/1',
        recordingId: id,
        provider: identity,
        reservation,
        state: 'processing',
        lastError: undefined,
        updatedAt: new Date().toISOString(),
      };
      await atomicJSON(path, state);
      return { show, path, state, provider };
    })().finally(() => this.reserving.delete(id));
    this.reserving.set(id, operation);
    return operation;
  }
  async share(id: string, wait = false): Promise<{ url: string; state: 'processing' | 'ready' }> {
    const existing = this.running.get(id);
    if (existing) {
      if (wait) return existing.promise;
      const show = await this.engine.request('show', { id });
      const state = await this.read(join(show.packagePath, 'share', 'state.json'));
      if (!state) throw new Error('Share reservation is unavailable');
      return { url: state.reservation.url, state: 'processing' };
    }
    const prepared = await this.prepare(id);
    let job = this.running.get(id);
    if (!job) {
      const abort = new AbortController();
      const promise = this.publishSnapshot(
        id,
        prepared.state,
        prepared.path,
        prepared.provider,
        abort.signal,
      ).finally(() => this.running.delete(id));
      job = { promise, abort };
      this.running.set(id, job);
      void promise.catch(() => {});
    }
    if (wait) return job.promise;
    return { url: prepared.state.reservation.url, state: 'processing' };
  }
  private async publishSnapshot(
    id: string,
    state: State,
    path: string,
    provider: ShareProvider,
    signal: AbortSignal,
  ): Promise<{ url: string; state: 'ready' }> {
    try {
      this.notify({ event: 'share-progress', id, state: 'rendering', url: state.reservation.url });
      const snapshot: Snapshot = await this.engine.request('share.assets', { id }, 30 * 60 * 1000);
      signal.throwIfAborted();
      this.notify({ event: 'share-progress', id, state: 'uploading', url: state.reservation.url });
      const assets: Record<string, Asset> = {};
      const reservation = state.reservation;
      assets.video = await provider.upload(reservation, {
        path: snapshot.videoPath,
        kind: 'video',
        signal,
        onProgress: (value) =>
          this.notify({ event: 'share-progress', id, state: 'uploading', ...value }),
      });
      assets.poster = await provider.upload(reservation, {
        path: snapshot.posterPath,
        kind: 'poster',
        signal,
      });
      if (snapshot.captionsPath)
        assets.captions = await provider.upload(reservation, {
          path: snapshot.captionsPath,
          kind: 'captions',
          signal,
        });
      if (snapshot.transcriptPath)
        assets.transcript = await provider.upload(reservation, {
          path: snapshot.transcriptPath,
          kind: 'transcript',
          signal,
        });
      signal.throwIfAborted();
      const metadata = {
        title: snapshot.title,
        summary: snapshot.summary ?? null,
        chapters: snapshot.chapters.map((chapter) => ({
          startMs: Math.round(chapter.startMs),
          title: chapter.title,
        })),
        captions: assets.captions ? [{ file: assets.captions.file, lang: 'en' }] : [],
        transcript: assets.transcript?.file ?? null,
      };
      const published = await provider.publish(reservation, {
        video: assets.video,
        poster: assets.poster,
        width: snapshot.width,
        height: snapshot.height,
        durationMs: Math.round(snapshot.durationMs),
        ...metadata,
      });
      await atomicJSON(path, {
        ...state,
        reservation: published,
        state: 'ready',
        assets,
        generation: snapshot.cacheKey,
        editRevision: snapshot.editRevision,
        lastError: undefined,
        updatedAt: new Date().toISOString(),
      });
      this.notify({ event: 'share-progress', id, state: 'ready', url: published.url });
      return { url: published.url, state: 'ready' };
    } catch (error) {
      await atomicJSON(path, {
        ...state,
        state: 'failed',
        lastError: {
          code: (error as any).code,
          message: (error as Error).message ?? String(error),
        },
        updatedAt: new Date().toISOString(),
      }).catch(() => {});
      this.notify({
        event: 'share-progress',
        id,
        state: 'failed',
        message: String(error),
        url: state.reservation.url,
      });
      throw error;
    }
  }
  async enrich(id: string) {
    const running = this.running.get(id);
    if (running) await running.promise;
    const show = await this.engine.request('show', { id }),
      path = join(show.packagePath, 'share', 'state.json'),
      state = await this.read(path);
    if (!state || state.state !== 'ready') return { updated: false };
    this.checkProvider(state);
    const result = await this.share(id, true);
    return { updated: true, url: result.url };
  }
  async unshare(id: string) {
    const running = this.running.get(id);
    if (running) {
      running.abort.abort();
      await running.promise.catch(() => {});
    }
    const show = await this.engine.request('show', { id }),
      path = join(show.packagePath, 'share', 'state.json'),
      state = await this.read(path);
    if (!state || state.state === 'unshared') return { id, unshared: true };
    this.checkProvider(state);
    await (await this.provider()).delete(state.reservation);
    await atomicJSON(path, { ...state, state: 'unshared', updatedAt: new Date().toISOString() });
    return { id, unshared: true };
  }
  async resumePending() {
    const result = await this.engine.request('list', { limit: 1000 });
    for (const row of result.recordings ?? []) {
      const path = join(row.folder, 'share', 'state.json');
      const state = await this.read(path).catch(() => undefined);
      if (state?.state === 'processing' && state.provider === this.providerIdentity())
        void this.share(row.id).catch((error) =>
          this.notify({ event: 'warning', code: 'share-resume-failed', message: String(error) }),
        );
    }
  }
}
