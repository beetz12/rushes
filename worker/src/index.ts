import type { Env, StoredObject } from './bindings.js';
import { digest, equal, passwordHash, randomID, signGrant, verifyGrant } from './crypto.js';
import { viewerPage } from '../../cloud/src/page.js';
import { ASSET_FILE, SHARE_ID, type ShareManifest, type ShareReservation } from '../../cloud/src/types.js';
declare const VIEWER_JS: string;
declare const VIEWER_CSS: string;
const PART = 10 * 1024 * 1024;
interface ShareRow {
    id: string;
    manifest: string;
    expires_at: string | null;
    password_salt: string | null;
    password_hash: string | null;
    created_at: string;
}
interface UploadRow {
    id: string;
    r2_id: string;
    share_id: string;
    file: string;
    bytes: number;
    content_type: string;
    sha256: string;
    state: string;
}
interface PartRow {
    part_number: number;
    etag: string;
    size: number;
}
class HTTPError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const fail = (status: number, code: string, message: string): never => { throw new HTTPError(status, code, message); };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
function text(v: unknown, name: string, max: number, min = 0): string { if (typeof v !== 'string' || v.length < min || v.length > max)
    fail(400, 'INVALID_INPUT', `Invalid ${name}.`); return v as string; }
function integer(v: unknown, name: string, min: number, max: number): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
    fail(400, 'INVALID_INPUT', `Invalid ${name}.`); return v as number; }
function asset(v: unknown): string { const s = text(v, 'asset', 100, 1); if (!ASSET_FILE.test(s))
    fail(400, 'INVALID_ASSET', 'Invalid asset filename.'); return s; }
async function body(req: Request, max = 32768): Promise<Record<string, unknown>> { if (!req.headers.get('content-type')?.startsWith('application/json'))
    fail(415, 'CONTENT_TYPE', 'JSON is required.'); const raw = await bounded(req, max); try {
    const data: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (!data || Array.isArray(data) || typeof data !== 'object')
        fail(400, 'INVALID_JSON', 'JSON object required.');
    return data as Record<string, unknown>;
}
catch (e) {
    if (e instanceof HTTPError)
        throw e;
    return fail(400, 'INVALID_JSON', 'Invalid JSON.');
} }
async function bounded(req: Request, max: number): Promise<Uint8Array> { const declared = req.headers.get('content-length'); if (declared && (Number(declared) > max || !/^\d+$/.test(declared)))
    fail(413, 'TOO_LARGE', 'Request is too large.'); if (!req.body)
    return new Uint8Array(); const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let total = 0; while (true) {
    const r = await reader.read();
    if (r.done)
        break;
    total += r.value.byteLength;
    if (total > max) {
        await reader.cancel();
        fail(413, 'TOO_LARGE', 'Request is too large.');
    }
    chunks.push(r.value);
} const out = new Uint8Array(total); let p = 0; for (const c of chunks) {
    out.set(c, p);
    p += c.length;
} return out; }
async function owner(req: Request, env: Env): Promise<boolean> { const token = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''; return env.OWNER_TOKEN?.length >= 32 && equal(await digest(token), await digest(env.OWNER_TOKEN)); }
async function needOwner(req: Request, env: Env): Promise<void> { if (!await owner(req, env))
    fail(401, 'OWNER_REQUIRED', 'Owner authorization required.'); }
function ensureEnv(env: Env): void { if (!env.OWNER_TOKEN || env.OWNER_TOKEN.length < 32 || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32)
    fail(503, 'CONFIG_REQUIRED', 'Worker secrets are not configured.'); const u = new URL(env.PUBLIC_BASE_URL); if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1')
    fail(503, 'CONFIG_REQUIRED', 'Public URL must be HTTPS.'); }
async function shareRow(env: Env, id: string): Promise<ShareRow> { if (!SHARE_ID.test(id))
    fail(404, 'NOT_FOUND', 'Share not found.'); const row = await env.DB.prepare('SELECT * FROM shares WHERE id = ?').bind(id).first<ShareRow>(); if (!row || (row.expires_at && Date.parse(row.expires_at) <= Date.now()))
    fail(404, 'NOT_FOUND', 'Share not found.'); return row!; }
async function allowed(req: Request, env: Env, row: ShareRow): Promise<void> { if (!row.password_hash || await owner(req, env))
    return; const cookies = req.headers.get('cookie') ?? ''; const token = cookies.split(';').map(s => s.trim()).find(s => s.startsWith('rushes_unlock='))?.slice(14) ?? ''; const grant = await verifyGrant(env.SESSION_SECRET, token); if (grant?.kind !== 'unlock' || grant.id !== row.id || grant.hash !== row.password_hash)
    fail(401, 'PASSWORD_REQUIRED', 'This recording needs a password.'); }
async function rate(env: Env, key: string, limit: number): Promise<void> { try {
    const window = Math.floor(Date.now() / 60000);
    const row = await env.DB.prepare('INSERT INTO rate_limits (key,window,count) VALUES (?,?,1) ON CONFLICT(key,window) DO UPDATE SET count=count+1 RETURNING count').bind(key, window).first<{
        count: number;
    }>();
    if (!row || row.count > limit)
        fail(429, 'THROTTLED', 'Too many attempts. Try again in a minute.');
}
catch (e) {
    if (e instanceof HTTPError)
        throw e;
    fail(503, 'RATE_UNAVAILABLE', 'Rate limit service unavailable.');
} }
const reservation = (env: Env, row: ShareRow): ShareReservation => ({ id: row.id, url: `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/s/${row.id}`, manifest: JSON.parse(row.manifest) as ShareManifest });
async function parts(env: Env, id: string): Promise<PartRow[]> { return (await env.DB.prepare('SELECT part_number,etag,size FROM upload_parts WHERE upload_id = ? ORDER BY part_number').bind(id).all<PartRow>()).results; }
async function getUpload(env: Env, share: string, id: string): Promise<UploadRow> { if (!SHARE_ID.test(id))
    fail(404, 'NOT_FOUND', 'Upload not found.'); const u = await env.DB.prepare('SELECT * FROM uploads WHERE id = ? AND share_id = ?').bind(id, share).first<UploadRow>(); if (!u)
    fail(404, 'NOT_FOUND', 'Upload not found.'); return u!; }
async function destroy(env: Env, id: string): Promise<void> {
    const uploads = (await env.DB.prepare('SELECT * FROM uploads WHERE share_id = ?').bind(id).all<UploadRow>()).results;
    for (const u of uploads)
        if (u.state === 'uploading')
            try {
                await env.MEDIA.resumeMultipartUpload(`s/${id}/${u.file}`, u.r2_id).abort();
            }
            catch {
                fail(503, 'ABORT_FAILED', 'Could not abort outstanding upload.');
            }
    let cursor: string | undefined;
    do {
        const list = await env.MEDIA.list({ prefix: `s/${id}/`, cursor });
        if (list.objects.length)
            await env.MEDIA.delete(list.objects.map(o => o.key));
        cursor = list.truncated ? list.cursor : undefined;
        if (list.truncated && !cursor)
            fail(503, 'INVALID_LIST', 'Storage pagination failed.');
    } while (cursor);
    await env.MEDIA.delete(`s/${id}`);
    if ((await env.MEDIA.list({ prefix: `s/${id}/` })).objects.length)
        fail(503, 'DELETE_INCOMPLETE', 'Share objects remain.');
    await env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(id).run();
}
function patchManifest(m: ShareManifest, b: Record<string, unknown>): ShareManifest {
    const next = { ...m };
    if (b.title !== undefined)
        next.title = text(b.title, 'title', 300, 1);
    if (b.summary !== undefined)
        next.summary = b.summary === null ? null : text(b.summary, 'summary', 5000);
    if (b.durationMs !== undefined)
        next.durationMs = integer(b.durationMs, 'duration', 0, 7 * 24 * 60 * 60 * 1000);
    if (b.poster !== undefined)
        next.poster = asset(b.poster);
    if (b.transcript !== undefined)
        next.transcript = asset(b.transcript);
    if (b.chapters !== undefined) {
        if (!Array.isArray(b.chapters) || b.chapters.length > 500)
            fail(400, 'INVALID_CHAPTERS', 'Too many chapters.');
        next.chapters = (b.chapters as Array<Record<string, unknown>>).map(c => ({ startMs: integer(c?.startMs, 'chapter time', 0, next.durationMs), title: text(c?.title, 'chapter title', 300, 1) }));
    }
    if (b.captions !== undefined) {
        if (!Array.isArray(b.captions) || b.captions.length > 20)
            fail(400, 'INVALID_CAPTIONS', 'Too many captions.');
        next.captions = (b.captions as Array<Record<string, unknown>>).map(c => ({ file: asset(c?.file), lang: text(c?.lang, 'language', 35, 2) }));
    }
    return next;
}
async function writeManifest(env: Env, row: ShareRow, m: ShareManifest): Promise<ShareReservation> { await env.DB.prepare('UPDATE shares SET manifest = ? WHERE id = ?').bind(JSON.stringify(m), row.id).run(); return reservation(env, { ...row, manifest: JSON.stringify(m) }); }
async function responseObject(req: Request, obj: StoredObject, protectedShare: boolean): Promise<Response> { const headers = new Headers({ 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': protectedShare ? 'private,no-store' : 'public,max-age=31536000,immutable' }); obj.writeHttpMetadata(headers); headers.set('Cache-Control', protectedShare ? 'private,no-store' : 'public,max-age=31536000,immutable'); headers.set('ETag', obj.httpEtag); headers.set('Content-Length', String(obj.range?.length ?? obj.size)); let status = 200; if (obj.range) {
    status = 206;
    headers.set('Content-Range', `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`);
} return new Response(req.method === 'HEAD' ? null : obj.body, { status, headers }); }
function parseRange(value: string, size: number): {
    offset: number;
    length: number;
} { const m = /^bytes=(\d*)-(\d*)$/.exec(value); if (!m || (!m[1] && !m[2]))
    fail(416, 'INVALID_RANGE', 'Unsupported byte range.'); let start: number, end: number; if (!m![1]) {
    const suffix = Number(m![2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0)
        fail(416, 'INVALID_RANGE', 'Invalid byte range.');
    start = Math.max(0, size - suffix);
    end = size - 1;
}
else {
    start = Number(m![1]);
    end = m![2] ? Number(m![2]) : size - 1;
} if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start)
    fail(416, 'INVALID_RANGE', 'Invalid byte range.'); end = Math.min(end, size - 1); return { offset: start, length: end - start + 1 }; }
async function route(req: Request, env: Env): Promise<Response> {
    ensureEnv(env);
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === '/health' && req.method === 'GET')
        return json({ ok: true, service: 'rushes-share' });
    if (path === '/_viewer/v1/viewer.js' && req.method === 'GET')
        return new Response(VIEWER_JS, { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'public,max-age=3600' } });
    if (path === '/_viewer/v1/viewer.css' && req.method === 'GET')
        return new Response(VIEWER_CSS, { headers: { 'Content-Type': 'text/css', 'Cache-Control': 'public,max-age=3600' } });
    if (path === '/api/setup/check' && req.method === 'POST') {
        await needOwner(req, env);
        const key = `_probe/${randomID()}`;
        try {
            await env.MEDIA.put(key, 'rushes-probe');
            const r = await env.MEDIA.get(key);
            if (!r || await new Response(r.body).text() !== 'rushes-probe')
                fail(503, 'PROBE_FAILED', 'Storage read-back failed.');
            await env.DB.prepare('SELECT 1 AS ok').first();
        }
        finally {
            await env.MEDIA.delete(key);
        }
        return json({ ok: true, provider: 'worker', checks: ['owner authorization', 'R2 write/read/delete', 'D1 query'] });
    }
    if (path === '/api/shares' && req.method === 'POST') {
        await needOwner(req, env);
        const b = await body(req);
        const id = text(b.id, 'share ID', 22, 22);
        if (!SHARE_ID.test(id))
            fail(400, 'INVALID_ID', 'Invalid share ID.');
        const prior = await env.DB.prepare('SELECT * FROM shares WHERE id = ?').bind(id).first<ShareRow>();
        if (prior)
            return json(reservation(env, prior));
        const now = new Date().toISOString();
        const m: ShareManifest = { schema: 'rushes.share/1', id, status: 'processing', title: text(b.title, 'title', 300, 1), createdAt: now, durationMs: b.durationMs === undefined ? 0 : integer(b.durationMs, 'duration', 0, 604800000) };
        let salt: string | null = null, hash: string | null = null, expiry: string | null = null;
        if (b.password !== undefined) {
            const password = text(b.password, 'password', 1024, 8);
            salt = randomID(16);
            hash = await passwordHash(password, salt);
        }
        if (b.expiresAt !== undefined) {
            expiry = text(b.expiresAt, 'expiry', 50, 1);
            if (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now())
                fail(400, 'INVALID_EXPIRY', 'Expiry must be in the future.');
            expiry = new Date(expiry).toISOString();
        }
        await env.DB.prepare('INSERT INTO shares (id,manifest,expires_at,password_salt,password_hash,created_at) VALUES (?,?,?,?,?,?)').bind(id, JSON.stringify(m), expiry, salt, hash, now).run();
        return json({ id, url: `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/s/${id}`, manifest: m }, 201);
    }
    const api = /^\/api\/shares\/([A-Za-z0-9_-]{22})(.*)$/.exec(path);
    if (api) {
        const id = api[1]!, tail = api[2]!;
        const row = await shareRow(env, id);
        if (tail === '/unlock' && req.method === 'POST') {
            const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
            await rate(env, `unlock:${id}:${await digest(ip)}`, 5);
            const b = await body(req);
            const p = text(b.password, 'password', 1024, 1);
            if (!row.password_hash || !row.password_salt || !equal(await passwordHash(p, row.password_salt), row.password_hash))
                fail(401, 'WRONG_PASSWORD', 'Incorrect password.');
            const token = await signGrant(env.SESSION_SECRET, { kind: 'unlock', id, hash: row.password_hash, exp: Date.now() + 3600000 });
            return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private,no-store', 'Set-Cookie': `rushes_unlock=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600` } });
        }
        if (tail === '' && req.method === 'DELETE') {
            await needOwner(req, env);
            await destroy(env, id);
            return new Response(null, { status: 204 });
        }
        if (tail === '' && req.method === 'PATCH') {
            await needOwner(req, env);
            return json(await writeManifest(env, row, patchManifest(JSON.parse(row.manifest) as ShareManifest, await body(req))));
        }
        if (tail === '/publish' && req.method === 'POST') {
            await needOwner(req, env);
            const b = await body(req);
            const v = b.video as Record<string, unknown> | undefined;
            const file = asset(v?.file);
            if (!file.startsWith('video-'))
                fail(400, 'INVALID_VIDEO', 'Video asset required.');
            const bytes = integer(v?.bytes, 'video bytes', 1, Number(env.MAX_UPLOAD_BYTES ?? 50 * 1024 ** 3));
            const remote = await env.MEDIA.head(`s/${id}/${file}`);
            if (!remote || remote.size !== bytes)
                fail(409, 'VIDEO_NOT_READY', 'Video bytes have not been verified.');
            const { poster: _poster, ...metadata } = b;
            const m = patchManifest(JSON.parse(row.manifest) as ShareManifest, metadata);
            const previous = m.video?.file;
            m.status = 'ready';
            m.video = { file, bytes, width: integer(b.width, 'width', 2, 16384), height: integer(b.height, 'height', 2, 16384) };
            if (b.poster) {
                m.poster = asset((b.poster as Record<string, unknown>).file);
                if (!await env.MEDIA.head(`s/${id}/${m.poster}`))
                    fail(409, 'POSTER_NOT_READY', 'Poster has not been uploaded.');
            }
            const next = await writeManifest(env, row, m);
            if (previous && previous !== file)
                await env.MEDIA.delete(`s/${id}/${previous}`);
            return json(next);
        }
        if (tail === '/views' && req.method === 'GET') {
            await needOwner(req, env);
            const count = await env.DB.prepare('SELECT COUNT(*) AS views FROM plays WHERE share_id = ?').bind(id).first<{
                views: number;
            }>();
            return json({ views: count?.views ?? 0 });
        }
        if (tail === '/play' && req.method === 'POST') {
            await allowed(req, env, row);
            const b = await body(req);
            const session = text(b.session, 'session', 64, 16);
            if (!/^[A-Za-z0-9_-]+$/.test(session))
                fail(400, 'INVALID_SESSION', 'Invalid session.');
            await rate(env, `play:${id}`, 500);
            await env.DB.prepare('INSERT OR IGNORE INTO plays (share_id,session,created_at) VALUES (?,?,?)').bind(id, session, new Date().toISOString()).run();
            return json({ ok: true });
        }
        if (tail === '/feedback' && req.method === 'GET') {
            await allowed(req, env, row);
            const comments = (await env.DB.prepare('SELECT id,name,body,timestamp_ms AS timestampMs,created_at AS createdAt FROM feedback WHERE share_id = ? ORDER BY created_at LIMIT 500').bind(id).all()).results;
            const reactions = (await env.DB.prepare('SELECT kind,COUNT(*) AS count FROM reactions WHERE share_id = ? GROUP BY kind').bind(id).all()).results;
            return json({ comments, reactions });
        }
        if (tail === '/comments' && req.method === 'POST') {
            await allowed(req, env, row);
            await rate(env, `comment:${id}:${await digest(req.headers.get('cf-connecting-ip') ?? 'unknown')}`, 10);
            const b = await body(req);
            const m = JSON.parse(row.manifest) as ShareManifest;
            const comment = { id: randomID(), name: text(b.name, 'name', 80, 1), body: text(b.body, 'comment', 2000, 1), timestampMs: integer(b.timestampMs, 'timestamp', 0, m.durationMs), createdAt: new Date().toISOString() };
            await env.DB.prepare('INSERT INTO feedback (id,share_id,name,body,timestamp_ms,created_at) VALUES (?,?,?,?,?,?)').bind(comment.id, id, comment.name, comment.body, comment.timestampMs, comment.createdAt).run();
            return json(comment, 201);
        }
        if (tail === '/reactions' && req.method === 'POST') {
            await allowed(req, env, row);
            await rate(env, `reaction:${id}`, 100);
            const b = await body(req);
            const kind = text(b.kind, 'reaction', 20, 1), session = text(b.session, 'session', 64, 16);
            if (!['like', 'love', 'celebrate'].includes(kind) || !/^[A-Za-z0-9_-]+$/.test(session))
                fail(400, 'INVALID_REACTION', 'Unsupported reaction/session.');
            await env.DB.prepare('INSERT OR IGNORE INTO reactions (share_id,session,kind) VALUES (?,?,?)').bind(id, session, kind).run();
            return json({ ok: true });
        }
        if (tail === '/uploads' && req.method === 'POST') {
            await needOwner(req, env);
            const b = await body(req);
            const file = asset(b.file);
            const max = Number(env.MAX_UPLOAD_BYTES ?? 50 * 1024 ** 3);
            const bytes = integer(b.bytes, 'bytes', 1, max);
            const type = text(b.contentType, 'content type', 100, 1);
            const expected = file.startsWith('video-') ? 'video/mp4' : file.endsWith('.jpg') ? 'image/jpeg' : file.endsWith('.png') ? 'image/png' : file.endsWith('.vtt') ? 'text/vtt' : 'application/json';
            if (type !== expected)
                fail(415, 'INVALID_TYPE', 'Filename and content type do not match.');
            if (!file.startsWith('video-') && bytes > 20 * 1024 * 1024)
                fail(413, 'TOO_LARGE', 'Sidecar assets are limited to 20 MiB.');
            const sha = text(b.sha256, 'SHA-256', 64, 64);
            if (!/^[a-f0-9]{64}$/.test(sha) || file.split('-')[1]?.slice(0, 8) !== sha.slice(0, 8))
                fail(400, 'INVALID_HASH', 'Asset name must match SHA-256.');
            let u = await env.DB.prepare('SELECT * FROM uploads WHERE share_id = ? AND file = ?').bind(id, file).first<UploadRow>();
            if (u) {
                if (u.bytes !== bytes || u.content_type !== type || u.sha256 !== sha)
                    fail(409, 'UPLOAD_MISMATCH', 'Existing upload does not match.');
                if (u.state === 'complete')
                    return json({ uploadId: u.id, parts: (await parts(env, u.id)).map(p => ({ partNumber: p.part_number, etag: p.etag, size: p.size })) });
            }
            else {
                const multipart = await env.MEDIA.createMultipartUpload(`s/${id}/${file}`, { httpMetadata: { contentType: type, cacheControl: 'public,max-age=31536000,immutable' } });
                const uploadId = randomID();
                try {
                    await env.DB.prepare('INSERT INTO uploads (id,r2_id,share_id,file,bytes,content_type,sha256) VALUES (?,?,?,?,?,?,?)').bind(uploadId, multipart.uploadId, id, file, bytes, type, sha).run();
                }
                catch {
                    await multipart.abort();
                    fail(409, 'UPLOAD_CONFLICT', 'Upload is already being created; retry.');
                }
                u = { id: uploadId, r2_id: multipart.uploadId, share_id: id, file, bytes, content_type: type, sha256: sha, state: 'uploading' };
            }
            return json({ uploadId: u!.id, parts: (await parts(env, u!.id)).map(p => ({ partNumber: p.part_number, etag: p.etag, size: p.size })) });
        }
        const upload = /^\/uploads\/([A-Za-z0-9_-]{22})(.*)$/.exec(tail);
        if (upload) {
            const u = await getUpload(env, id, upload[1]!);
            const action = upload[2]!;
            if (action === '' && req.method === 'DELETE') {
                await needOwner(req, env);
                if (u.state === 'uploading')
                    await env.MEDIA.resumeMultipartUpload(`s/${id}/${u.file}`, u.r2_id).abort();
                await env.DB.prepare('DELETE FROM uploads WHERE id = ?').bind(u.id).run();
                return new Response(null, { status: 204 });
            }
            if (action === '/sign' && req.method === 'POST') {
                await needOwner(req, env);
                if (u.state !== 'uploading')
                    fail(409, 'UPLOAD_COMPLETE', 'Upload is complete.');
                const b = await body(req);
                const n = integer(b.partNumber, 'part number', 1, Math.ceil(u.bytes / PART));
                return json({ token: await signGrant(env.SESSION_SECRET, { kind: 'upload', id, upload: u.id, file: u.file, type: u.content_type, n, bytes: Math.min(PART, u.bytes - (n - 1) * PART), exp: Date.now() + 15 * 60000 }) });
            }
            const part = /^\/parts\/(\d+)$/.exec(action);
            if (part && req.method === 'PUT') {
                if (u.state !== 'uploading')
                    fail(409, 'UPLOAD_COMPLETE', 'Upload is complete.');
                const n = Number(part[1]);
                const token = req.headers.get('authorization')?.replace(/^Upload /, '') ?? '';
                const g = await verifyGrant(env.SESSION_SECRET, token);
                const expected = Math.min(PART, u.bytes - (n - 1) * PART);
                if (g?.kind !== 'upload' || g.id !== id || g.upload !== u.id || g.file !== u.file || g.n !== n || g.type !== u.content_type || g.bytes !== expected || n < 1 || n > Math.ceil(u.bytes / PART))
                    fail(401, 'UPLOAD_SCOPE', 'Invalid upload capability.');
                if (req.headers.get('content-type') !== u.content_type)
                    fail(415, 'INVALID_TYPE', 'Content type mismatch.');
                const data = await bounded(req, expected);
                if (data.byteLength !== expected)
                    fail(400, 'SIZE_MISMATCH', 'Part size does not match the signed upload.');
                const p = await env.MEDIA.resumeMultipartUpload(`s/${id}/${u.file}`, u.r2_id).uploadPart(n, data);
                await env.DB.prepare('INSERT INTO upload_parts (upload_id,part_number,etag,size) VALUES (?,?,?,?) ON CONFLICT(upload_id,part_number) DO UPDATE SET etag=excluded.etag,size=excluded.size').bind(u.id, n, p.etag, expected).run();
                return json({ etag: p.etag, partNumber: n });
            }
            if (action === '/complete' && req.method === 'POST') {
                await needOwner(req, env);
                if (u.state === 'complete')
                    return json({ ok: true });
                const existing = await env.MEDIA.head(`s/${id}/${u.file}`);
                if (existing?.size === u.bytes) {
                    await env.DB.prepare("UPDATE uploads SET state = 'complete' WHERE id = ?").bind(u.id).run();
                    return json({ ok: true, bytes: existing.size });
                }
                const ps = await parts(env, u.id);
                const count = Math.ceil(u.bytes / PART);
                if (ps.length !== count || ps.some((p, i) => p.part_number !== i + 1 || p.size !== Math.min(PART, u.bytes - i * PART)))
                    fail(409, 'PARTS_INCOMPLETE', 'Multipart upload is incomplete.');
                const object = await env.MEDIA.resumeMultipartUpload(`s/${id}/${u.file}`, u.r2_id).complete(ps.map(p => ({ partNumber: p.part_number, etag: p.etag })));
                if (object.size !== u.bytes)
                    fail(409, 'SIZE_MISMATCH', 'Completed object length differs.');
                await env.DB.prepare("UPDATE uploads SET state = 'complete' WHERE id = ?").bind(u.id).run();
                return json({ ok: true, bytes: object.size });
            }
        }
        return fail(404, 'NOT_FOUND', 'Route not found.');
    }
    const publicMatch = /^\/s\/([A-Za-z0-9_-]{22})(?:\/(.*))?$/.exec(path);
    if (publicMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const row = await shareRow(env, publicMatch[1]!);
        const m = JSON.parse(row.manifest) as ShareManifest;
        const file = publicMatch[2];
        if (!file) {
            const shown = row.password_hash ? { ...m, title: 'Protected recording', summary: null, video: undefined, poster: undefined } : m;
            return new Response(req.method === 'HEAD' ? null : viewerPage(shown, env.PUBLIC_BASE_URL, true), { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'private,no-store', 'X-Frame-Options': 'DENY' } });
        }
        await allowed(req, env, row);
        if (file === 'share.json')
            return json(m);
        if (!ASSET_FILE.test(file))
            fail(404, 'NOT_FOUND', 'Asset not found.');
        const key = `s/${row.id}/${file}`;
        const h = await env.MEDIA.head(key);
        if (!h)
            fail(404, 'NOT_FOUND', 'Asset not found.');
        const range = req.headers.get('range');
        try {
            const object = await env.MEDIA.get(key, range ? { range: parseRange(range, h!.size) } : undefined);
            if (!object)
                fail(404, 'NOT_FOUND', 'Asset not found.');
            return responseObject(req, object!, Boolean(row.password_hash));
        }
        catch (e) {
            if (e instanceof HTTPError && e.status === 416)
                return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${h!.size}`, 'Cache-Control': 'no-store' } });
            throw e;
        }
    }
    return fail(404, 'NOT_FOUND', 'Route not found.');
}
export default {
    async fetch(req: Request, env: Env): Promise<Response> {
        const origin = req.headers.get('origin');
        let response: Response;
        try {
            const allowedOrigins = [new URL(env.PUBLIC_BASE_URL).origin, ...(env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean)];
            if (origin && !allowedOrigins.includes(origin))
                fail(403, 'ORIGIN_DENIED', 'Origin is not allowed.');
            if (req.method === 'OPTIONS')
                response = new Response(null, { status: 204 });
            else
                response = await route(req, env);
        }
        catch (e) {
            if (e instanceof HTTPError)
                response = json({ error: { code: e.code, message: e.message } }, e.status);
            else
                response = json({ error: { code: 'INTERNAL_ERROR', message: 'Share service unavailable.' } }, 503);
        }
        const headers = new Headers(response.headers);
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Referrer-Policy', 'same-origin');
        headers.set('Vary', 'Origin');
        if (origin && [new URL(env.PUBLIC_BASE_URL).origin, ...(env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean)].includes(origin)) {
            headers.set('Access-Control-Allow-Origin', origin);
            headers.set('Access-Control-Allow-Credentials', 'true');
            headers.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
            headers.set('Access-Control-Allow-Headers', 'Authorization,Content-Type,Content-Length,Range');
            headers.set('Access-Control-Expose-Headers', 'Content-Range,Content-Length,ETag');
        }
        return new Response(response.body, { status: response.status, headers });
    },
    async scheduled(_event: unknown, env: Env): Promise<void> { const expired = (await env.DB.prepare('SELECT id FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT 500').bind(new Date().toISOString()).all<{
        id: string;
    }>()).results; for (const { id } of expired)
        await destroy(env, id); await env.DB.prepare('DELETE FROM rate_limits WHERE window < ?').bind(Math.floor(Date.now() / 60000) - 60).run(); }
};
