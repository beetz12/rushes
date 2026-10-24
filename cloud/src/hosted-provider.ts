import { createHash, randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { describeAsset, readChunk, PART_BYTES } from './assets.js';
import { MemoryJobStore, type JobStore } from './store.js';
import { ShareError, assertShareId, requireHTTPS, metadataPatch, publicManifest, type Fetch, type ShareProvider, type ShareReservation, type ReserveInput, type UploadInput, type UploadedAsset, type PublishInput, type MetadataPatch, type SharePolicy, type SharePolicyPatch } from './types.js';

export interface HostedConfig { serviceURL: string; credential: string }
interface NativeDetail extends ShareReservation { state: string; video?: UploadedAsset }
interface PartReceipt { partNumber: number; bytes: number; sha256: string }
const ASSET_LIMIT = 2 * 1024 ** 3;
const UPLOAD_MILLIS = 30 * 60 * 1000;
const REQUEST_MILLIS = 30000;
// The maximum declared chapter/summary metadata fits inside this response budget.
const JSON_BYTES = 1024 * 1024;
async function responseJSON(response: Response): Promise<unknown> {
    if (!response.body) throw new ShareError('INVALID_RESPONSE', 'Hosted response is empty.');
    const reader = response.body.getReader();
    try {
        const declared = response.headers.get('Content-Length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > JSON_BYTES))
            throw new ShareError('INVALID_RESPONSE', 'Hosted response exceeds the JSON byte limit.');
        const blocks: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > JSON_BYTES) throw new ShareError('INVALID_RESPONSE', 'Hosted response exceeds the JSON byte limit.');
            blocks.push(value);
        }
        try { return JSON.parse(Buffer.concat(blocks, bytes).toString('utf8')) as unknown; }
        catch { throw new ShareError('INVALID_RESPONSE', 'Hosted response is not valid JSON.'); }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

/** Main-process SDK for a linked account. Credentials never enter the upload store. */
export class HostedProvider implements ShareProvider {
    readonly supportsAncillaryAssets = false;
    readonly store: JobStore;
    private readonly base: URL;
    readonly #credential: string;
    private readonly fetcher: Fetch;
    constructor(config: HostedConfig, options: { store?: JobStore; fetch?: Fetch; allowLocalHTTP?: boolean } = {}) {
        try { this.base = requireHTTPS(config.serviceURL, options.allowLocalHTTP); }
        catch { throw new ShareError('INVALID_CONFIG', 'Hosted sharing requires a valid HTTPS service origin.'); }
        if (this.base.pathname !== '/' || typeof config.credential !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(config.credential))
            throw new ShareError('INVALID_CONFIG', 'Hosted sharing requires a service origin and a native device credential.');
        this.#credential = config.credential;
        this.store = options.store ?? new MemoryJobStore();
        this.fetcher = options.fetch ?? fetch;
    }
    private url(path: string): string { return new URL(path, this.base).toString(); }
    private cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new ShareError('CANCELLED', 'Hosted upload cancelled or its deadline elapsed.'); }
    private async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, binary = false): Promise<T> {
        this.cancelled(signal);
        const timeout = AbortSignal.timeout(REQUEST_MILLIS);
        const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try {
            const response = await this.fetcher(this.url(path), { method, headers: {
                Authorization: `Native ${this.#credential}`,
                ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }),
                ...(binary ? { 'X-Part-SHA256': createHash('sha256').update(body as Buffer).digest('hex') } : {}),
            }, body: body === undefined ? undefined : binary ? body as BodyInit : JSON.stringify(body), redirect: 'error', signal: bounded });
            this.cancelled(signal);
            if (!response.ok) throw new ShareError('HOSTED_HTTP', `Hosted request failed with HTTP ${response.status}.`, response.status);
            const value = await responseJSON(response);
            this.cancelled(signal);
            return value as T;
        } catch (error) {
            this.cancelled(signal);
            if (timeout.aborted) throw new ShareError('REQUEST_TIMEOUT', 'Hosted request exceeded its deadline.');
            if (error instanceof ShareError) throw error;
            throw new ShareError('NETWORK_ERROR', 'Hosted request failed.');
        }
    }
    private asset(value: UploadedAsset): UploadedAsset {
        if (value?.kind !== 'video' || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > ASSET_LIMIT ||
            !/^[a-f0-9]{64}$/.test(value.sha256) || value.file !== `video-${value.sha256.slice(0, 8)}.mp4`)
            throw new ShareError('INVALID_RESPONSE', 'Hosted video identity is invalid.');
        return { kind: 'video', file: value.file, bytes: value.bytes, sha256: value.sha256 };
    }
    private detail(value: NativeDetail, expectedId?: string): NativeDetail {
        if (!value || typeof value !== 'object') throw new ShareError('INVALID_RESPONSE', 'Hosted recording detail is invalid.');
        const id = assertShareId(value.id);
        if (expectedId !== undefined && id !== expectedId) throw new ShareError('INVALID_RESPONSE', 'Hosted recording identity changed.');
        let manifest;
        try { manifest = publicManifest(value.manifest); }
        catch { throw new ShareError('INVALID_RESPONSE', 'Hosted public manifest is invalid.'); }
        if (value.url !== this.url(`/s/${manifest.id}`) || typeof value.state !== 'string' ||
            (manifest.status === 'ready' && (value.state !== 'ready' || manifest.durationMs <= 0 || manifest.durationMs > 600000)))
            throw new ShareError('INVALID_RESPONSE', 'Hosted recording returned an unexpected share or state.');
        const video = value.video === undefined ? undefined : this.asset(value.video);
        if (manifest.status === 'ready' && (!video || !manifest.video || manifest.video.file !== video.file || manifest.video.bytes !== video.bytes ||
            Math.max(manifest.video.width, manifest.video.height) > 1920))
            throw new ShareError('INVALID_RESPONSE', 'Hosted ready media has no matching verified video.');
        return { id, url: value.url, state: value.state, manifest, ...(video ? { video } : {}) };
    }
    private async save(detail: NativeDetail): Promise<ShareReservation> {
        const reservation = { id: detail.id, url: detail.url, manifest: detail.manifest };
        const prior = await this.store.read(reservation.id);
        if (prior && prior.reservation.url !== reservation.url) throw new ShareError('INVALID_RESPONSE', 'Hosted share identity changed.');
        await this.store.write(reservation.id, { reservation, uploads: prior?.uploads ?? {} });
        return reservation;
    }
    private path(id: string): string { return `/api/native/recordings/${assertShareId(id)}`; }
    async reserve(input: ReserveInput): Promise<ShareReservation> {
        const title = metadataPatch({ title: input.title }).title!;
        if (title.length > 160 || (input.durationMs !== undefined && (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > 600000)))
            throw new ShareError('INVALID_METADATA', 'Hosted title or duration is outside the supported limit.');
        const mode = input.mode ?? 'screen-camera';
        if (!['screen', 'camera', 'screen-camera'].includes(mode)) throw new ShareError('INVALID_METADATA', 'Hosted recording mode is invalid.');
        // Without a supplied identity, callers must retain the returned reservation for restart.
        const clientId = input.clientId ?? input.id ?? randomBytes(16).toString('base64url');
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(clientId)) throw new ShareError('INVALID_METADATA', 'Hosted client identity is invalid.');
        const detail = this.detail(await this.request<NativeDetail>('/api/native/recordings', 'POST', {
            clientId,
            title, mode, durationMs: input.durationMs ?? 0,
            ...(input.password === undefined ? {} : { password: input.password }),
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        }));
        if (detail.state !== 'processing' || detail.manifest.status !== 'processing') throw new ShareError('INVALID_RESPONSE', 'Hosted reservation is not processing.');
        return this.save(detail);
    }
    async get(id: string): Promise<ShareReservation> { return this.save(this.detail(await this.request<NativeDetail>(this.path(id)), id)); }
    async upload(share: ShareReservation, input: UploadInput): Promise<UploadedAsset> {
        if (input.kind !== 'video') throw new ShareError('SHARE_FEATURE_UNSUPPORTED', 'Hosted sharing currently accepts the video only.');
        const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(UPLOAD_MILLIS)]) : AbortSignal.timeout(UPLOAD_MILLIS);
        this.cancelled(signal);
        const path = this.path(share.id);
        const info = await stat(input.path);
        this.cancelled(signal);
        if (!info.isFile() || info.size <= 0 || info.size > ASSET_LIMIT) throw new ShareError('INVALID_FILE', 'Hosted video must be a nonempty file of at most 2 GiB.');
        const asset = this.asset(await describeAsset({ ...input, signal }));
        this.cancelled(signal);
        const state = await this.store.read(share.id) ?? { reservation: share, uploads: {} };
        if (state.reservation.url !== share.url || share.url !== this.url(`/s/${share.manifest.id}`)) throw new ShareError('JOB_MISMATCH', 'Hosted upload belongs to another share.');
        const provider = this.base.origin;
        const prior = state.uploads[asset.file];
        if (prior && (prior.provider !== provider || prior.sha256 !== asset.sha256 || prior.size !== asset.bytes)) throw new ShareError('JOB_MISMATCH', 'Saved hosted upload does not match this service or asset.');
        const inventory = await this.request<{ uploadId: string; partBytes: number; parts: PartReceipt[]; expiresAt: string }>(`${path}/assets`, 'POST', {
            kind: 'video', file: asset.file, bytes: asset.bytes, sha256: asset.sha256, mimeType: 'video/mp4',
        }, signal);
        if (!inventory || typeof inventory.uploadId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(inventory.uploadId) || inventory.partBytes !== PART_BYTES || !Array.isArray(inventory.parts) ||
            inventory.parts.length > Math.ceil(asset.bytes / PART_BYTES) || !Number.isFinite(Date.parse(inventory.expiresAt)) || Date.parse(inventory.expiresAt) <= Date.now())
            throw new ShareError('INVALID_RESPONSE', 'Hosted upload inventory is invalid.');
        const receipts = new Map<number, PartReceipt>();
        for (const part of inventory.parts) {
            if (!part || !Number.isSafeInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > Math.ceil(asset.bytes / PART_BYTES) || receipts.has(part.partNumber) ||
                part.bytes !== Math.min(PART_BYTES, asset.bytes - (part.partNumber - 1) * PART_BYTES) || !/^[a-f0-9]{64}$/.test(part.sha256))
                throw new ShareError('INVALID_RESPONSE', 'Hosted part inventory is invalid.');
            receipts.set(part.partNumber, part);
        }
        const job = { key: `native/${share.id}/${asset.file}`, sha256: asset.sha256, size: asset.bytes, provider, uploadId: inventory.uploadId, parts: {} as Record<string, string>, completed: false };
        state.uploads[asset.file] = job;
        await this.store.write(share.id, state);
        const full = createHash('sha256');
        let bytes = 0, skippedParts = 0;
        for (let number = 1; number <= Math.ceil(asset.bytes / PART_BYTES); number++) {
            this.cancelled(signal);
            const size = Math.min(PART_BYTES, asset.bytes - (number - 1) * PART_BYTES);
            const chunk = await readChunk(input.path, (number - 1) * PART_BYTES, size);
            this.cancelled(signal);
            const sha256 = createHash('sha256').update(chunk).digest('hex');
            full.update(chunk);
            const persisted = receipts.get(number);
            if (persisted && persisted.sha256 !== sha256) throw new ShareError('PART_MISMATCH', 'Hosted persisted bytes differ from this file.');
            if (persisted) skippedParts++;
            else {
                const acknowledgement = await this.request<PartReceipt>(`${path}/assets/${inventory.uploadId}/parts/${number}`, 'PUT', chunk, signal, true);
                if (!acknowledgement || acknowledgement.partNumber !== number || acknowledgement.bytes !== size || acknowledgement.sha256 !== sha256)
                    throw new ShareError('INVALID_RESPONSE', 'Hosted upload acknowledgement does not match the sent bytes.');
            }
            job.parts[String(number)] = sha256;
            bytes += size;
            await this.store.write(share.id, state);
            input.onProgress?.({ bytes, total: asset.bytes, skippedParts });
        }
        this.cancelled(signal);
        if (full.digest('hex') !== asset.sha256 || (await stat(input.path)).size !== asset.bytes) throw new ShareError('FILE_CHANGED', 'Video changed during hosted upload.');
        const complete = this.asset(await this.request<UploadedAsset>(`${path}/assets/${inventory.uploadId}/complete`, 'POST', {}, signal));
        if (complete.file !== asset.file || complete.bytes !== asset.bytes || complete.sha256 !== asset.sha256) throw new ShareError('INVALID_RESPONSE', 'Hosted completion does not match this video.');
        this.cancelled(signal);
        job.completed = true;
        await this.store.write(share.id, state);
        return asset;
    }
    async publish(share: ShareReservation, input: PublishInput): Promise<ShareReservation> {
        if (input.poster || input.captions?.length || input.transcript) throw new ShareError('SHARE_FEATURE_UNSUPPORTED', 'Hosted sharing currently publishes the video only.');
        const video = this.asset(input.video);
        const metadata = this.publicationFields(input);
        const detail = this.detail(await this.request<NativeDetail>(`${this.path(share.id)}/publish`, 'POST', { video: { file: video.file, bytes: video.bytes, sha256: video.sha256 }, ...metadata }), share.id);
        if (detail.manifest.status !== 'ready' || detail.url !== share.url || detail.video?.sha256 !== video.sha256 || detail.video.file !== video.file || detail.video.bytes !== video.bytes)
            throw new ShareError('INVALID_RESPONSE', 'Hosted publication is not ready with the verified video.');
        return this.save(detail);
    }
    private publicationFields(input: Partial<Pick<MetadataPatch, 'title' | 'summary' | 'chapters'>>): Partial<Pick<MetadataPatch, 'title' | 'summary' | 'chapters'>> {
        const fields = metadataPatch({ title: input.title, summary: input.summary, chapters: input.chapters });
        if (fields.title !== undefined && fields.title.length > 160) throw new ShareError('INVALID_METADATA', 'Hosted title is too long.');
        return fields;
    }
    async updateMetadata(share: ShareReservation, patch: Partial<MetadataPatch>): Promise<ShareReservation> {
        if (patch.poster !== undefined || patch.captions !== undefined || patch.transcript !== undefined) throw new ShareError('SHARE_FEATURE_UNSUPPORTED', 'Hosted sharing currently publishes the video only.');
        const fields = this.publicationFields(patch);
        const detail = this.detail(await this.request<NativeDetail>(this.path(share.id)), share.id);
        if (detail.url !== share.url || detail.manifest.status !== 'ready' || !detail.video) throw new ShareError('MEDIA_NOT_READY', 'Hosted video is not ready for metadata changes.');
        return this.publish(share, { video: detail.video, width: detail.manifest.video!.width, height: detail.manifest.video!.height, durationMs: detail.manifest.durationMs, ...fields });
    }
    async delete(share: ShareReservation): Promise<void> {
        const result = await this.request<{ state: string }>(this.path(share.id), 'DELETE');
        if (!['deleting', 'deleted'].includes(result?.state)) throw new ShareError('INVALID_RESPONSE', 'Hosted deletion is not acknowledged.');
        await this.store.remove(share.id);
    }
    private policy(value: SharePolicy): SharePolicy {
        if (typeof value?.protected !== 'boolean' || (value.expiresAt !== null && (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)))))
            throw new ShareError('INVALID_RESPONSE', 'Hosted share policy is invalid.');
        return { protected: value.protected, expiresAt: value.expiresAt };
    }
    async getPolicy(id: string): Promise<SharePolicy> { return this.policy(await this.request<SharePolicy>(`${this.path(id)}/share`)); }
    async updatePolicy(id: string, patch: SharePolicyPatch): Promise<SharePolicy> {
        const fields: SharePolicyPatch = {};
        if (patch.password !== undefined) fields.password = patch.password;
        if (patch.expiresAt !== undefined) fields.expiresAt = patch.expiresAt;
        return this.policy(await this.request<SharePolicy>(`${this.path(id)}/share`, 'PATCH', fields));
    }
    async setupCheck(): Promise<{ ok: true; provider: 'hosted'; checks: string[] }> {
        const session = await this.request<{ user: { id: string; tenantId: string; email: string; name: string }; deviceId: string; expiresAt: string; canUpload: boolean; usage: unknown }>('/api/native/session');
        if (!session?.user || !['id', 'tenantId', 'email', 'name'].every(key => typeof session.user[key as keyof typeof session.user] === 'string' && session.user[key as keyof typeof session.user].length > 0) ||
            typeof session.deviceId !== 'string' || !session.deviceId || typeof session.canUpload !== 'boolean' || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now())
            throw new ShareError('INVALID_RESPONSE', 'Hosted account session is invalid or expired.');
        return { ok: true, provider: 'hosted', checks: ['native account session', session.canUpload ? 'server upload entitlement' : 'account connected; upload entitlement unavailable'] };
    }
}
