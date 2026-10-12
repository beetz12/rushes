export type Fetch = typeof fetch;
export interface Chapter {
    startMs: number;
    title: string;
}
export interface ShareManifest {
    schema: 'rushes.share/1';
    id: string;
    status: 'processing' | 'ready' | 'failed';
    title: string;
    createdAt: string;
    durationMs: number;
    summary?: string | null;
    video?: {
        file: string;
        width: number;
        height: number;
        bytes: number;
    };
    poster?: string;
    captions?: Array<{
        file: string;
        lang: string;
    }>;
    transcript?: string;
    chapters?: Chapter[];
}
export interface ReserveInput {
    id?: string;
    title: string;
    durationMs?: number;
    password?: string;
    expiresAt?: string;
}
export interface ShareReservation {
    id: string;
    url: string;
    manifest: ShareManifest;
}
export interface UploadInput {
    path: string;
    kind: 'video' | 'poster' | 'captions' | 'transcript';
    signal?: AbortSignal;
    onProgress?: (p: {
        bytes: number;
        total: number;
        skippedParts: number;
    }) => void;
}
export interface UploadedAsset {
    file: string;
    bytes: number;
    sha256: string;
    kind: UploadInput['kind'];
}
export type MetadataPatch = Pick<ShareManifest, 'title' | 'durationMs'> & Partial<Pick<ShareManifest, 'summary' | 'chapters' | 'poster' | 'captions'>> & { transcript?: string | null };
export interface PublishInput {
    video: UploadedAsset;
    width: number;
    height: number;
    durationMs: number;
    title?: string;
    summary?: string | null;
    chapters?: Chapter[];
    captions?: ShareManifest['captions'];
    /** Null explicitly removes a stale transcript when an edited snapshot has none. */
    transcript?: string | null;
    poster?: UploadedAsset;
}
/** Private owner-facing policy; passwords and hashes never appear in this snapshot. */
export interface SharePolicy {
    protected: boolean;
    expiresAt: string | null;
}
export interface SharePolicyPatch {
    /** Omitted preserves the current password; null removes protection. */
    password?: string | null;
    /** Omitted preserves expiry; null removes it. Otherwise a future ISO timestamp. */
    expiresAt?: string | null;
}
export interface ShareComment {
    id: string;
    name: string;
    body: string;
    timestampMs: number;
    createdAt: string;
}
export interface ShareReaction {
    kind: 'like' | 'love' | 'celebrate';
    count: number;
}
export interface ShareFeedback {
    views: number;
    /** The service returns at most the first 500 comments, in creation order. */
    comments: ShareComment[];
    reactions: ShareReaction[];
}
export interface ShareProvider {
    reserve(input: ReserveInput): Promise<ShareReservation>;
    upload(share: ShareReservation, input: UploadInput): Promise<UploadedAsset>;
    publish(share: ShareReservation, input: PublishInput): Promise<ShareReservation>;
    updateMetadata(share: ShareReservation, patch: Partial<MetadataPatch>): Promise<ShareReservation>;
    delete(share: ShareReservation): Promise<void>;
    getPolicy?(id: string): Promise<SharePolicy>;
    updatePolicy?(id: string, patch: SharePolicyPatch): Promise<SharePolicy>;
    feedback?(id: string): Promise<ShareFeedback>;
    setupCheck(): Promise<{
        ok: true;
        provider: 'bucket' | 'worker';
        checks: string[];
    }>;
}
export class ShareError extends Error {
    constructor(readonly code: string, message: string, readonly status?: number) { super(message); this.name = 'ShareError'; }
}
export const SHARE_ID = /^[A-Za-z0-9_-]{22}$/;
export function assertShareId(id: string): string { if (!SHARE_ID.test(id))
    throw new ShareError('INVALID_SHARE_ID', 'Share ID must be 22 base64url characters.'); return id; }
export const ASSET_FILE = /^(video-[a-f0-9]{8}\.mp4|poster-[a-f0-9]{8}\.(?:jpg|png)|captions-[a-f0-9]{8}\.vtt|transcript-[a-f0-9]{8}\.json)$/;
export function assertAssetFile(file: string): string { if (!ASSET_FILE.test(file))
    throw new ShareError('INVALID_ASSET', 'Invalid share asset filename.'); return file; }
export function requireHTTPS(value: string, allowLocalHTTP = false): URL {
    const endpointAddress = new URL(value);
    const privateComponents = ['username', 'password', 'search', 'hash'] as const;
    for (const component of privateComponents) {
        if (endpointAddress[component].length > 0) throw new ShareError('INVALID_URL', `Endpoint URL must not contain ${component}.`);
    }
    const allowedSchemes = new Set(['https:']);
    const developmentHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    if (allowLocalHTTP && developmentHosts.has(endpointAddress.hostname)) allowedSchemes.add('http:');
    if (!allowedSchemes.has(endpointAddress.protocol)) throw new ShareError('INVALID_URL', 'Use HTTPS or explicitly allowed local development HTTP.');
    return endpointAddress;
}
/** Runtime projection keeps untrusted input and future private settings out of public manifests/jobs. */
export function metadataPatch(input: Partial<MetadataPatch>): Partial<MetadataPatch> {
    const out: Partial<MetadataPatch> = {};
    const string = (v: unknown, max: number, min = 0): string => { if (typeof v !== 'string' || v.length < min || v.length > max)
        throw new ShareError('INVALID_METADATA', 'Metadata text is invalid.'); return v; };
    const millis = (v: unknown): number => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 604800000)
        throw new ShareError('INVALID_METADATA', 'Metadata time is invalid.'); return v; };
    if (input.title !== undefined)
        out.title = string(input.title, 300, 1);
    if (input.durationMs !== undefined)
        out.durationMs = millis(input.durationMs);
    if (input.summary !== undefined)
        out.summary = input.summary === null ? null : string(input.summary, 5000);
    if (input.poster !== undefined) {
        out.poster = assertAssetFile(input.poster);
        if (!out.poster.startsWith('poster-'))
            throw new ShareError('INVALID_METADATA', 'Poster filename required.');
    }
    if (input.transcript !== undefined) {
        out.transcript = input.transcript === null ? null : assertAssetFile(input.transcript);
        if (out.transcript !== null && !out.transcript.startsWith('transcript-'))
            throw new ShareError('INVALID_METADATA', 'Transcript filename required.');
    }
    if (input.captions !== undefined) {
        if (!Array.isArray(input.captions) || input.captions.length > 20)
            throw new ShareError('INVALID_METADATA', 'At most 20 caption tracks allowed.');
        out.captions = input.captions.map(c => { const file = assertAssetFile(c.file); if (!file.startsWith('captions-'))
            throw new ShareError('INVALID_METADATA', 'Caption filename required.'); return { file, lang: string(c.lang, 35, 2) }; });
    }
    if (input.chapters !== undefined) {
        if (!Array.isArray(input.chapters) || input.chapters.length > 500)
            throw new ShareError('INVALID_METADATA', 'At most 500 chapters allowed.');
        out.chapters = input.chapters.map(c => ({ startMs: millis(c.startMs), title: string(c.title, 300, 1) }));
    }
    return out;
}
/** Apply a projected patch without allowing nullable deletion markers into public state. */
export function applyMetadata(input: ShareManifest, rawPatch: Partial<MetadataPatch>): ShareManifest {
    const { transcript, ...fields } = metadataPatch(rawPatch);
    const next: ShareManifest = { ...input, ...fields };
    if (transcript === null) delete next.transcript;
    else if (transcript !== undefined) next.transcript = transcript;
    return next;
}
/** Metadata belongs to the same ready snapshot as the verified video. */
export function publicationMetadata(input: PublishInput): Partial<MetadataPatch> {
    return metadataPatch({title:input.title,durationMs:input.durationMs,summary:input.summary,
        chapters:input.chapters,captions:input.captions,transcript:input.transcript});
}
export function publicManifest(input: ShareManifest): ShareManifest {
    assertShareId(input.id);
    if (input.schema !== 'rushes.share/1' || !['processing', 'ready', 'failed'].includes(input.status) || typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt)))
        throw new ShareError('INVALID_MANIFEST', 'Share manifest is invalid.');
    const out = applyMetadata({schema:'rushes.share/1',id:input.id,status:input.status,createdAt:input.createdAt,title:'',durationMs:0},input);
    if (input.video) {
        const v = input.video;
        assertAssetFile(v.file);
        if (!v.file.startsWith('video-') || ![v.width, v.height, v.bytes].every(n => Number.isSafeInteger(n) && n > 0))
            throw new ShareError('INVALID_MANIFEST', 'Video metadata is invalid.');
        out.video = { file: v.file, width: v.width, height: v.height, bytes: v.bytes };
    }
    return out;
}
