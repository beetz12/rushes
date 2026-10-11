import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { viewerPage } from '../../cloud/dist/page.js';

for (const [name, browserType, options] of [
    ['Chrome', chromium, { channel: 'chrome' }],
    ['WebKit', webkit, {}],
]) {
    test(`${name} restores the same transcript after removal without resetting playback`, async (t) => {
        const media = await readFile(new URL('fixtures/video.mp4', import.meta.url));
        const script = await readFile(new URL('../dist/viewer.js', import.meta.url));
        const styles = await readFile(new URL('../dist/viewer.css', import.meta.url));
        const transcriptFile = 'transcript-abcdef12.json';
        const manifest = {
            schema: 'rushes.share/1', id: 'abcdefghijklmnopqrstuv', status: 'ready',
            title: 'Transcript restoration fixture', createdAt: '2026-10-11', durationMs: 8000,
            video: { file: 'video-abcdef12.mp4', width: 320, height: 240, bytes: media.length },
            transcript: transcriptFile,
        };
        let base, transcriptReads = 0;
        const server = createServer((request, response) => {
            const path = new URL(request.url, base).pathname;
            const send = (type, body) => {
                response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
                response.end(body);
            };
            if (path === `/s/${manifest.id}`) return send('text/html', viewerPage(manifest, base));
            if (path.endsWith('/share.json')) return send('application/json', JSON.stringify(manifest));
            if (path.endsWith('/viewer.js')) return send('text/javascript', script);
            if (path.endsWith('/viewer.css')) return send('text/css', styles);
            if (path.endsWith('.mp4')) {
                const bounds = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
                const first = bounds ? Number(bounds[1]) : 0;
                const last = bounds?.[2] ? Math.min(Number(bounds[2]), media.length - 1) : media.length - 1;
                response.writeHead(bounds ? 206 : 200, {
                    'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
                    'Content-Length': last - first + 1,
                    ...(bounds ? { 'Content-Range': `bytes ${first}-${last}/${media.length}` } : {}),
                });
                return response.end(media.subarray(first, last + 1));
            }
            if (path.endsWith('/' + transcriptFile)) {
                transcriptReads++;
                return send('application/json', JSON.stringify({ cues: [
                    { startMs: 3000, endMs: 8000, text: 'Restorable line' },
                ] }));
            }
            response.writeHead(404); response.end();
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        base = `http://127.0.0.1:${server.address().port}`;
        t.after(() => server.close());
        const browser = await browserType.launch({ headless: true, ...options });
        t.after(() => browser.close());
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        // Only shorten polling waits; requests, responses and viewer callbacks remain real.
        await page.addInitScript(() => {
            const timer = window.setTimeout.bind(window);
            window.setTimeout = (callback, delay, ...args) => timer(callback,
                delay >= 3000 && delay <= 15000 ? 100 : delay, ...args);
        });
        await page.goto(`${base}/s/${manifest.id}`);
        const waitForCue = () => page.waitForFunction(() =>
            document.querySelector('#transcript button')?.textContent.includes('Restorable line'),
        null, { timeout: 3000 });
        const remove = async () => {
            manifest.transcript = null;
            await page.waitForFunction(() => document.querySelector('#transcript')?.textContent
                .includes('will appear here'), null, { timeout: 3000 });
            assert.equal(await page.locator('#transcript button').count(), 0);
        };
        const restore = async () => { manifest.transcript = transcriptFile; await waitForCue(); };
        await waitForCue();
        await page.locator('video').evaluate(async video => {
            video.muted = true; await video.play(); video.pause();
        });
        await page.waitForFunction(() => document.querySelector('video').readyState >= 2, null, { timeout: 3000 });
        const originalURL = page.url();
        const originalSource = await page.locator('video').evaluate(video => video.src);
        await page.locator('video').evaluate(video => {
            window.mediaResets = 0;
            video.addEventListener('emptied', () => window.mediaResets++);
            video.pause(); video.currentTime = 2;
        });
        await page.waitForFunction(() => Math.abs(document.querySelector('video').currentTime - 2) < .05,
            null, { timeout: 3000 });
        await remove();
        await restore();
        const paused = await page.locator('video').evaluate(video => ({
            position: video.currentTime, paused: video.paused, source: video.src,
        }));
        assert.equal(paused.paused, true);
        assert.ok(Math.abs(paused.position - 2) < .05);
        assert.equal(paused.source, originalSource);
        await page.locator('video').evaluate(async video => {
            video.muted = true; video.currentTime = 1; await video.play();
        });
        await page.waitForFunction(() => document.querySelector('video').currentTime > 1.1, null, { timeout: 3000 });
        const playingPosition = await page.locator('video').evaluate(video => video.currentTime);
        await remove();
        await restore();
        const playing = await page.locator('video').evaluate(video => ({
            position: video.currentTime, paused: video.paused, ended: video.ended, source: video.src,
        }));
        assert.equal(playing.paused, false);
        assert.equal(playing.ended, false);
        assert.ok(playing.position >= playingPosition);
        assert.equal(playing.source, originalSource);
        assert.equal(page.url(), originalURL);
        assert.equal(await page.evaluate(() => window.mediaResets), 0);
        assert.equal(transcriptReads, 3);
        await page.locator('#transcript button').click();
        await page.waitForFunction(() => Math.abs(document.querySelector('video').currentTime - 3) < .25,
            null, { timeout: 3000 });
        await page.locator('video').evaluate(video => video.pause());
        assert.deepEqual(errors, []);
        t.diagnostic(`${name} ${browser.version()}: real local HTTP; same transcript restored while paused and playing; no media reset.`);
    });
}
