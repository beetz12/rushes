import test from 'node:test';
import verifyRange from 'node:assert/strict';
import { environment, ownerOptions } from './fixtures.mjs';

const ID = 'abcdefghijklmnopqrstuv';
const FILE = 'video-abcdef12.mp4';
const CONTENT = '0123456789abcdefghij';
for (const fullMetadata of [false, true]) {
    for (const protectedShare of [false, true]) {
        test(`request range determines HTTP status with full-span R2 metadata=${fullMetadata}, protected=${protectedShare}`, async t => {
            const fixture = await environment(); t.after(fixture.close);
            fixture.env.MEDIA.fullRangeMetadata = fullMetadata;
            const reserved = await fixture.request('/api/shares', ownerOptions(fixture.env, 'POST', { id: ID, title: 'Range fixture', durationMs: 1000, ...(protectedShare ? { password: 'controlled fixture password' } : {}) }));
            verifyRange.equal(reserved.status, 201);
            const key = `s/${ID}/${FILE}`;
            await fixture.env.MEDIA.put(key, CONTENT, { httpMetadata: { contentType: 'video/mp4', cacheControl: 'public,max-age=31536000,immutable' } });
            const published = await fixture.request(`/api/shares/${ID}/publish`, ownerOptions(fixture.env, 'POST', { video: { file: FILE, bytes: CONTENT.length }, width: 320, height: 240, durationMs: 1000 }));
            verifyRange.equal(published.status, 200);
            // Positive control reproduces the live provider metadata independently of HTTP headers.
            const stored = await fixture.env.MEDIA.get(key);
            verifyRange.deepEqual(stored.range, fullMetadata ? { offset: 0, length: CONTENT.length } : undefined);
            verifyRange.equal(await new Response(stored.body).text(), CONTENT);
            let cookie;
            if (protectedShare) {
                const unlock = await fixture.request(`/api/shares/${ID}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"controlled fixture password"}' });
                verifyRange.equal(unlock.status, 200); cookie = unlock.headers.get('Set-Cookie').split(';')[0];
            }
            const expectedCache = protectedShare ? 'private,no-store' : 'public,max-age=31536000,immutable';
            for (const method of ['GET', 'HEAD']) {
                const request = range => fixture.request(`/s/${ID}/${FILE}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(range === undefined ? {} : { Range: range }) } });
                for (const range of [undefined, '']) {
                    const whole = await request(range);
                    verifyRange.equal(whole.status, 200);
                    verifyRange.equal(whole.headers.get('Content-Length'), String(CONTENT.length));
                    verifyRange.equal(whole.headers.get('Content-Range'), null);
                    verifyRange.equal(whole.headers.get('Cache-Control'), expectedCache);
                    verifyRange.equal(whole.headers.get('Accept-Ranges'), 'bytes');
                    verifyRange.equal(whole.headers.get('Content-Type'), 'video/mp4');
                    verifyRange.equal(whole.headers.get('X-Content-Type-Options'), 'nosniff');
                    verifyRange.equal(whole.headers.get('ETag'), stored.httpEtag);
                    verifyRange.equal(await whole.text(), method === 'HEAD' ? '' : CONTENT);
                }
                for (const [range, start, result] of [['bytes=2-5', 2, '2345'], ['bytes=-3', 17, 'hij'], ['bytes=18-', 18, 'ij'], ['bytes=0-19', 0, CONTENT], ['bytes=-100', 0, CONTENT]]) {
                    const partial = await request(range);
                    verifyRange.equal(partial.status, 206);
                    verifyRange.equal(partial.headers.get('Content-Length'), String(result.length));
                    verifyRange.equal(partial.headers.get('Content-Range'), `bytes ${start}-${start + result.length - 1}/${CONTENT.length}`);
                    verifyRange.equal(partial.headers.get('Cache-Control'), expectedCache);
                    verifyRange.equal(partial.headers.get('Accept-Ranges'), 'bytes');
                    verifyRange.equal(partial.headers.get('ETag'), stored.httpEtag);
                    verifyRange.equal(await partial.text(), method === 'HEAD' ? '' : result);
                }
                for (const range of ['bytes=20-', 'bytes=30-40', 'bytes=-0', 'bytes=2-1', 'bytes=0-1,3-4', 'items=0-1', 'bytes=a-b']) {
                    const invalid = await request(range);
                    verifyRange.equal(invalid.status, 416);
                    verifyRange.equal(invalid.headers.get('Content-Range'), `bytes */${CONTENT.length}`);
                    verifyRange.equal(await invalid.text(), '');
                }
                if (protectedShare) verifyRange.equal((await fixture.request(`/s/${ID}/${FILE}`, { method })).status, 401);
            }
        });
    }
}

test('empty object with full-span R2 metadata remains a complete response and has no satisfiable range', async t => {
    const fixture = await environment(); t.after(fixture.close);
    fixture.env.MEDIA.fullRangeMetadata = true;
    const reservation = await fixture.request('/api/shares', ownerOptions(fixture.env, 'POST', { id: ID, title: 'Empty range fixture' }));
    verifyRange.equal(reservation.status, 201);
    await fixture.env.MEDIA.put(`s/${ID}/${FILE}`, new Uint8Array(), { httpMetadata: { contentType: 'video/mp4' } });
    for (const method of ['GET', 'HEAD']) {
        const whole = await fixture.request(`/s/${ID}/${FILE}`, { method });
        verifyRange.equal(whole.status, 200);
        verifyRange.equal(whole.headers.get('Content-Length'), '0');
        verifyRange.equal(whole.headers.get('Content-Range'), null);
        verifyRange.equal(await whole.text(), '');
        for (const range of ['bytes=0-0', 'bytes=-1']) {
            const invalid = await fixture.request(`/s/${ID}/${FILE}`, { method, headers: { Range: range } });
            verifyRange.equal(invalid.status, 416);
            verifyRange.equal(invalid.headers.get('Content-Range'), 'bytes */0');
        }
    }
});
