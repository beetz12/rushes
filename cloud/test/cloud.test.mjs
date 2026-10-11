import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BucketProvider, JsonJobStore, MemoryJobStore, signV4, sha256, redactURL, viewerPage, deployWorker } from '../dist/index.js';
const ID = 'abcdefghijklmnopqrstuv';
const PART = 10 * 1024 * 1024;
// Published AWS positive vector, not a value derived by this implementation.
// https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html#example-signature-calculations
const credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
test('SigV4 matches the official AWS S3 GET Range positive vector', () => { const signed = signV4({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), region: 'us-east-1', credentials, headers: { Range: 'bytes=0-9' }, now: new Date('2013-05-24T00:00:00Z') }); assert.equal(signed.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'); assert.equal(sha256(signed.canonicalRequest), '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972'); });
test('SigV4 query and URI canonicalization preserve duplicate/slash/UTF8 keys, session token; URLs redact', () => { const s = signV4({ method: 'PUT', url: new URL('https://bucket.example/key//a%20b/%E2%82%AC?z=+&a=*&a=!'), headers: { 'X-Note': '  several   spaces  ' }, region: 'auto', credentials: { ...credentials, sessionToken: 'session-credential' }, body: 'hello', now: new Date('2026-10-11T01:02:03Z') }); assert.ok(s.canonicalRequest.startsWith('PUT\n/key//a%20b/%E2%82%AC\na=%21&a=%2A&z=%20\n')); assert.ok(s.canonicalRequest.includes('x-amz-security-token:session-credential')); assert.equal(s.headers['x-note'], 'several spaces'); assert.equal(redactURL('https://u:secret@bucket.example/a?X-Amz-Signature=private#token'), 'https://bucket.example/a'); });
test('viewer page escapes OG/title and uses same-origin CSP and uncached metadata', () => { const html = viewerPage({ schema: 'rushes.share/1', id: ID, title: '<svg onload="alert(1)">', status: 'ready', createdAt: '2026-10-11', durationMs: 1, summary: '<script>x</script>', video: { file: 'video-abcdef12.mp4', width: 2, height: 2, bytes: 1 }, poster: 'poster-abcdef12.jpg' }, 'https://share.example'); assert.ok(!html.includes('<svg')); assert.ok(html.includes('&lt;svg onload=&quot;')); assert.ok(html.includes("script-src 'self'")); assert.ok(html.includes('og:video')); assert.ok(html.includes('poster-abcdef12.jpg')); });
async function fixture(t) {
    const objects = new Map(), sessions = new Map();
    const uploads = [], manifestWrites = [];
    let aborts = 0, failPart = 0, nonce = 0;
    const metadata = new Map();
    const server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const chunks = [];
        for await (const c of req)
            chunks.push(c);
        const bytes = Buffer.concat(chunks);
        const signed = url.pathname.startsWith('/recordings');
        let key = decodeURIComponent(signed ? url.pathname.slice('/recordings/'.length) : url.pathname.slice(1));
        if (url.pathname === '/recordings')
            key = '';
        const send = (code, body = '', headers = {}) => { res.writeHead(code, headers); res.end(req.method === 'HEAD' ? undefined : body); };
        if (signed && !req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 '))
            return send(401);
        if (!signed && !key)
            return send(403);
        if (signed && url.searchParams.has('list-type')) {
            const prefix = url.searchParams.get('prefix') ?? '';
            return send(200, '<ListBucketResult>' + [...objects.keys()].filter(k => k.startsWith(prefix)).map(k => `<Contents><Key>${k}</Key></Contents>`).join('') + '<IsTruncated>false</IsTruncated></ListBucketResult>');
        }
        if (signed && req.method === 'POST' && url.searchParams.has('uploads')) {
            const id = 'upload' + (++nonce);
            sessions.set(id, { key, parts: new Map() });
            metadata.set(key, req.headers['content-type']);
            return send(200, `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
        }
        if (signed && url.searchParams.has('uploadId')) {
            const id = url.searchParams.get('uploadId'), session = sessions.get(id);
            if (req.method === 'DELETE') {
                aborts++;
                sessions.delete(id);
                return send(204);
            }
            if (!session)
                return send(404);
            if (req.method === 'GET')
                return send(200, '<ListPartsResult>' + [...session.parts].map(([n, p]) => `<Part><PartNumber>${n}</PartNumber><ETag>${p.etag}</ETag><Size>${p.bytes.length}</Size></Part>`).join('') + '<IsTruncated>false</IsTruncated></ListPartsResult>');
            if (req.method === 'PUT') {
                const n = Number(url.searchParams.get('partNumber'));
                uploads.push(n);
                if (failPart === n)
                    return send(500);
                const etag = '"' + createHash('md5').update(bytes).digest('hex') + '"';
                session.parts.set(n, { bytes, etag });
                return send(200, '', { ETag: etag });
            }
            if (req.method === 'POST') {
                const numbers = [...bytes.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(m => Number(m[1]));
                if (numbers.some(n => !session.parts.has(n)))
                    return send(200, '<Error><Code>InvalidPart</Code></Error>');
                objects.set(key, Buffer.concat(numbers.map(n => session.parts.get(n).bytes)));
                sessions.delete(id);
                return send(200, '<CompleteMultipartUploadResult/>');
            }
        }
        if (signed && req.method === 'PUT') {
            if(key.endsWith('/share.json'))manifestWrites.push(JSON.parse(bytes.toString()));
            objects.set(key, bytes);
            metadata.set(key, req.headers['content-type']);
            return send(200, '', { ETag: '"fixture"' });
        }
        if (signed && req.method === 'DELETE') {
            objects.delete(key);
            return send(204);
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
            const data = objects.get(key);
            if (!data)
                return send(404);
            if (req.headers.range) {
                const [start, end] = req.headers.range.replace('bytes=', '').split('-').map(Number);
                return send(206, data.subarray(start, end + 1), { 'Content-Type': metadata.get(key) ?? 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' });
            }
            return send(200, data, { 'Content-Length': String(data.length), 'Content-Type': metadata.get(key) ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' });
        }
        return send(404);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const dir = await mkdtemp(join(tmpdir(), 'rushes-bucket-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new JsonJobStore(join(dir, 'jobs'));
    const provider = () => new BucketProvider({ endpoint: base, region: 'auto', bucket: 'recordings', publicBaseURL: base, ...credentials }, { store, allowLocalHTTP: true, viewerAssets: { js: 'export {};', css: 'body{background:#222}' } });
    return { objects, sessions, uploads, manifestWrites, dir, store, base, provider, setFailPart: n => failPart = n, get aborts() { return aborts; } };
}
test('actual HTTP bucket processing link, small PUT, stable republish, private state, enrichment, range, unshare', async (t) => { const f = await fixture(t); const p = f.provider(); assert.equal((await p.setupCheck()).ok, true); const s = await p.reserve({ id: ID, title: 'Actual fixture', durationMs: 1000 }); assert.equal((await fetch(s.url)).status, 200); assert.equal((await (await fetch(s.url + '/share.json')).json()).status, 'processing'); const path = join(f.dir, 'video.mp4'); await writeFile(path, Buffer.from('small mp4 fixture')); const asset = await p.upload(s, { path, kind: 'video' }); let ready = await p.publish(s, { video: asset, width: 320, height: 240, durationMs: 1000 }); assert.equal(ready.url, s.url); assert.equal((await (await fetch(s.url + '/share.json')).json()).status, 'ready'); const r = await fetch(s.url + '/' + asset.file, { headers: { Range: 'bytes=0-4' } }); assert.equal(r.status, 206); assert.equal(await r.text(), 'small'); ready = await p.updateMetadata(ready, { summary: 'A summary', chapters: [{ startMs: 0, title: 'Start' }] }); assert.equal((await (await fetch(s.url + '/share.json')).json()).summary, 'A summary'); const state = await readFile(join(f.dir, 'jobs', ID + '.json'), 'utf8'); assert.ok(!state.includes(credentials.secretAccessKey)); assert.ok(!state.includes(credentials.accessKeyId)); assert.equal((await stat(join(f.dir, 'jobs', ID + '.json'))).mode & 0o777, 0o600); assert.equal((await p.reserve({ id: ID, title: 'Same recording' })).url, s.url); await p.delete(ready); assert.equal((await fetch(s.url)).status, 404); assert.ok(![...f.objects.keys()].some(k => k.startsWith('s/' + ID))); });
test('multipart resumes saved part after simulated crash, reconciles remote evidence, uploads only missing parts', async (t) => { const f = await fixture(t); const p = f.provider(); const s = await p.reserve({ id: ID, title: 'Resume fixture' }); const bytes = Buffer.alloc(PART * 2 + 1234, 0x41); const path = join(f.dir, 'resume.mp4'); await writeFile(path, bytes); const hash = createHash('sha256').update(bytes).digest('hex'); const file = `video-${hash.slice(0, 8)}.mp4`; const key = `s/${ID}/${file}`; const first = bytes.subarray(0, PART); const etag = '"' + createHash('md5').update(first).digest('hex') + '"'; f.sessions.set('crashed-upload', { key, parts: new Map([[1, { bytes: first, etag }]]) }); await f.store.write(ID, { reservation: s, uploads: { [file]: { key, sha256: hash, size: bytes.length, uploadId: 'crashed-upload', parts: { '1': etag, '2': 'unconfirmed-etag' }, provider: f.base + '/recordings' } } }); const progress = []; const uploaded = await f.provider().upload(s, { path, kind: 'video', onProgress: p => progress.push(p) }); assert.equal(uploaded.bytes, bytes.length); assert.deepEqual(f.uploads.sort(), [2, 3]); assert.equal(progress[0].skippedParts, 1); assert.equal(f.objects.get(key).length, bytes.length); assert.deepEqual(f.objects.get(key), bytes); assert.equal((await f.store.read(ID)).uploads[file].completed, true); });
test('multipart exhausted part retries abort remotely and do not publish ready', async (t) => { const f = await fixture(t); const p = f.provider(); const s = await p.reserve({ id: ID, title: 'Failure fixture' }); const path = join(f.dir, 'failure.mp4'); await writeFile(path, Buffer.alloc(PART + 123, 0x42)); f.setFailPart(2); await assert.rejects(() => p.upload(s, { path, kind: 'video' }), e => e.code === 'BUCKET_HTTP'); assert.equal(f.uploads.filter(n => n === 2).length, 3); assert.equal(f.aborts, 1); assert.equal(f.sessions.size, 0); assert.equal((await (await fetch(s.url + '/share.json')).json()).status, 'processing'); });
test('unreachable processing page never reports reserved success, including saved retry', async (t) => { const f = await fixture(t); const bad = new BucketProvider({ endpoint: f.base, region: 'auto', bucket: 'recordings', publicBaseURL: f.base + '/wrong', ...credentials }, { store: f.store, allowLocalHTTP: true, viewerAssets: { js: '', css: '' } }); await assert.rejects(() => bad.reserve({ id: ID, title: 'Private bucket' }), e => e.code === 'PUBLIC_UNREACHABLE'); await assert.rejects(() => bad.reserve({ id: ID, title: 'Retry private bucket' }), e => e.code === 'PUBLIC_UNREACHABLE'); });
test('deploy preflight R2-disabled has actionable selected-account error and performs no writes', async () => { const calls = []; const accountId = 'a'.repeat(32); await assert.rejects(() => deployWorker({ accountId, apiToken: 'fake-supplied-token', workerName: 'rushes-share', bucketName: 'rushes-media', databaseName: 'rushes-share', workersSubdomain: 'fixture-user', script: 'export default {}', schemaSQL: 'SELECT 1;' }, async (url, options) => { calls.push({ url, method: options.method }); return Response.json({ success: false, errors: [{ code: 10042, message: 'Enable R2' }] }, { status: 400 }); }), e => e.code === 'R2_NOT_ENABLED' && e.message.includes(accountId) && e.message.includes('Dashboard')); assert.deepEqual(calls.map(c => c.method), ['GET']); });
test('private job serialization projects manifest fields and refuses filename traversal', async (t) => { const f = await fixture(t); const store = f.store; await store.write(ID, { reservation: { id: ID, url: f.base + '/s/' + ID, manifest: { schema: 'rushes.share/1', id: ID, title: 'Projection', createdAt: new Date().toISOString(), durationMs: 1, status: 'processing', secretAccessKey: 'do-not-persist', password: 'do-not-persist' } }, uploads: {} }); const raw = await readFile(join(f.dir, 'jobs', ID + '.json'), 'utf8'); assert.ok(!raw.includes('do-not-persist')); await assert.rejects(() => store.read('../../escape')); const p = f.provider(); const share = await p.reserve({ id: 'zyxwvutsrqponmlkjihgfe', title: 'Metadata' }); await assert.rejects(() => p.updateMetadata(share, { transcript: '../../private.json' }), e => e.code === 'INVALID_ASSET'); const next = await p.updateMetadata(share, { title: 'Safe fields', secretAccessKey: 'do-not-persist' }); assert.equal(next.manifest.secretAccessKey, undefined); assert.ok(!(await readFile(join(f.dir, 'jobs', next.id + '.json'), 'utf8')).includes('do-not-persist')); });
test('deployment applies selected-account bindings/schema/cron and requires actual health/probe responses', async () => {
    const calls = [];
    const accountId = 'b'.repeat(32);
    const ownerToken = 'fixture-owner-token-'.padEnd(40, 'x');
    const sessionSecret = 'fixture-session-secret-'.padEnd(40, 'x');
    const result = await deployWorker({ accountId, apiToken: 'fixture-oauth-in-memory', workerName: 'rushes-share', bucketName: 'rushes-media', databaseName: 'rushes-share', workersSubdomain: 'fixture-user', script: 'export default {}', schemaSQL: 'CREATE TABLE fixtures(id TEXT);', ownerToken, sessionSecret }, async (url, options = {}) => {
        const path = new URL(url).pathname;
        calls.push({ url, method: options.method, body: options.body });
        if (path === '/health')
            return Response.json({ ok: true });
        if (path === '/api/setup/check') {
            assert.equal(options.headers.Authorization, 'Bearer ' + ownerToken);
            return Response.json({ ok: true });
        }
        if (path.endsWith('/workers/subdomain') && options.method === 'GET')
            return Response.json({ success: true, result: { subdomain: 'fixture-user' } });
        if (path.endsWith('/r2/buckets') && options.method === 'GET')
            return Response.json({ success: true, result: { buckets: [] } });
        if (path.endsWith('/d1/database') && options.method === 'GET')
            return Response.json({ success: true, result: [] });
        if (path.endsWith('/d1/database') && options.method === 'POST')
            return Response.json({ success: true, result: { uuid: 'fixture-database-id' } });
        return Response.json({ success: true, result: {} });
    });
    assert.equal(result.accountId, accountId);
    assert.equal(result.ownerToken, ownerToken);
    assert.equal(result.workerURL, 'https://rushes-share.fixture-user.workers.dev');
    const worker = calls.find(c => c.url.endsWith('/workers/scripts/rushes-share'));
    assert.equal(worker.method, 'PUT');
    const metadata = JSON.parse(await worker.body.get('metadata').text());
    assert.equal(metadata.main_module, 'worker.js');
    assert.ok(metadata.bindings.some(b => b.name === 'MEDIA' && b.bucket_name === 'rushes-media'));
    assert.ok(metadata.bindings.some(b => b.name === 'DB' && b.id === 'fixture-database-id'));
    const cron = calls.find(c => c.url.endsWith('/schedules'));
    assert.deepEqual(JSON.parse(cron.body), [{ cron: '0 3 * * *' }]);
    assert.ok(result.checks.includes('storage/database probe'));
});
test('encrypted bootstrap projects secrets, verifies Keychain readback, authenticates metadata and cleans only its key/file', async (t) => {
    const { createBootstrap, readBootstrap, removeBootstrap } = await import('../dist/index.js');
    const dir = await mkdtemp(join(tmpdir(), 'rushes-bootstrap-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const keys = new Map();
    const keychain = { async add(a, k) { keys.set(a, k); }, async read(a) {
            if (!keys.has(a))
                throw new Error('not found');
            return keys.get(a);
        }, async remove(a) { keys.delete(a); } };
    const secrets = { ownerToken: 'fixture-owner-secret-'.padEnd(40, 'x'), sessionSecret: 'fixture-session-secret-'.padEnd(40, 'x') };
    const metadata = { accountId: 'a'.repeat(32), workerName: 'rushes-share', bucketName: 'rushes-media', databaseName: 'rushes-share', workerURL: 'https://rushes.example' };
    const path = join(dir, 'bootstrap.enc.json');
    await createBootstrap(path, secrets, metadata, keychain);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const data = await readFile(path, 'utf8');
    assert.ok(!data.includes(secrets.ownerToken));
    assert.ok(!data.includes(secrets.sessionSecret));
    assert.deepEqual(await readBootstrap(path, keychain), { secrets, metadata });
    const altered = JSON.parse(data);
    altered.metadata.workerURL = 'https://attacker.example';
    await writeFile(path, JSON.stringify(altered));
    await assert.rejects(() => readBootstrap(path, keychain), e => e.code === 'BOOTSTRAP_AUTH_FAILED');
    await writeFile(path, data);
    await removeBootstrap(path, keychain);
    assert.equal(keys.size, 0);
    await assert.rejects(() => stat(path), { code: 'ENOENT' });
    const broken = { ...keychain, async read() { return '00'.repeat(32); } };
    await assert.rejects(() => createBootstrap(path, secrets, metadata, broken), e => e.code === 'KEYCHAIN_READBACK');
    assert.equal(keys.size, 0);
    await assert.rejects(() => stat(path), { code: 'ENOENT' });
});
test('same-user private socket imports credentials in memory then separately reads encrypted persisted settings', async (t) => {
    const { createServer } = await import('node:net');
    const { chmod } = await import('node:fs/promises');
    const { configureThroughSocket, cloudSocketAvailable } = await import('../dist/index.js');
    const dir = await mkdtemp(join(tmpdir(), 'rushes-secure-import-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'shell.sock'), commands = [];
    let saved;
    const server = createServer(socket => {
        let input = '';
        socket.on('data', chunk => {
            input += chunk.toString();
            const n = input.indexOf('\n');
            if (n < 0)
                return;
            const request = JSON.parse(input.slice(0, n));
            commands.push(request.cmd);
            if (request.cmd === 'share.configure')
                saved = { provider: request.args.provider, endpoint: request.args.workerURL, accountId: request.args.accountId, configured: true, encrypted: true };
            socket.end(JSON.stringify({ id: request.id, ok: true, result: saved }) + '\n');
        });
    });
    server.listen(path);
    await once(server, 'listening');
    await chmod(path, 0o600);
    t.after(() => server.close());
    const metadata = { accountId: 'a'.repeat(32), workerName: 'rushes-share', bucketName: 'rushes-media', databaseName: 'rushes-share', workerURL: 'https://rushes.example' };
    const secrets = { ownerToken: 'fixture-token'.padEnd(40, 'x'), sessionSecret: 'fixture-session'.padEnd(40, 'x') };
    const result = await configureThroughSocket(path, metadata, secrets);
    assert.deepEqual(commands, ['share.configure', 'share.configuration']);
    assert.equal(result.endpoint, metadata.workerURL);
    assert.equal(result.token, undefined);
    await chmod(path, 0o666);
    await assert.rejects(() => cloudSocketAvailable(path), e => e.code === 'SOCKET_PERMISSIONS');
    assert.equal(await cloudSocketAvailable(join(dir, 'missing.sock')), false);
});
test('deployment creates only an absent explicitly selected account subdomain and never renames existing', async () => { const base = { accountId: 'c'.repeat(32), apiToken: 'fixture', workerName: 'rushes-share', bucketName: 'rushes-media', databaseName: 'rushes-share', workersSubdomain: 'selected-public-name', script: 'export default {}', schemaSQL: 'SELECT 1;' }; const writes = []; await assert.rejects(() => deployWorker(base, async (url, options) => { const path = new URL(url).pathname; if (options.method !== 'GET')
    writes.push({ path, method: options.method, body: options.body }); if (path.endsWith('/workers/subdomain') && options.method === 'GET')
    return Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 }); if (path.endsWith('/workers/subdomain') && options.method === 'PUT')
    return Response.json({ success: true, result: { subdomain: 'selected-public-name' } }); if (path.endsWith('/r2/buckets') && options.method === 'GET')
    return Response.json({ success: true, result: { buckets: [{ name: 'rushes-media' }] } }); return Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 }); }), e => e.code === 'CLOUDFLARE_API'); assert.deepEqual(writes, [{ path: '/client/v4/accounts/' + base.accountId + '/workers/subdomain', method: 'PUT', body: '{"subdomain":"selected-public-name"}' }]); const renameWrites = []; await assert.rejects(() => deployWorker(base, async (url, options) => { if (options.method !== 'GET')
    renameWrites.push(url); return Response.json({ success: true, result: new URL(url).pathname.endsWith('/workers/subdomain') ? { subdomain: 'existing-public-name' } : { buckets: [] } }); }), e => e.code === 'SUBDOMAIN_MISMATCH'); assert.deepEqual(renameWrites, []); });
test('bucket ready republish atomically replaces video plus edited metadata and nullable transcript clears stale references', async t => {
    const f = await fixture(t), p = f.provider();
    const reservation = await p.reserve({id:ID,title:'Original snapshot',durationMs:2000});
    const upload = async(kind,label,body) => {
        const extension={video:'mp4',captions:'vtt',transcript:'json'}[kind];
        const path=join(f.dir,`${label}.${extension}`); await writeFile(path,body); return p.upload(reservation,{kind,path});
    };
    const oldVideo=await upload('video','old-video','original video'),oldCaptions=await upload('captions','old-captions','WEBVTT\n\noriginal captions'),oldTranscript=await upload('transcript','old-transcript','{"cues":[{"text":"original"}]}');
    const old=await p.publish(reservation,{video:oldVideo,width:320,height:240,durationMs:2000,title:'Original snapshot',summary:'Original summary',chapters:[{startMs:0,title:'Original chapter'}],captions:[{file:oldCaptions.file,lang:'en'}],transcript:oldTranscript.file});
    const newVideo=await upload('video','new-video','edited video'),newCaptions=await upload('captions','new-captions','WEBVTT\n\nedited captions'),newTranscript=await upload('transcript','new-transcript','{"cues":[{"text":"edited"}]}');
    const before=f.manifestWrites.length;
    const next=await p.publish(old,{video:newVideo,width:320,height:240,durationMs:1000,title:'Edited snapshot',summary:'Edited summary',chapters:[{startMs:0,title:'Edited chapter'}],captions:[{file:newCaptions.file,lang:'en'}],transcript:newTranscript.file});
    assert.equal(next.url,old.url);assert.equal(f.manifestWrites.length,before+1);
    const visible=f.manifestWrites.at(-1);assert.equal(visible.status,'ready');assert.equal(visible.video.file,newVideo.file);assert.equal(visible.title,'Edited snapshot');assert.equal(visible.summary,'Edited summary');assert.deepEqual(visible.chapters,[{startMs:0,title:'Edited chapter'}]);assert.deepEqual(visible.captions,[{file:newCaptions.file,lang:'en'}]);assert.equal(visible.transcript,newTranscript.file);assert.ok(!f.objects.has(`s/${ID}/${oldVideo.file}`));
    const published=await(await fetch(next.url+'/share.json')).json();assert.deepEqual(published,visible);
    const cleared=await p.publish(next,{video:newVideo,width:320,height:240,durationMs:1000,summary:null,chapters:[],captions:[],transcript:null});
    assert.ok(!Object.hasOwn(cleared.manifest,'transcript'));assert.deepEqual(cleared.manifest.captions,[]);assert.equal(cleared.manifest.summary,null);assert.ok(!Object.hasOwn((await(await fetch(next.url+'/share.json')).json()),'transcript'));
    const enriched=await p.updateMetadata(cleared,{transcript:newTranscript.file});assert.equal(enriched.manifest.transcript,newTranscript.file);
    const removed=await p.updateMetadata(enriched,{transcript:null});assert.ok(!Object.hasOwn(removed.manifest,'transcript'));assert.ok(!Object.hasOwn((await f.store.read(ID)).reservation.manifest,'transcript'));
    const failedBefore=f.manifestWrites.length;
    await assert.rejects(()=>p.publish(removed,{video:newVideo,width:320,height:240,durationMs:1000,transcript:'transcript-ffffffff.json'}),e=>e.code==='BUCKET_HTTP'&&e.status===404);
    assert.equal(f.manifestWrites.length,failedBefore);assert.deepEqual(await(await fetch(next.url+'/share.json')).json(),removed.manifest);
});
