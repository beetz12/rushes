import { randomBytes } from 'node:crypto';
import { describeAsset, readChunk, PART_BYTES, xmlEscape, xmlValue } from './assets.js';
import { signV4, type SigningCredentials } from './sigv4.js';
import { viewerPage } from './page.js';
import { MemoryJobStore, type JobStore, type ShareJob, type UploadJob } from './store.js';
import { ShareError, assertShareId, assertAssetFile, requireHTTPS, applyMetadata, publicationMetadata, publicManifest, type Fetch, type ShareProvider, type ShareReservation, type ReserveInput, type UploadInput, type UploadedAsset, type PublishInput, type MetadataPatch, type SharePolicy, type SharePolicyPatch, type ShareFeedback } from './types.js';
export interface BucketConfig extends SigningCredentials {
    endpoint: string;
    region: string;
    bucket: string;
    publicBaseURL: string;
}
export interface BucketOptions {
    store?: JobStore;
    fetch?: Fetch;
    viewerAssets: {
        js: string;
        css: string;
    };
    allowLocalHTTP?: boolean;
}
export class BucketProvider implements ShareProvider {
    readonly store: JobStore;
    private fetcher: Fetch;
    private endpoint: URL;
    private base: URL;
    async getPolicy(_id: string): Promise<SharePolicy> {
        throw new ShareError('SHARE_FEATURE_UNSUPPORTED', 'Share policy requires Worker mode.');
    }
    async updatePolicy(_id: string, _patch: SharePolicyPatch): Promise<SharePolicy> {
        throw new ShareError('SHARE_FEATURE_UNSUPPORTED', 'Share policy requires Worker mode.');
    }
    async feedback(_id: string): Promise<ShareFeedback> {
        throw new ShareError('SHARE_FEATURE_UNSUPPORTED', 'Share feedback requires Worker mode.');
    }
    constructor(private config: BucketConfig, private options: BucketOptions) {
        this.endpoint = requireHTTPS(config.endpoint, options.allowLocalHTTP);
        this.base = requireHTTPS(config.publicBaseURL, options.allowLocalHTTP);
        if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || !config.region || !config.accessKeyId || !config.secretAccessKey)
            throw new ShareError('INVALID_CONFIG', 'Bucket credentials and region are required.');
        this.store = options.store ?? new MemoryJobStore();
        this.fetcher = options.fetch ?? fetch;
    }
    private objectURL(key: string, query: Record<string, string> = {}): URL {
        const u = new URL(this.endpoint);
        u.pathname = this.endpoint.pathname.replace(/\/$/, '') + '/' + this.config.bucket + (key ? '/' + key.split('/').map(encodeURIComponent).join('/') : '');
        for (const [k, v] of Object.entries(query))
            u.searchParams.set(k, v);
        return u;
    }
    private publicURL(key: string): string { return this.base.toString().replace(/\/$/, '') + '/' + key; }
    private async request(method: string, key: string, query: Record<string, string> = {}, body?: Uint8Array | string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
        const url = this.objectURL(key, query);
        const signed = signV4({ method, url, body, headers, credentials: this.config, region: this.config.region });
        let r: Response;
        try {
            r = await this.fetcher(url, { method, headers: signed.headers, body: body as BodyInit | undefined, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000), redirect: 'error' });
        }
        catch {
            throw new ShareError(signal?.aborted ? 'CANCELLED' : 'NETWORK_ERROR', signal?.aborted ? 'Upload cancelled.' : 'Bucket request failed.');
        }
        if (!r.ok)
            throw new ShareError('BUCKET_HTTP', `Bucket ${method} failed with HTTP ${r.status}.`, r.status);
        return r;
    }
    private async put(key: string, body: string | Uint8Array, type: string, cache = 'no-store'): Promise<void> { await this.request('PUT', key, {}, body, { 'content-type': type, 'cache-control': cache }); }
    private async save(share: ShareReservation): Promise<ShareReservation> { const s = await this.store.read(share.id); await this.store.write(share.id, { reservation: share, uploads: s?.uploads ?? {} }); return share; }
    private async document(share: ShareReservation): Promise<void> {
        share.manifest = publicManifest(share.manifest);
        await this.put(`s/${share.id}/share.json`, JSON.stringify(share.manifest), 'application/json');
        await this.put(`s/${share.id}`, viewerPage(share.manifest, this.base.toString()), 'text/html');
    }
    async reserve(input: ReserveInput): Promise<ShareReservation> {
        if (input.password !== undefined || input.expiresAt !== undefined)
            throw new ShareError('SHARE_FEATURE_UNSUPPORTED', 'Password protection and expiry require Worker mode.');
        const id = assertShareId(input.id ?? randomBytes(16).toString('base64url'));
        const prior = await this.store.read(id);
        if (prior) {
            const publicPage = await this.fetcher(prior.reservation.url, { cache: 'no-store', signal: AbortSignal.timeout(15000), redirect: 'error' });
            if (!publicPage.ok)
                throw new ShareError('PUBLIC_UNREACHABLE', `Processing page is not public (HTTP ${publicPage.status}).`);
            return prior.reservation;
        }
        if (!input.title.trim() || input.title.length > 300)
            throw new ShareError('INVALID_TITLE', 'A title of at most 300 characters is required.');
        const share: ShareReservation = { id, url: this.publicURL(`s/${id}`), manifest: { schema: 'rushes.share/1', id, status: 'processing', title: input.title, createdAt: new Date().toISOString(), durationMs: input.durationMs ?? 0 } };
        await Promise.all([this.put('_viewer/v1/viewer.js', this.options.viewerAssets.js, 'text/javascript', 'public,max-age=31536000,immutable'), this.put('_viewer/v1/viewer.css', this.options.viewerAssets.css, 'text/css', 'public,max-age=31536000,immutable')]);
        await this.document(share);
        await this.save(share);
        const page = await this.fetcher(share.url, { cache: 'no-store', signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!page.ok)
            throw new ShareError('PUBLIC_UNREACHABLE', `Processing page is not public (HTTP ${page.status}).`);
        return share;
    }
    async upload(share: ShareReservation, input: UploadInput): Promise<UploadedAsset> {
        assertShareId(share.id);
        const asset = await describeAsset(input);
        const key = `s/${share.id}/${asset.file}`;
        const state: ShareJob = await this.store.read(share.id) ?? { reservation: share, uploads: {} };
        let job = state.uploads[asset.file];
        const provider = this.objectURL('').toString();
        if (job && (job.sha256 !== asset.sha256 || job.size !== asset.bytes || job.provider !== provider))
            throw new ShareError('JOB_MISMATCH', 'Saved upload does not match this asset/provider.');
        job ??= { key, sha256: asset.sha256, size: asset.bytes, parts: {}, provider };
        state.uploads[asset.file] = job;
        if (job.completed) {
            await this.verifySize(key, asset.bytes);
            return asset;
        }
        if (job.uploadId) {
            try {
                await this.verifySize(key, asset.bytes);
                job.completed = true;
                job.uploadId = undefined;
                await this.store.write(share.id, state);
                return asset;
            }
            catch (e) {
                if (!(e instanceof ShareError && e.status === 404))
                    throw e;
            }
        }
        if (asset.bytes < PART_BYTES) {
            await this.request('PUT', key, {}, await readChunk(input.path, 0, asset.bytes), { 'content-type': asset.contentType, 'cache-control': 'public,max-age=31536000,immutable' }, input.signal);
            await this.verifySize(key, asset.bytes);
            job.completed = true;
            await this.store.write(share.id, state);
            input.onProgress?.({ bytes: asset.bytes, total: asset.bytes, skippedParts: 0 });
            return asset;
        }
        if (!job.uploadId) {
            const r = await this.request('POST', key, { uploads: '' }, '', { 'content-type': asset.contentType, 'cache-control': 'public,max-age=31536000,immutable' }, input.signal);
            job.uploadId = xmlValue(await r.text(), 'UploadId');
            if (!job.uploadId)
                throw new ShareError('INVALID_UPLOAD', 'Provider returned no multipart upload ID.');
            await this.store.write(share.id, state);
        }
        const current = job;
        let bytes = 0;
        let skippedParts = 0;
        try {
            // Do not trust local ETags after a crash: reconcile the remote part list.
            const remote = await this.listParts(current);
            const count = Math.ceil(asset.bytes / PART_BYTES);
            for (const [n, v] of Object.entries(current.parts)) {
                const expected = Math.min(PART_BYTES, asset.bytes - (Number(n) - 1) * PART_BYTES);
                if (remote[n]?.etag !== v || remote[n]?.size !== expected)
                    delete current.parts[n];
            }
            for (const n of Object.keys(current.parts)) {
                bytes += Math.min(PART_BYTES, asset.bytes - (Number(n) - 1) * PART_BYTES);
                skippedParts++;
            }
            await this.store.write(share.id, state);
            input.onProgress?.({ bytes, total: asset.bytes, skippedParts });
            const missing = Array.from({ length: count }, (_, i) => i + 1).filter(n => !current.parts[String(n)]);
            let cursor = 0;
            let failure: unknown;
            const doParts = async (): Promise<void> => {
                while (cursor < missing.length && !failure) {
                    const n = missing[cursor++]!;
                    const size = Math.min(PART_BYTES, asset.bytes - (n - 1) * PART_BYTES);
                    try {
                        const body = await readChunk(input.path, (n - 1) * PART_BYTES, size);
                        let etag: string | null = null;
                        for (let attempt = 0; attempt < 3; attempt++) {
                            try {
                                const r = await this.request('PUT', key, { uploadId: current.uploadId!, partNumber: String(n) }, body, {}, input.signal);
                                etag = r.headers.get('etag');
                                if (!etag)
                                    throw new ShareError('ETAG_MISSING', 'Multipart part response has no ETag.');
                                break;
                            }
                            catch (e) {
                                if (input.signal?.aborted || attempt === 2)
                                    throw e;
                                await new Promise(r => setTimeout(r, 100 * (2 ** attempt)));
                            }
                        }
                        current.parts[String(n)] = etag!;
                        await this.store.write(share.id, state);
                        bytes += size;
                        input.onProgress?.({ bytes, total: asset.bytes, skippedParts });
                    }
                    catch (e) {
                        failure = e;
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(4, missing.length) }, () => doParts()));
            if (failure)
                throw failure;
            const body = '<CompleteMultipartUpload>' + Object.entries(current.parts).sort(([a], [b]) => Number(a) - Number(b)).map(([n, etag]) => `<Part><PartNumber>${n}</PartNumber><ETag>${xmlEscape(etag)}</ETag></Part>`).join('') + '</CompleteMultipartUpload>';
            const completion = await this.request('POST', key, { uploadId: current.uploadId! }, body, { 'content-type': 'application/xml' }, input.signal);
            const xml = await completion.text();
            if (/<Error>/.test(xml))
                throw new ShareError('MULTIPART_COMPLETE', 'Provider rejected multipart completion.');
            await this.verifySize(key, asset.bytes);
            current.completed = true;
            current.uploadId = undefined;
            await this.store.write(share.id, state);
            return asset;
        }
        catch (e) {
            // Process death leaves this untouched. Explicit cancellation/final failure aborts billing-bearing parts.
            if (current.uploadId) {
                try {
                    await this.request('DELETE', key, { uploadId: current.uploadId });
                    current.uploadId = undefined;
                    current.parts = {};
                    await this.store.write(share.id, state);
                }
                catch {
                    throw new ShareError('ABORT_FAILED', 'Upload failed and abort could not be confirmed; retry or remove this share.');
                }
            }
            throw e;
        }
    }
    private async listParts(job: UploadJob): Promise<Record<string, {
        etag: string;
        size: number;
    }>> {
        const parts: Record<string, {
            etag: string;
            size: number;
        }> = {};
        let marker = '';
        do {
            const r = await this.request('GET', job.key, { uploadId: job.uploadId!, ...(marker ? { 'part-number-marker': marker } : {}) });
            const xml = await r.text();
            for (const m of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
                const n = xmlValue(m[1]!, 'PartNumber'), etag = xmlValue(m[1]!, 'ETag'), size = Number(xmlValue(m[1]!, 'Size'));
                if (n && etag && Number.isSafeInteger(size))
                    parts[n] = { etag, size };
            }
            marker = xmlValue(xml, 'IsTruncated') === 'true' ? xmlValue(xml, 'NextPartNumberMarker') ?? '' : '';
            if (xmlValue(xml, 'IsTruncated') === 'true' && !marker)
                throw new ShareError('INVALID_LIST', 'Multipart pagination is incomplete.');
        } while (marker);
        return parts;
    }
    private async verifySize(key: string, size: number): Promise<void> { const r = await this.request('HEAD', key); if (Number(r.headers.get('content-length')) !== size)
        throw new ShareError('SIZE_MISMATCH', 'Remote object length does not match the local file.'); }
    async publish(share: ShareReservation, input: PublishInput): Promise<ShareReservation> {
        assertAssetFile(input.video.file);
        if (input.video.kind !== 'video')
            throw new ShareError('INVALID_VIDEO', 'A video asset is required.');
        await this.verifySize(`s/${share.id}/${input.video.file}`, input.video.bytes);
        const previous = share.manifest.video?.file;
        const manifest = applyMetadata(share.manifest, publicationMetadata(input));
        const next: ShareReservation = { ...share, manifest: { ...manifest, status: 'ready', video: { file: input.video.file, bytes: input.video.bytes, width: input.width, height: input.height }, ...(input.poster ? { poster: assertAssetFile(input.poster.file) } : {}) } };
        for(const file of [...(next.manifest.captions?.map(c=>c.file)??[]), ...(next.manifest.transcript?[next.manifest.transcript]:[])]) await this.request('HEAD', `s/${share.id}/${assertAssetFile(file)}`);
        await this.document(next);
        await this.save(next);
        if (previous && previous !== input.video.file)
            await this.request('DELETE', `s/${share.id}/${assertAssetFile(previous)}`);
        return next;
    }
    async updateMetadata(share: ShareReservation, patch: Partial<MetadataPatch>): Promise<ShareReservation> { for (const f of [patch.poster, patch.transcript, ...(patch.captions?.map(c => c.file) ?? [])])
        if (f)
            assertAssetFile(f); const next = { ...share, manifest: applyMetadata(share.manifest, patch) }; await this.document(next); return this.save(next); }
    private async list(prefix: string): Promise<string[]> { const keys: string[] = []; let token = ''; do {
        const r = await this.request('GET', '', { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) });
        const xml = await r.text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
            const key = xmlValue(m[1]!, 'Key');
            if (key && key.startsWith(prefix))
                keys.push(key);
        }
        token = xmlValue(xml, 'IsTruncated') === 'true' ? xmlValue(xml, 'NextContinuationToken') ?? '' : '';
        if (xmlValue(xml, 'IsTruncated') === 'true' && !token)
            throw new ShareError('INVALID_LIST', 'Object listing pagination is incomplete.');
    } while (token); return keys; }
    async delete(share: ShareReservation): Promise<void> {
        assertShareId(share.id);
        const state = await this.store.read(share.id);
        for (const job of Object.values(state?.uploads ?? {}))
            if (job.uploadId)
                await this.request('DELETE', job.key, { uploadId: job.uploadId });
        const prefix = `s/${share.id}/`;
        for (const key of await this.list(prefix))
            await this.request('DELETE', key);
        await this.request('DELETE', `s/${share.id}`);
        if ((await this.list(prefix)).length)
            throw new ShareError('DELETE_INCOMPLETE', 'Share objects remain after deletion.');
        const page = await this.fetcher(share.url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (page.status !== 404 && page.status !== 403)
            throw new ShareError('DELETE_PUBLIC', 'The deleted share is still publicly reachable.');
        await this.store.remove(share.id);
    }
    async setupCheck(): Promise<{
        ok: true;
        provider: 'bucket';
        checks: string[];
    }> {
        const key = `_rushes-probe-${randomBytes(16).toString('hex')}.mp4`;
        const data = 'rushes-connection-probe';
        try {
            await this.put(key, data, 'video/mp4');
            const stored = await this.request('GET', key);
            if (await stored.text() !== data)
                throw new ShareError('PROBE_READ', 'Probe read-back failed.');
            const publicResult = await this.fetcher(this.publicURL(key), { cache: 'no-store', signal: AbortSignal.timeout(15000) });
            if (!publicResult.ok || await publicResult.text() !== data)
                throw new ShareError('PUBLIC_UNREACHABLE', 'Bucket is not publicly readable at the configured URL.');
            const range = await this.fetcher(this.publicURL(key), { headers: { Range: 'bytes=0-5' }, signal: AbortSignal.timeout(15000) });
            if (range.status !== 206 || await range.text() !== data.slice(0, 6))
                throw new ShareError('RANGE_UNSUPPORTED', 'Public host does not serve video byte ranges.');
            const root = await this.fetcher(this.base, { signal: AbortSignal.timeout(15000) });
            if (root.ok && /<ListBucketResult|"(?:Contents|objects)"\s*:/.test(await root.text()))
                throw new ShareError('PUBLIC_LISTING', 'Disable public bucket listing before sharing.');
        }
        finally {
            await this.request('DELETE', key);
        }
        return { ok: true, provider: 'bucket', checks: ['signed write/read/delete', 'public read', 'byte range', 'no public listing'] };
    }
}
