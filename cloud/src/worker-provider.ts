import { randomBytes } from 'node:crypto';
import { describeAsset, readChunk, PART_BYTES } from './assets.js';
import { MemoryJobStore, type JobStore } from './store.js';
import { ShareError, assertShareId, requireHTTPS, metadataPatch, publicationMetadata, publicManifest, type Fetch, type ShareProvider, type ShareReservation, type ReserveInput, type UploadInput, type UploadedAsset, type PublishInput, type MetadataPatch, type SharePolicy, type SharePolicyPatch, type ShareFeedback } from './types.js';
export interface WorkerConfig {
    workerURL: string;
    token: string;
}
export class WorkerProvider implements ShareProvider {
    readonly store: JobStore;
    private base: URL;
    private fetcher: Fetch;
    constructor(private config: WorkerConfig, options: {
        store?: JobStore;
        fetch?: Fetch;
        allowLocalHTTP?: boolean;
    } = {}) { this.base = requireHTTPS(config.workerURL, options.allowLocalHTTP); if (config.token.length < 32)
        throw new ShareError('INVALID_CONFIG', 'Worker owner token must contain at least 32 characters.'); this.store = options.store ?? new MemoryJobStore(); this.fetcher = options.fetch ?? fetch; }
    private url(path: string): string { return this.base.toString().replace(/\/$/, '') + path; }
    private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> { let r: Response; try {
        r = await this.fetcher(this.url(path), { method, headers: { Authorization: `Bearer ${this.config.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000), redirect: 'error' });
    }
    catch {
        throw new ShareError('NETWORK_ERROR', 'Worker request failed.');
    } if (!r.ok)
        throw new ShareError('WORKER_HTTP', `Worker request failed with HTTP ${r.status}.`, r.status); return r.status === 204 ? undefined as T : await r.json() as T; }
    private async save(r: ShareReservation): Promise<ShareReservation> { r = { id: assertShareId(r.id), url: r.url, manifest: publicManifest(r.manifest) }; const s = await this.store.read(r.id); await this.store.write(r.id, { reservation: r, uploads: s?.uploads ?? {} }); return r; }
    async reserve(input: ReserveInput): Promise<ShareReservation> { const id = assertShareId(input.id ?? randomBytes(16).toString('base64url')); const s = await this.store.read(id); let share = s?.reservation; if (!share)
        share = await this.request<ShareReservation>('/api/shares', 'POST', { ...input, id }); if (share.id !== id || share.url !== this.url(`/s/${id}`))
        throw new ShareError('INVALID_RESPONSE', 'Worker returned an unexpected share URL/ID.'); const page = await this.fetcher(share.url, { cache: 'no-store', signal: AbortSignal.timeout(15000), redirect: 'error' }); if (!page.ok)
        throw new ShareError('PUBLIC_UNREACHABLE', `Worker processing page is not public (HTTP ${page.status}).`); return this.save(share); }
    async upload(share: ShareReservation, input: UploadInput): Promise<UploadedAsset> {
        assertShareId(share.id);
        const asset = await describeAsset(input);
        const s = await this.store.read(share.id) ?? { reservation: share, uploads: {} };
        let job = s.uploads[asset.file];
        const provider = this.base.toString();
        if (job && (job.provider !== provider || job.sha256 !== asset.sha256 || job.size !== asset.bytes))
            throw new ShareError('JOB_MISMATCH', 'Saved upload does not match this provider or asset.');
        job ??= { key: `s/${share.id}/${asset.file}`, sha256: asset.sha256, size: asset.bytes, parts: {}, provider };
        s.uploads[asset.file] = job;
        if (job.completed)
            return asset;
        const path = `/api/shares/${share.id}/uploads`;
        const created = await this.request<{
            uploadId: string;
            parts: Array<{
                partNumber: number;
                etag: string;
                size: number;
            }>;
        }>(path, 'POST', { file: asset.file, bytes: asset.bytes, contentType: asset.contentType, sha256: asset.sha256 });
        job.uploadId = created.uploadId;
        const active = job;
        active.parts = {};
        let bytes = 0;
        let skippedParts = 0;
        for (const p of created.parts) {
            const expected = Math.min(PART_BYTES, asset.bytes - (p.partNumber - 1) * PART_BYTES);
            if (p.size === expected && p.partNumber >= 1 && p.partNumber <= Math.ceil(asset.bytes / PART_BYTES)) {
                active.parts[String(p.partNumber)] = p.etag;
                bytes += p.size;
                skippedParts++;
            }
        }
        await this.store.write(share.id, s);
        input.onProgress?.({ bytes, total: asset.bytes, skippedParts });
        const missing = Array.from({ length: Math.ceil(asset.bytes / PART_BYTES) }, (_, i) => i + 1).filter(n => !active.parts[String(n)]);
        let cursor = 0;
        let failure: unknown;
        const worker = async () => {
            while (cursor < missing.length && !failure) {
                const n = missing[cursor++]!;
                const size = Math.min(PART_BYTES, asset.bytes - (n - 1) * PART_BYTES);
                try {
                    const grant = await this.request<{
                        token: string;
                    }>(`${path}/${active.uploadId}/sign`, 'POST', { partNumber: n });
                    const body = await readChunk(input.path, (n - 1) * PART_BYTES, size);
                    let etag = '';
                    for (let attempt = 0; attempt < 3; attempt++) {
                        try {
                            const r = await this.fetcher(this.url(`${path}/${active.uploadId}/parts/${n}`), { method: 'PUT', headers: { Authorization: `Upload ${grant.token}`, 'Content-Type': asset.contentType, 'Content-Length': String(size) }, body: body as BodyInit, signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000), redirect: 'error' });
                            if (!r.ok)
                                throw new ShareError('UPLOAD_HTTP', `Upload failed with HTTP ${r.status}.`, r.status);
                            etag = (await r.json() as {
                                etag: string;
                            }).etag;
                            if (!etag)
                                throw new ShareError('ETAG_MISSING', 'Worker returned no part ETag.');
                            break;
                        }
                        catch (e) {
                            if (input.signal?.aborted || attempt === 2)
                                throw e;
                            await new Promise(r => setTimeout(r, 100 * 2 ** attempt));
                        }
                    }
                    active.parts[String(n)] = etag;
                    await this.store.write(share.id, s);
                    bytes += size;
                    input.onProgress?.({ bytes, total: asset.bytes, skippedParts });
                }
                catch (e) {
                    failure = e;
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, missing.length) }, () => worker()));
        if (failure) {
            await this.request(`${path}/${active.uploadId}`, 'DELETE');
            active.uploadId = undefined;
            active.parts = {};
            await this.store.write(share.id, s);
            throw failure;
        }
        await this.request(`${path}/${active.uploadId}/complete`, 'POST', {});
        active.completed = true;
        active.uploadId = undefined;
        await this.store.write(share.id, s);
        return asset;
    }
    async publish(share: ShareReservation, input: PublishInput): Promise<ShareReservation> { return this.save(await this.request(`/api/shares/${assertShareId(share.id)}/publish`, 'POST', {...input,...publicationMetadata(input)})); }
    async updateMetadata(share: ShareReservation, patch: Partial<MetadataPatch>): Promise<ShareReservation> { return this.save(await this.request(`/api/shares/${assertShareId(share.id)}`, 'PATCH', metadataPatch(patch))); }
    async delete(share: ShareReservation): Promise<void> { await this.request(`/api/shares/${assertShareId(share.id)}`, 'DELETE'); await this.store.remove(share.id); }
    async setupCheck(): Promise<{
        ok: true;
        provider: 'worker';
        checks: string[];
    }> { return this.request('/api/setup/check', 'POST', {}); }
    async viewCount(id: string): Promise<{
        views: number;
    }> { return this.request(`/api/shares/${assertShareId(id)}/views`); }
    async getPolicy(id: string): Promise<SharePolicy> {
        return this.policy(await this.request(`/api/shares/${assertShareId(id)}/policy`));
    }
    async updatePolicy(id: string, patch: SharePolicyPatch): Promise<SharePolicy> {
        // Send only policy inputs and keep the response out of durable upload jobs.
        const input: SharePolicyPatch = {};
        if (patch.password !== undefined) input.password = patch.password;
        if (patch.expiresAt !== undefined) input.expiresAt = patch.expiresAt;
        return this.policy(await this.request(`/api/shares/${assertShareId(id)}/policy`, 'PATCH', input));
    }
    private policy(value: SharePolicy): SharePolicy {
        if (typeof value?.protected !== 'boolean' || (value.expiresAt !== null && (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)))))
            throw new ShareError('INVALID_RESPONSE', 'Worker returned an invalid share policy.');
        return { protected: value.protected, expiresAt: value.expiresAt };
    }
    async feedback(id: string): Promise<ShareFeedback> {
        const shareId = assertShareId(id);
        const [views, snapshot] = await Promise.all([
            this.viewCount(shareId),
            this.request<Pick<ShareFeedback, 'comments' | 'reactions'>>(`/api/shares/${shareId}/feedback`)
        ]);
        const invalid = (): never => { throw new ShareError('INVALID_RESPONSE', 'Worker returned invalid share feedback.'); };
        const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
        const text = (value: unknown, max: number): string => typeof value === 'string' && value.length > 0 && value.length <= max ? value : invalid();
        if (!Array.isArray(snapshot?.comments) || snapshot.comments.length > 500 || !Array.isArray(snapshot.reactions) || snapshot.reactions.length > 3) invalid();
        const comments = snapshot.comments.map(comment => {
            if (!comment || !Number.isFinite(Date.parse(comment.createdAt)) || count(comment.timestampMs) > 604800000 || !/^[A-Za-z0-9_-]{22}$/.test(comment.id)) invalid();
            return { id: comment.id, name: text(comment.name, 80), body: text(comment.body, 2000), timestampMs: comment.timestampMs, createdAt: comment.createdAt };
        });
        const reactions = snapshot.reactions.map(reaction => {
            if (!reaction || !['like', 'love', 'celebrate'].includes(reaction.kind)) invalid();
            return { kind: reaction.kind, count: count(reaction.count) };
        });
        return { views: count(views?.views), comments, reactions };
    }
}
