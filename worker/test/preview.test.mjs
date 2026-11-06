import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { environment, ownerOptions } from './fixtures.mjs';
import { WorkerProvider, JsonJobStore } from '../../cloud/dist/index.js';
const ID = 'abcdefghijklmnopqrstuv';

async function served(t) {
    const f = await environment();
    t.after(f.close);
    const server = createServer(async (req, res) => { const chunks = []; for await (const c of req) chunks.push(c); const input = new Request(f.env.PUBLIC_BASE_URL + req.url, { method: req.method, headers: req.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }); const r = await f.worker.fetch(input, f.env); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    f.env.PUBLIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    const dir = await mkdtemp(join(tmpdir(), 'rushes-preview-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const provider = new WorkerProvider({ workerURL: f.env.PUBLIC_BASE_URL, token: f.env.OWNER_TOKEN }, { store: new JsonJobStore(join(dir, 'jobs')), allowLocalHTTP: true });
    const write = async (name, body) => { const path = join(dir, name); await writeFile(path, body); return path; };
    return { f, provider, write };
}

test('Worker stores an optional preview GIF, keeps og:image on the poster and drops stale or missing previews', async t => {
    const { f, provider, write } = await served(t);
    const share = await provider.reserve({ id: ID, title: 'Preview fixture', durationMs: 1500 });
    const video = await provider.upload(share, { path: await write('v.mp4', Buffer.alloc(4096, 1)), kind: 'video' });
    const poster = await provider.upload(share, { path: await write('p.jpg', 'jpeg bytes'), kind: 'poster' });
    const preview = await provider.upload(share, { path: await write('p.gif', 'GIF89a bytes'), kind: 'preview' });
    const ready = await provider.publish(share, { video, poster, preview, width: 320, height: 240, durationMs: 1500 });
    assert.equal(ready.manifest.preview, preview.file);
    const gif = await fetch(`${share.url}/${preview.file}`);
    assert.equal(gif.status, 200); assert.equal(gif.headers.get('content-type'), 'image/gif');
    const page = await (await fetch(share.url)).text();
    assert.ok(page.includes(`<meta property="og:image" content="${share.url}/${poster.file}">`));
    assert.ok(page.includes(`<meta name="rushes:preview" content="${share.url}/${preview.file}">`));
    // A GIF can only be uploaded under a preview name with the GIF content type.
    const wrongType = await f.request(`/api/shares/${ID}/uploads`, ownerOptions(f.env, 'POST', { file: preview.file, bytes: 12, sha256: preview.sha256, contentType: 'image/jpeg' }));
    assert.equal(wrongType.status, 415);
    // Republishing without a preview removes it; an unuploaded preview is skipped, not fatal.
    const without = await provider.publish(ready, { video, poster, width: 320, height: 240, durationMs: 1500 });
    assert.ok(!Object.hasOwn(without.manifest, 'preview'));
    // The superseded GIF is deleted from storage, not just dropped from the manifest.
    assert.equal((await fetch(`${share.url}/${preview.file}`)).status, 404);
    const missing = await provider.publish(without, { video, poster, preview: { ...preview, file: 'preview-00000000.gif' }, width: 320, height: 240, durationMs: 1500 });
    assert.equal(missing.manifest.status, 'ready'); assert.ok(!Object.hasOwn(missing.manifest, 'preview'));
    const misnamed = await f.request(`/api/shares/${ID}/publish`, ownerOptions(f.env, 'POST', { video, width: 320, height: 240, durationMs: 1500, preview: { file: poster.file } }));
    assert.equal(misnamed.status, 400);
});

test('a password-protected share never exposes its preview in the page, embed or oEmbed', async t => {
    const { provider, write } = await served(t);
    const share = await provider.reserve({ id: ID, title: 'Secret fixture', durationMs: 1500, password: 'correct horse battery' });
    const video = await provider.upload(share, { path: await write('v.mp4', Buffer.alloc(4096, 2)), kind: 'video' });
    const poster = await provider.upload(share, { path: await write('p.jpg', 'jpeg secret'), kind: 'poster' });
    const preview = await provider.upload(share, { path: await write('p.gif', 'GIF89a secret'), kind: 'preview' });
    await provider.publish(share, { video, poster, preview, width: 320, height: 240, durationMs: 1500 });
    const page = await (await fetch(share.url)).text();
    assert.ok(!page.includes(preview.file) && !page.includes('rushes:preview'));
    const embed = await (await fetch(share.url.replace('/s/', '/embed/'))).text();
    assert.ok(!embed.includes(preview.file));
    const base = share.url.slice(0, share.url.indexOf('/s/'));
    const oembed = await (await fetch(`${base}/oembed?url=${encodeURIComponent(share.url)}`)).text();
    assert.ok(!oembed.includes(preview.file));
    assert.equal((await fetch(`${share.url}/${preview.file}`)).status, 401);
    assert.equal((await fetch(`${share.url}/share.json`)).status, 401);
});
