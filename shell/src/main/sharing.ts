import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON } from './atomic';
import {
  sharePolicySchema,
  sharePolicyPatchSchema,
  shareFeedbackSchema,
  type SharePolicy,
  type SharePolicyPatch,
  type ShareFeedback,
  type ShareStatus,
} from '../shared/contracts';
type Reservation = { id: string; url: string; manifest: Record<string, any> };
type Asset = { file: string; bytes: number; sha256: string; kind: string };
export interface ShareProvider {
  readonly supportsAncillaryAssets?: boolean;
  reserve(input: {
    id?: string;
    title: string;
    clientId?: string;
    mode?: 'screen' | 'camera' | 'screen-camera';
    durationMs?: number;
    password?: string;
    expiresAt?: string;
  }): Promise<Reservation>;
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
  getPolicy?(id: string): Promise<SharePolicy>;
  updatePolicy?(id: string, input: SharePolicyPatch): Promise<SharePolicy>;
  feedback?(id: string): Promise<ShareFeedback>;
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
  editSnapshot: Record<string, unknown>;
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
  publishedEdit?: Record<string, unknown>;
  publishedVideoPath?: string;
  lastError?: { code?: string; message: string };
};
type Job = {
  kind: 'share' | 'enrich';
  promise: Promise<{ url: string; state: 'ready' }>;
  abort: AbortController;
};
export class SharingService {
  private running = new Map<string, Job>();
  private reserving = new Map<
    string,
    Promise<{ show: any; state: State; path: string; provider: ShareProvider; version: unknown }>
  >();
  constructor(
    private engine: {
      request(cmd: string, args?: Record<string, unknown>, timeout?: number): Promise<any>;
    },
    private provider: () => Promise<ShareProvider>,
    private providerIdentity: () => string,
    private notify: (event: Record<string, unknown>) => void,
    private configurationVersion: () => unknown = providerIdentity,
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
  async status(id: string): Promise<ShareStatus> {
    const show = await this.engine.request('show', { id });
    const state = await this.read(join(show.packagePath, 'share', 'state.json'));
    if (!state) return { id, state: 'not-shared' };
    return {
      id,
      state: state.state,
      providerMatches: state.provider === this.providerIdentity(),
      ...(state.state === 'unshared' ? {} : { url: state.reservation.url }),
    };
  }
  private async activeShare(id: string) {
    const identity = this.providerIdentity();
    const version = this.configurationVersion();
    const show = await this.engine.request('show', { id });
    const state = await this.read(join(show.packagePath, 'share', 'state.json'));
    if (!state || state.state === 'unshared')
      throw Object.assign(new Error('This recording has no active share.'), {
        code: 'share-not-shared',
      });
    this.checkProvider(state, identity);
    const provider = await this.provider();
    this.checkProvider(state);
    this.checkConfiguration(version);
    return { state, provider, version };
  }
  private checkConfiguration(version: unknown) {
    if (version !== this.configurationVersion())
      throw Object.assign(new Error('Sharing settings changed. Retry with the current provider.'), {
        code: 'share-provider-mismatch',
      });
  }
  private unsupported() {
    return Object.assign(
      new Error('This sharing provider does not support link access or feedback.'),
      { code: 'share-feature-unsupported' },
    );
  }
  private capabilityError(error: unknown, feature: 'policy' | 'feedback') {
    if (['SHARE_FEATURE_UNSUPPORTED', 'share-feature-unsupported'].includes((error as any)?.code))
      return this.unsupported();
    // Owner APIs may echo request diagnostics. Never expose a password or bearer token.
    return Object.assign(
      new Error(
        `Could not ${feature === 'policy' ? 'read or update link access' : 'load viewer feedback'}. Try again.`,
      ),
      { code: `share-${feature}-failed` },
    );
  }
  async getPolicy(id: string): Promise<SharePolicy> {
    const { state, provider, version } = await this.activeShare(id);
    if (!provider.getPolicy) throw this.unsupported();
    let result;
    try {
      result = sharePolicySchema.parse(await provider.getPolicy(state.reservation.id));
    } catch (error) {
      throw this.capabilityError(error, 'policy');
    }
    this.checkProvider(state);
    this.checkConfiguration(version);
    return result;
  }
  async updatePolicy(id: string, input: SharePolicyPatch): Promise<SharePolicy> {
    const patch = sharePolicyPatchSchema.parse(input);
    const { state, provider, version } = await this.activeShare(id);
    if (!provider.updatePolicy) throw this.unsupported();
    let result;
    try {
      result = sharePolicySchema.parse(await provider.updatePolicy(state.reservation.id, patch));
    } catch (error) {
      throw this.capabilityError(error, 'policy');
    }
    this.checkProvider(state);
    this.checkConfiguration(version);
    // Policy lives at the provider. Keep the reservation, published edit and captions untouched.
    return result;
  }
  async feedback(id: string): Promise<ShareFeedback> {
    const { state, provider, version } = await this.activeShare(id);
    if (!provider.feedback) throw this.unsupported();
    let result;
    try {
      result = shareFeedbackSchema.parse(await provider.feedback(state.reservation.id));
    } catch (error) {
      throw this.capabilityError(error, 'feedback');
    }
    this.checkProvider(state);
    this.checkConfiguration(version);
    return result;
  }
  async feedbackSnapshots() {
    const identity = this.providerIdentity();
    const version = this.configurationVersion();
    const list = await this.engine.request('list', { limit: 1000 });
    const snapshots: Array<{ key: string; id: string; title: string; feedback: ShareFeedback }> =
      [];
    for (const row of list.recordings ?? []) {
      try {
        const state = await this.read(join(row.folder, 'share', 'state.json'));
        if (!state || state.state === 'unshared' || state.provider !== identity) continue;
        const feedback = await this.feedback(row.id);
        if (identity !== this.providerIdentity() || version !== this.configurationVersion())
          return [];
        snapshots.push({
          key: `${identity}:${String(version)}:${state.reservation.id}`,
          id: row.id,
          title: row.title ?? 'Your recording',
          feedback,
        });
      } catch (error) {
        if ((error as any).code !== 'share-feature-unsupported')
          this.notify({
            event: 'warning',
            code: 'share-feedback-poll-failed',
            id: row.id,
            message: 'Viewer feedback could not be refreshed. The last view count is kept.',
          });
      }
    }
    return identity === this.providerIdentity() && version === this.configurationVersion()
      ? snapshots
      : [];
  }
  private async prepare(id: string, policy?: SharePolicyPatch) {
    const current = this.reserving.get(id);
    if (current) return current;
    const operation = (async () => {
      const show = await this.engine.request('show', { id }),
        path = join(show.packagePath, 'share', 'state.json');
      const identity = this.providerIdentity(),
        version = this.configurationVersion(),
        provider = await this.provider();
      const existing = await this.read(path);
      if (existing && existing.state !== 'unshared') this.checkProvider(existing, identity);
      if (
        policy &&
        (!(identity.startsWith('worker:') || identity.startsWith('hosted:')) || !provider.getPolicy || !provider.updatePolicy)
      )
        throw this.unsupported();
      if (policy && existing && existing.state !== 'unshared') {
        try {
          await provider.updatePolicy!(existing.reservation.id, policy);
        } catch (error) {
          throw this.capabilityError(error, 'policy');
        }
      }
      this.notify({ event: 'share-progress', id, state: 'reserving' });
      const reserve = async () => {
        try {
          let durationMs = Math.round((show.manifest.clock?.durationNs ?? 0) / 1e6);
          if (identity.startsWith('hosted:')) {
            const edit = await this.engine.request('edit.get', {id});
            if (!Array.isArray(edit?.clips) || !edit.clips.length || edit.clips.some((clip: any) => !Number.isFinite(clip.sourceStartMs) || !Number.isFinite(clip.sourceEndMs) || clip.sourceEndMs <= clip.sourceStartMs || !Number.isFinite(clip.speed) || clip.speed < 1 || clip.speed > 8)) throw new Error('The edited video duration could not be verified. Open the video and retry sharing.');
            durationMs = Math.round(edit.clips.reduce((total: number, clip: any) => total + (clip.sourceEndMs - clip.sourceStartMs) / clip.speed, 0));
            this.checkConfiguration(version);
          }
          return await provider.reserve({
            title: show.manifest.title ?? 'Untitled recording',
            ...(identity.startsWith('hosted:') ? {clientId: id, mode: (show.manifest.tracks ?? []).some((track: any) => track.present && track.role === 'camera') ? (show.manifest.tracks ?? []).some((track: any) => track.present && track.role === 'screen') ? 'screen-camera' : 'camera' : 'screen'} : {}),
            durationMs,
            ...(policy?.password ? { password: policy.password } : {}),
            ...(policy?.expiresAt ? { expiresAt: policy.expiresAt } : {}),
          });
        } catch (error) {
          if (policy) throw this.capabilityError(error, 'policy');
          throw error;
        }
      };
      const reservation =
        existing && existing.state !== 'unshared' ? existing.reservation : await reserve();
      this.checkConfiguration(version);
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
      try {this.checkConfiguration(version); this.checkProvider(state);}
      catch (error) {await atomicJSON(path, {...state, state: 'failed', lastError: {code: 'share-provider-mismatch', message: 'Sharing settings changed. Retry with the current account.'}}); throw error;}
      return { show, path, state, provider, version };
    })().finally(() => this.reserving.delete(id));
    this.reserving.set(id, operation);
    return operation;
  }
  cancelForConfigurationChange() {
    for (const job of this.running.values()) job.abort.abort(new Error('Sharing settings changed. Retry with the current account.'));
  }
  async share(
    id: string,
    wait = false,
    input?: SharePolicyPatch,
  ): Promise<{ url: string; state: 'processing' | 'ready' }> {
    const policy = input ? sharePolicyPatchSchema.parse(input) : undefined;
    // A supplied policy is never ignored by a deduplicated/background share.
    if (policy && (this.running.has(id) || this.reserving.has(id))) {
      await this.reserving.get(id);
      await this.updatePolicy(id, policy);
    }
    const existing = this.running.get(id);
    if (existing) {
      if (existing.kind === 'enrich') {
        await existing.promise;
        return this.share(id, wait);
      }
      if (wait) return existing.promise;
      const show = await this.engine.request('show', { id });
      const state = await this.read(join(show.packagePath, 'share', 'state.json'));
      if (!state) throw new Error('Share reservation is unavailable');
      this.checkProvider(state);
      return { url: state.reservation.url, state: 'processing' };
    }
    const prepared = await this.prepare(id, policy);
    let job = this.running.get(id);
    if (!job) {
      const abort = new AbortController();
      const promise = this.publishSnapshot(
        id,
        prepared.state,
        prepared.path,
        prepared.provider,
        abort.signal,
        undefined,
        prepared.version,
      ).finally(() => this.running.delete(id));
      job = { kind: 'share', promise, abort };
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
    frozen?: { editSnapshot: Record<string, unknown>; publishedVideoPath: string },
    version = this.configurationVersion(),
  ): Promise<{ url: string; state: 'ready' }> {
    const current = () => {signal.throwIfAborted(); this.checkProvider(state); this.checkConfiguration(version);};
    try {
      current();
      this.notify({ event: 'share-progress', id, state: 'rendering', url: state.reservation.url });
      const snapshot: Snapshot = await this.engine.request(
        'share.assets',
        { id, ...frozen },
        30 * 60 * 1000,
      );
      current();
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
      if (provider.supportsAncillaryAssets !== false) assets.poster = await provider.upload(reservation, {
        path: snapshot.posterPath,
        kind: 'poster',
        signal,
      });
      if (snapshot.captionsPath && provider.supportsAncillaryAssets !== false)
        assets.captions = await provider.upload(reservation, {
          path: snapshot.captionsPath,
          kind: 'captions',
          signal,
        });
      if (snapshot.transcriptPath && provider.supportsAncillaryAssets !== false)
        assets.transcript = await provider.upload(reservation, {
          path: snapshot.transcriptPath,
          kind: 'transcript',
          signal,
        });
      current();
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
      current();
      await atomicJSON(path, {
        ...state,
        reservation: published,
        state: 'ready',
        assets,
        generation: snapshot.cacheKey,
        editRevision: snapshot.editRevision,
        publishedEdit: snapshot.editSnapshot,
        publishedVideoPath: snapshot.videoPath,
        lastError: undefined,
        updatedAt: new Date().toISOString(),
      });
      current();
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
    if (this.running.has(id) || this.reserving.has(id))
      throw Object.assign(
        new Error('Sharing is still processing. Enrichment will retry after publication.'),
        { code: 'share-processing', retryable: true },
      );
    const abort = new AbortController();
    const promise = (async (): Promise<{ url: string; state: 'ready' }> => {
      const show = await this.engine.request('show', { id }),
        path = join(show.packagePath, 'share', 'state.json'),
        state = await this.read(path);
      if (!state || state.state === 'unshared')
        throw Object.assign(new Error('This recording has no active share.'), {
          code: 'share-not-shared',
        });
      if (state.state === 'processing')
        throw Object.assign(new Error('Sharing is still processing.'), {
          code: 'share-processing',
          retryable: true,
        });
      this.checkProvider(state);
      if (!state.publishedEdit || !state.publishedVideoPath)
        throw Object.assign(
          new Error(
            'Share this recording again to save its published edit snapshot before enriching it.',
          ),
          { code: 're-share-required' },
        );
      return this.publishSnapshot(id, state, path, await this.provider(), abort.signal, {
        editSnapshot: state.publishedEdit,
        publishedVideoPath: state.publishedVideoPath,
      });
    })().finally(() => this.running.delete(id));
    this.running.set(id, { kind: 'enrich', promise, abort });
    try {
      const result = await promise;
      return { updated: true, url: result.url };
    } catch (error) {
      if ((error as any).code === 'share-not-shared')
        return { updated: false, reason: 'not-shared' };
      throw error;
    }
  }
  async unshare(id: string) {
    await this.reserving.get(id);
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
