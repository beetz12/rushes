import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp as newFixtureDirectory, writeFile as writeFixtureBytes, readFile as readFixtureText, readdir as fixtureEntries, rm as removeFixtureDirectory } from 'node:fs/promises';
import { tmpdir as fixtureTempRoot } from 'node:os';
import { join as fixturePath } from 'node:path';
import { environment, ownerOptions } from './fixtures.mjs';
import { WorkerProvider, JsonJobStore } from '../../cloud/dist/index.js';

const ID = 'abcdefghijklmnopqrstuv';
const future = () => new Date(Date.now() + 3600000).toISOString();
async function reserve(f, input = {}) {
    const response = await f.request('/api/shares', ownerOptions(f.env, 'POST', { id: ID, title: 'Policy fixture', durationMs: 120000, ...input }));
    assert.equal(response.status, 201);
    return response.json();
}
async function currentRow(f) {
    return f.env.DB.prepare('SELECT * FROM shares WHERE id = ?').bind(ID).first();
}
async function unlock(f, password, ip = 'policy-fixture') {
    const response = await f.request(`/api/shares/${ID}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ password }) });
    assert.equal(response.status, 200);
    return response.headers.get('Set-Cookie').split(';')[0];
}

test('policy routes require owner and configured origin, validate atomically and preserve initial reservation', async t => {
    const f = await environment(); t.after(f.close);
    const expiresAt = future();
    const reservation = await reserve(f, { password: 'original fixture password', expiresAt });
    const path = `/api/shares/${ID}/policy`;
    const before = await currentRow(f);
    const get = await f.request(path, ownerOptions(f.env, 'GET'));
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await get.json(), { protected: true, expiresAt });
    const cookie = await unlock(f, 'original fixture password');
    for (const headers of [{}, { Cookie: cookie }, { Authorization: 'Bearer incorrect-owner-token' }]) {
        assert.equal((await f.request(path, { headers })).status, 401);
        assert.equal((await f.request(path, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"password":null}' })).status, 401);
    }
    const denied = { ...ownerOptions(f.env, 'PATCH', { password: null }), headers: { ...ownerOptions(f.env).headers, Origin: 'https://unapproved.example' } };
    assert.equal((await f.request(path, denied)).status, 403);
    assert.equal((await f.request(path, { ...ownerOptions(f.env, 'GET'), headers: { ...ownerOptions(f.env).headers, Origin: 'https://unapproved.example' } })).status, 403);
    const options = await f.request(path, { method: 'OPTIONS', headers: { Origin: f.env.PUBLIC_BASE_URL } });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('Access-Control-Allow-Origin'), f.env.PUBLIC_BASE_URL);
    assert.ok(options.headers.get('Access-Control-Allow-Methods').includes('PATCH'));

    let writes = 0;
    const prepare = f.env.DB.prepare.bind(f.env.DB);
    f.env.DB.prepare = sql => { const statement = prepare(sql); if (sql.startsWith('UPDATE shares')) { const run = statement.run.bind(statement); statement.run = async () => { writes++; return run(); }; } return statement; };
    for (const patch of [
        { password: 'replacement fixture password', expiresAt: 'tomorrow' },
        { password: 'replacement fixture password', expiresAt: new Date(Date.now() - 1000).toISOString() },
        { password: 'replacement fixture password', expiresAt: '2099-02-30T12:00:00Z' },
        { password: 'replacement fixture password', expiresAt: '2099-01-01' },
        { password: 'replacement fixture password', expiresAt: '2099-01-01T24:00:00Z' },
        { password: '', expiresAt: future() }, { password: 'short', expiresAt: null },
        { password: 'a'.repeat(1025), expiresAt: future() },
        { password: 123456789, expiresAt: null }, { password: null, expiresAt: {} },
        { password_hash: 'injected', password: null }
    ]) {
        const response = await f.request(path, ownerOptions(f.env, 'PATCH', patch));
        assert.equal(response.status, 400, JSON.stringify(patch));
        assert.deepEqual(await currentRow(f), before);
    }
    assert.equal(writes, 0);
    assert.deepEqual(await (await f.request(path, ownerOptions(f.env, 'PATCH', {}))).json(), { protected: true, expiresAt });
    assert.equal(writes, 0);
    // Idempotent reserve retains the original policy instead of overwriting it.
    const duplicate = await f.request('/api/shares', ownerOptions(f.env, 'POST', { id: ID, title: 'Changed input', password: 'ignored replacement password', expiresAt: future() }));
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).url, reservation.url);
    assert.deepEqual(await currentRow(f), before);
});

test('policy rotation and removal revoke prior unlock grants, preserve ready video/captions and hide expired shares', async t => {
    const f = await environment(); t.after(f.close);
    const directory = await newFixtureDirectory(fixturePath(fixtureTempRoot(), 'rushes-policy-assets-')); t.after(() => removeFixtureDirectory(directory, { recursive: true, force: true }));
    const provider = new WorkerProvider({ workerURL: f.env.PUBLIC_BASE_URL, token: f.env.OWNER_TOKEN }, { fetch: (url, options = {}) => f.worker.fetch(new Request(url, options), f.env) });
    const expiresAt = future();
    const share = await provider.reserve({ id: ID, title: 'Ready policy fixture', durationMs: 120000, password: 'original fixture password', expiresAt });
    const upload = async (kind, extension, content) => { const path = fixturePath(directory, `fixture.${extension}`); await writeFixtureBytes(path, content); return provider.upload(share, { kind, path }); };
    const video = await upload('video', 'mp4', 'controlled video bytes');
    const captions = await upload('captions', 'vtt', 'WEBVTT\n\n00:00.000 --> 00:01.000\nControlled caption');
    const ready = await provider.publish(share, { video, width: 320, height: 240, durationMs: 120000, captions: [{ file: captions.file, lang: 'en' }] });
    const before = await currentRow(f);
    const firstCookie = await unlock(f, 'original fixture password');
    const payload = Buffer.from(firstCookie.slice('rushes_unlock='.length).split('.')[0], 'base64url').toString();
    for (const privateValue of ['original fixture password', before.password_salt, before.password_hash]) assert.ok(!payload.includes(privateValue));
    const grant = JSON.parse(payload);
    assert.equal(typeof grant.revision, 'string'); assert.equal(grant.hash, undefined);
    assert.equal((await f.request(`/s/${ID}/${video.file}`, { headers: { Cookie: firstCookie } })).status, 200);

    const rotate = await f.request(`/api/shares/${ID}/policy`, ownerOptions(f.env, 'PATCH', { password: 'replacement fixture password' }));
    assert.equal(rotate.status, 200);
    assert.deepEqual(await rotate.json(), { protected: true, expiresAt });
    const rotated = await currentRow(f);
    assert.notEqual(rotated.password_salt, before.password_salt); assert.notEqual(rotated.password_hash, before.password_hash);
    assert.equal(rotated.manifest, before.manifest);
    assert.equal((await f.request(`/s/${ID}/${video.file}`, { headers: { Cookie: firstCookie } })).status, 401);
    assert.equal((await f.request(`/api/shares/${ID}/feedback`, { headers: { Cookie: firstCookie } })).status, 401);
    const secondCookie = await unlock(f, 'replacement fixture password');
    const manifest = await (await f.request(`/s/${ID}/share.json`, { headers: { Cookie: secondCookie } })).json();
    assert.deepEqual(manifest, ready.manifest); assert.equal(ready.url, share.url);
    assert.equal((await f.request(`/s/${ID}/${captions.file}`, { headers: { Cookie: secondCookie } })).status, 200);

    assert.deepEqual(await provider.updatePolicy(ID, { password: null }), { protected: false, expiresAt });
    const publicRow = await currentRow(f);
    assert.equal(publicRow.password_hash, null); assert.equal(publicRow.password_salt, null);
    assert.deepEqual(await (await f.request(`/s/${ID}/share.json`)).json(), ready.manifest);
    await provider.updatePolicy(ID, { password: 'replacement fixture password', expiresAt: null });
    assert.deepEqual(await provider.getPolicy(ID), { protected: true, expiresAt: null });
    assert.equal((await f.request(`/s/${ID}/share.json`, { headers: { Cookie: secondCookie } })).status, 401);
    const lastCookie = await unlock(f, 'replacement fixture password', 'final-unlock-fixture');
    assert.equal((await f.request(`/s/${ID}/share.json`, { headers: { Cookie: lastCookie } })).status, 200);
    await provider.updatePolicy(ID, { expiresAt });
    assert.deepEqual(await provider.getPolicy(ID), { protected: true, expiresAt });
    assert.equal((await currentRow(f)).manifest, before.manifest);
    // A controlled clock boundary emulates passage of the accepted future expiry.
    await f.env.DB.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), ID).run();
    assert.equal((await f.request(share.url.replace(f.env.PUBLIC_BASE_URL, ''))).status, 404);
    assert.equal((await f.request(`/s/${ID}/${video.file}`, { headers: { Cookie: lastCookie } })).status, 404);
    await f.worker.scheduled({}, f.env);
    assert.equal(await currentRow(f), null); assert.equal(f.env.MEDIA.objects.size, 0);
});

test('WorkerProvider policy and combined feedback use actual controlled HTTP without changing durable jobs', async t => {
    const f = await environment(); t.after(f.close);
    const calls = [];
    const server = createServer(async (req, res) => {
        calls.push({ path: req.url, method: req.method, authorized: req.headers.authorization === `Bearer ${f.env.OWNER_TOKEN}` });
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await f.worker.fetch(new Request(f.env.PUBLIC_BASE_URL + req.url, { method: req.method, headers: req.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }), f.env);
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
    f.env.PUBLIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    const directory = await newFixtureDirectory(fixturePath(fixtureTempRoot(), 'rushes-owner-http-')); t.after(() => removeFixtureDirectory(directory, { recursive: true, force: true }));
    const jobs = fixturePath(directory, 'jobs');
    const provider = new WorkerProvider({ workerURL: f.env.PUBLIC_BASE_URL, token: f.env.OWNER_TOKEN }, { allowLocalHTTP: true, store: new JsonJobStore(jobs) });
    const expiresAt = future();
    const share = await provider.reserve({ id: ID, title: 'HTTP owner fixture', durationMs: 120000, password: 'initial transient password', expiresAt });
    const durableBefore = await readFixtureText(fixturePath(jobs, `${ID}.json`), 'utf8');
    assert.deepEqual(await provider.getPolicy(ID), { protected: true, expiresAt });
    assert.deepEqual(await provider.updatePolicy(ID, { password: 'updated transient password', expiresAt: null, token: 'discarded extra field' }), { protected: true, expiresAt: null });
    await assert.rejects(() => provider.updatePolicy(ID, { password: null, expiresAt: 'invalid' }), e => e.code === 'WORKER_HTTP' && e.status === 400);
    assert.deepEqual(await provider.getPolicy(ID), { protected: true, expiresAt: null });
    assert.deepEqual(await provider.feedback(ID), { views: 0, comments: [], reactions: [] });
    const post = async (tail, body) => {
        const response = await fetch(`${f.env.PUBLIC_BASE_URL}/api/shares/${ID}/${tail}`, ownerOptions(f.env, 'POST', body));
        assert.ok(response.ok); return response.json();
    };
    for (let n = 0; n < 3; n++) await post('play', { session: 'same-http-playback-session' });
    const comment = await post('comments', { name: 'Fixture viewer', body: 'Look at this moment', timestampMs: 83000 });
    for (let n = 0; n < 2; n++) await post('reactions', { session: 'same-http-playback-session', kind: 'celebrate' });
    const feedback = await provider.feedback(ID);
    assert.deepEqual(feedback, { views: 1, comments: [comment], reactions: [{ kind: 'celebrate', count: 1 }] });
    const ownerPaths = ['/policy', '/views', '/feedback'];
    assert.ok(calls.filter(c => ownerPaths.some(suffix => c.path.endsWith(suffix))).every(c => c.authorized));
    const badOwner = new WorkerProvider({ workerURL: f.env.PUBLIC_BASE_URL, token: 'wrong-owner-'.padEnd(40, 'x') }, { allowLocalHTTP: true });
    await assert.rejects(() => badOwner.getPolicy(ID), e => e.code === 'WORKER_HTTP' && e.status === 401);
    await assert.rejects(() => badOwner.updatePolicy(ID, { password: null }), e => e.code === 'WORKER_HTTP' && e.status === 401);
    await assert.rejects(() => badOwner.feedback(ID), e => e.code === 'WORKER_HTTP' && e.status === 401);
    assert.equal(await readFixtureText(fixturePath(jobs, `${ID}.json`), 'utf8'), durableBefore);
    assert.deepEqual(await fixtureEntries(jobs), [`${ID}.json`]);
    const row = await currentRow(f);
    for (const secret of ['initial transient password', 'updated transient password', f.env.OWNER_TOKEN, f.env.SESSION_SECRET, row.password_salt, row.password_hash]) assert.ok(!durableBefore.includes(secret));
    assert.equal(share.manifest.password, undefined); assert.equal(share.manifest.expiresAt, undefined);
});

test('owner can manage expired policy and unshare before or after expiry with idempotent exact-prefix cleanup', async t => {
    const f = await environment(); t.after(f.close);
    const directory = await newFixtureDirectory(fixturePath(fixtureTempRoot(), 'rushes-expired-cleanup-')); t.after(() => removeFixtureDirectory(directory, { recursive: true, force: true }));
    const store = new JsonJobStore(fixturePath(directory, 'jobs'));
    const provider = new WorkerProvider({ workerURL: f.env.PUBLIC_BASE_URL, token: f.env.OWNER_TOKEN }, { store, fetch: (url, options = {}) => f.worker.fetch(new Request(url, options), f.env) });
    let share = await provider.reserve({ id: ID, title: 'Expired cleanup fixture', expiresAt: future() });
    const mediaKey = `s/${ID}/video-aaaaaaaa.mp4`, neighborKey = `s/${ID}-neighbor/video-aaaaaaaa.mp4`;
    await f.env.MEDIA.put(mediaKey, 'expired fixture bytes');
    await f.env.MEDIA.put(`s/${ID}`, 'expired fixture page');
    await f.env.MEDIA.put(neighborKey, 'keep this neighboring prefix');
    const upload = await f.request(`/api/shares/${ID}/uploads`, ownerOptions(f.env, 'POST', { file: 'video-bbbbbbbb.mp4', bytes: 32, sha256: 'b'.repeat(64), contentType: 'video/mp4' }));
    assert.equal(upload.status, 200); assert.equal(f.env.MEDIA.sessions.size, 1);
    const expiredAt = new Date(Date.now() - 1000).toISOString();
    await f.env.DB.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').bind(expiredAt, ID).run();
    assert.equal((await f.request(`/s/${ID}/share.json`)).status, 404);
    const objectsBefore = [...f.env.MEDIA.objects.keys()];
    for (const headers of [{}, { Authorization: 'Bearer wrong-owner' }]) {
        assert.equal((await f.request(`/api/shares/${ID}`, { method: 'DELETE', headers })).status, 401);
        assert.deepEqual([...f.env.MEDIA.objects.keys()], objectsBefore);
        assert.ok(await currentRow(f)); assert.equal(f.env.MEDIA.sessions.size, 1);
    }
    assert.equal((await f.request('/api/shares/not-a-valid-share', ownerOptions(f.env, 'DELETE'))).status, 404);
    assert.deepEqual([...f.env.MEDIA.objects.keys()], objectsBefore);
    assert.deepEqual(await provider.getPolicy(ID), { protected: false, expiresAt: expiredAt });
    assert.deepEqual(await provider.updatePolicy(ID, { password: 'expired policy fixture password' }), { protected: true, expiresAt: expiredAt });
    assert.equal((await f.request(`/s/${ID}/${'video-aaaaaaaa.mp4'}`)).status, 404);
    assert.deepEqual(await provider.updatePolicy(ID, { expiresAt: null }), { protected: true, expiresAt: null });
    assert.equal((await f.request(`/s/${ID}/share.json`, ownerOptions(f.env, 'GET'))).status, 200);
    await f.env.DB.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').bind(expiredAt, ID).run();
    await provider.delete(share);
    assert.equal(await currentRow(f), null); assert.equal(await store.read(ID), undefined);
    assert.equal(f.env.MEDIA.sessions.size, 0); assert.equal(f.env.MEDIA.aborts, 1);
    assert.deepEqual([...f.env.MEDIA.objects.keys()], [neighborKey]);
    await provider.delete(share);
    assert.deepEqual([...f.env.MEDIA.objects.keys()], [neighborKey]);
    // The same stable ID can be reserved again after owner cleanup, and deleted while still unexpired.
    share = await provider.reserve({ id: ID, title: 'Re-share after expiry', expiresAt: future() });
    await f.env.MEDIA.put(mediaKey, 'replacement fixture bytes');
    await provider.delete(share);
    assert.equal(await currentRow(f), null); assert.equal(await store.read(ID), undefined);
    assert.deepEqual([...f.env.MEDIA.objects.keys()], [neighborKey]);
    assert.equal((await f.request(`/api/shares/${ID}`, { method: 'DELETE' })).status, 401);
});
