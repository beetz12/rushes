import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, ownerOptions } from './fixtures.mjs';
const ID = 'abcdefghijklmnopqrstuv';
const PROTECTED = 'zyxwvutsrqponmlkjihgfe';
async function share(f, id, extra = {}, manifest = {}) {
    const r = await f.request('/api/shares', ownerOptions(f.env, 'POST', { id, title: 'Demo <b>"quoted"</b>', durationMs: 5000, ...extra }));
    assert.equal(r.status, 201);
    const m = { ...(await r.json()).manifest, status: 'ready', video: { file: 'video-abcdef12.mp4', width: 1920, height: 1080, bytes: 10 }, poster: 'poster-abcdef12.jpg', captions: [{ file: 'captions-abcdef12.vtt', lang: 'en' }], ...manifest };
    await f.env.DB.prepare('UPDATE shares SET manifest = ? WHERE id = ?').bind(JSON.stringify(m), id).run();
    return m;
}
const oembed = (f, url, extra = '') => f.request(`/oembed?url=${encodeURIComponent(url)}&format=json${extra}`);
test('only the embed route is frameable; every other route keeps DENY', async (t) => {
    const f = await environment();
    t.after(f.close);
    await share(f, ID);
    const embed = await f.request(`/embed/${ID}`);
    assert.equal(embed.status, 200);
    assert.equal(embed.headers.get('X-Frame-Options'), null);
    assert.match(embed.headers.get('Content-Security-Policy'), /frame-ancestors \*/);
    assert.match(embed.headers.get('Content-Security-Policy'), /default-src 'none'/);
    const html = await embed.text();
    assert.ok(html.includes(`src="https://share.example/s/${ID}/video-abcdef12.mp4"`));
    assert.ok(html.includes(`poster="https://share.example/s/${ID}/poster-abcdef12.jpg"`));
    assert.ok(html.includes(`<track kind="captions" src="https://share.example/s/${ID}/captions-abcdef12.vtt" srclang="en"`));
    assert.ok(!html.includes('<script'));
    assert.ok(!html.includes('comment'));
    assert.ok(!html.includes('<b>'));
    for (const path of [`/s/${ID}`, `/s/${ID}/share.json`, '/health', '/oembed?url=x', '/_viewer/v1/viewer.js', `/embed/${ID}/extra`, '/nope']) {
        const r = await f.request(path);
        assert.equal(r.headers.get('X-Frame-Options'), 'DENY', path);
        assert.ok(!(r.headers.get('Content-Security-Policy') ?? '').includes('frame-ancestors *'), path);
    }
});
test('oEmbed returns a JSON video response for own shares and rejects foreign URLs', async (t) => {
    const f = await environment();
    t.after(f.close);
    await share(f, ID);
    const r = await oembed(f, `https://share.example/s/${ID}?t=3`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('Content-Type'), /application\/json/);
    const o = await r.json();
    assert.equal(o.type, 'video');
    assert.equal(o.version, '1.0');
    assert.equal(o.provider_name, 'Rushes');
    assert.equal(o.title, 'Demo <b>"quoted"</b>');
    assert.equal(o.width, 960);
    assert.equal(o.height, 540);
    assert.equal(o.thumbnail_url, `https://share.example/s/${ID}/poster-abcdef12.jpg`);
    assert.equal(o.thumbnail_width, 1920);
    assert.equal(o.thumbnail_height, 1080);
    assert.ok(o.html.startsWith(`<iframe src="https://share.example/embed/${ID}" width="960" height="540"`));
    assert.ok(o.html.includes('title="Demo &lt;b&gt;&quot;quoted&quot;&lt;/b&gt;"'));
    const small = await (await oembed(f, `https://share.example/embed/${ID}`, '&maxwidth=320&maxheight=400')).json();
    assert.deepEqual([small.width, small.height], [320, 180]);
    assert.equal((await f.request(`/oembed?url=${encodeURIComponent(`https://share.example/s/${ID}`)}`)).status, 200);
    assert.equal((await oembed(f, `https://share.example/s/${ID}`, '&maxwidth=-4')).status, 400);
    assert.equal((await f.request(`/oembed?url=${encodeURIComponent(`https://share.example/s/${ID}`)}&format=xml`)).status, 501);
    for (const url of [`https://evil.example/s/${ID}`, `http://share.example/s/${ID}`, `https://share.example.evil.example/s/${ID}`, `https://share.example/api/shares/${ID}`, `https://share.example/s/${ID}/share.json`, 'not a url', '']) {
        const res = await oembed(f, url);
        assert.equal(res.status, 404, url);
        assert.equal((await res.json()).error.code, 'NOT_FOUND');
    }
    assert.equal((await oembed(f, 'https://share.example/s/bbbbbbbbbbbbbbbbbbbbbb')).status, 404);
});
test('password and expired shares never leak through embed or oEmbed', async (t) => {
    const f = await environment();
    t.after(f.close);
    await share(f, PROTECTED, { password: 'correct horse battery' }, { title: 'Secret board review', video: { file: 'video-abcdef12.mp4', width: 720, height: 1280, bytes: 10 } });
    const embed = await f.request(`/embed/${PROTECTED}`);
    assert.equal(embed.status, 200);
    const html = await embed.text();
    assert.ok(!html.includes('<video'));
    assert.ok(!html.includes('video-abcdef12'));
    assert.ok(!html.includes('poster-abcdef12'));
    assert.ok(!html.includes('Secret board review'));
    assert.ok(html.includes(`href="https://share.example/s/${PROTECTED}" target="_blank"`));
    assert.match(html, /Open on Rushes to enter the password/);
    const o = await (await oembed(f, `https://share.example/s/${PROTECTED}`)).json();
    assert.equal(o.title, 'Protected recording');
    assert.equal(o.thumbnail_url, undefined);
    assert.ok(!JSON.stringify(o).includes('Secret'));
    // Size and orientation are recording facts too; a protected share reports only the default frame.
    assert.deepEqual([o.width, o.height], [960, 540]);
    // Owner-authorized embeds still never show protected media in a third-party frame.
    assert.ok(!(await (await f.request(`/embed/${PROTECTED}`, { headers: { Authorization: `Bearer ${f.env.OWNER_TOKEN}` } })).text()).includes('<video'));
    await share(f, ID, { expiresAt: new Date(Date.now() + 60000).toISOString() });
    await f.env.DB.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), ID).run();
    const expired = await f.request(`/embed/${ID}`);
    assert.equal(expired.status, 404);
    const gone = await expired.text();
    assert.ok(!gone.includes('video-abcdef12'));
    assert.ok(!gone.includes('Demo'));
    assert.equal((await oembed(f, `https://share.example/s/${ID}`)).status, 404);
    assert.equal((await f.request('/embed/bbbbbbbbbbbbbbbbbbbbbb')).status, 404);
});
test('processing share embeds a status note and the Worker page advertises oEmbed', async (t) => {
    const f = await environment();
    t.after(f.close);
    await share(f, ID, {}, { status: 'processing', video: undefined, poster: undefined });
    const html = await (await f.request(`/embed/${ID}`)).text();
    assert.ok(html.includes('still processing'));
    assert.ok(!html.includes('<video'));
    const page = await (await f.request(`/s/${ID}`)).text();
    assert.ok(page.includes(`<link rel="alternate" type="application/json+oembed" href="https://share.example/oembed?url=${encodeURIComponent(`https://share.example/s/${ID}`)}&amp;format=json"`));
});
