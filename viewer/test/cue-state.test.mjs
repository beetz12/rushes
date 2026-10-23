import test from 'node:test';
import verifyCue from 'node:assert/strict';
import { createServer as createFixtureServer } from 'node:http';
import { once as fixtureListening } from 'node:events';
import { readFile as readFixtureFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { viewerPage } from '../../cloud/dist/page.js';
import { ownedTestBrowser } from '../../browser/test/owned-test-browser.mjs';

const ID = 'abcdefghijklmnopqrstuv';
const originalCues = [
    { startMs: 0, endMs: 3000, text: 'First fixture cue' },
    { startMs: 3000, endMs: 5000, text: 'Middle fixture cue' },
    { startMs: 5000, endMs: 8000, text: 'Final fixture cue' },
];
async function fixture(t, browserType, options, holdTranscript = false) {
    const media = await readFixtureFile(new URL('fixtures/video.mp4', import.meta.url));
    const script = await readFixtureFile(new URL('../dist/viewer.js', import.meta.url));
    const styles = await readFixtureFile(new URL('../dist/viewer.css', import.meta.url));
    const manifest = { schema: 'rushes.share/1', id: ID, status: 'ready', title: 'Cue state fixture', createdAt: '2026-10-11', durationMs: 8000,
        video: { file: 'video-abcdef12.mp4', width: 320, height: 240, bytes: media.length }, transcript: 'transcript-abcdef12.json' };
    let base;
    const delayed = [];
    const server = createFixtureServer((request, response) => {
        const path = new URL(request.url, base).pathname;
        const send = (type, data) => { response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(data); };
        if (path === `/s/${ID}`) return send('text/html', viewerPage(manifest, base));
        if (path.endsWith('/share.json')) return send('application/json', JSON.stringify(manifest));
        if (path.endsWith('/viewer.js')) return send('text/javascript', script);
        if (path.endsWith('/viewer.css')) return send('text/css', styles);
        if (path.endsWith('.mp4')) {
            const bounds = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
            const first = bounds ? Number(bounds[1]) : 0;
            const last = bounds?.[2] ? Math.min(Number(bounds[2]), media.length - 1) : media.length - 1;
            response.writeHead(bounds ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': last - first + 1,
                ...(bounds ? { 'Content-Range': `bytes ${first}-${last}/${media.length}` } : {}) });
            return response.end(media.subarray(first, last + 1));
        }
        if (path.endsWith('.json')) {
            const cues = path.endsWith('transcript-fedcba98.json') ? [
                { startMs: 0, endMs: 2000, text: 'Replacement first cue' },
                { startMs: 2000, endMs: 8000, text: 'Replacement current cue' },
            ] : originalCues;
            const reply = () => { if (!response.destroyed) send('application/json', JSON.stringify({ cues })); };
            if (holdTranscript) delayed.push(reply); else reply();
            return;
        }
        response.writeHead(404); response.end();
    });
    server.listen(0, '127.0.0.1'); await fixtureListening(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => { for (const reply of delayed.splice(0)) reply(); server.close(); });
    const owned = await ownedTestBrowser(t.signal, () => browserType.launchServer({ headless: true, ...options }), endpoint => browserType.connect(endpoint));
    const browser = owned.browser; t.after(() => owned.close());
    const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    // Shorten polling only; generated video and all manifest/transcript requests remain real.
    await page.addInitScript(() => {
        const timer = window.setTimeout.bind(window);
        window.setTimeout = (callback, delay, ...args) => timer(callback, delay >= 3000 && delay <= 15000 ? 100 : delay, ...args);
    });
    await page.goto(`${base}/s/${ID}`);
    await page.waitForFunction(() => document.querySelector('video').readyState >= 1, null, { timeout: 5000 });
    // Native WebKit metadata preload does not decode a frame until playback starts.
    await page.locator('video').evaluate(async video => { video.muted = true; await video.play(); video.pause(); });
    await page.waitForFunction(() => document.querySelector('video').readyState >= 2, null, { timeout: 5000 });
    const seek = async seconds => {
        let timer;
        try {
            await Promise.race([page.locator('video').evaluate((video, time) => new Promise(resolve => {
                video.pause(); video.addEventListener('seeked', () => resolve(), { once: true }); video.currentTime = time;
            }), seconds), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Native viewer seek to${seconds}s exceeded5000ms`)), 5000); })]);
        } catch (error) {
            let state, diagnosticTimer;
            try { state = await Promise.race([page.evaluate(() => {
                const video = document.querySelector('video');
                return video ? { time: video.currentTime, ready: video.readyState, seeking: video.seeking, paused: video.paused,
                    src: video.currentSrc, seekable: Array.from({ length: video.seekable.length }, (_, index) => [video.seekable.start(index), video.seekable.end(index)]),
                    error: video.error?.code } : { missingVideo: true };
            }), new Promise((_, reject) => { diagnosticTimer = setTimeout(() => reject(new Error('Seek snapshot exceeded1000ms')), 1000); })]); }
            catch (snapshotError) { state = { unavailable: snapshotError.message }; }
            finally { clearTimeout(diagnosticTimer); }
            t.diagnostic(JSON.stringify({ scope: 'Native seek failure; original seeked-event requirement retained', target: seconds, state }));
            throw error;
        } finally { clearTimeout(timer); }
    };
    const active = () => page.locator('#transcript button.active').allTextContents();
    return { page, manifest, seek, active, errors, version: browser.version(), releaseTranscript() { holdTranscript = false; for (const reply of delayed.splice(0)) reply(); } };
}

for (const [name, browserType, options] of [['Chrome', chromium, { channel: 'chrome' }], ['WebKit', webkit, {}]]) {
    test(`${name} cue state matches real seeks, natural ending and a replacement video`, { timeout: 60000 }, async t => {
        const f = await fixture(t, browserType, options);
        await f.page.waitForFunction(() => document.querySelectorAll('#transcript button').length === 3);
        for (const [seconds, text] of [[1, 'First fixture cue'], [4, 'Middle fixture cue'], [6, 'Final fixture cue']]) {
            await f.seek(seconds);
            verifyCue.ok((await f.active())[0]?.includes(text));
        }
        await f.page.locator('video').evaluate(async video => { video.muted = true; video.currentTime = 7.5; video.playbackRate = 4; await video.play(); });
        await f.page.waitForFunction(() => document.querySelector('video').ended);
        verifyCue.deepEqual(await f.active(), []);
        const ended = await f.page.locator('video').evaluate(video => ({ currentTime: video.currentTime, duration: video.duration, ended: video.ended }));
        t.diagnostic(`${name} ${f.version}: actual native ending ${JSON.stringify(ended)}; no active cue at end.`);
        await f.seek(4);
        const requests = []; let requestCount = 0;
        const record = row => { requestCount++; requests.push(row); if (requests.length > 100) requests.shift(); };
        f.page.on('response', response => { const path = new URL(response.url()).pathname; if (/share\.json|transcript-|video-/.test(path)) record({ path, status: response.status() }); });
        f.page.on('requestfailed', request => record({ path: new URL(request.url()).pathname, failed: request.failure()?.errorText }));
        await f.page.locator('video').evaluate(video => {
            window.replacementEvents = []; window.replacementEventCount = 0;
            for (const type of ['emptied','loadstart','loadedmetadata','loadeddata','canplay','seeking','seeked','error']) video.addEventListener(type, () => {
                window.replacementEventCount++; window.replacementEvents.push({ type, src: video.currentSrc, time: video.currentTime,
                    ready: video.readyState, seeking: video.seeking, seekable: Array.from({ length: video.seekable.length }, (_, index) => [video.seekable.start(index), video.seekable.end(index)]) });
                if (window.replacementEvents.length > 100) window.replacementEvents.shift();
            });
        });
        f.manifest.video.file = 'video-fedcba98.mp4'; f.manifest.transcript = 'transcript-fedcba98.json';
        try {
            await f.page.waitForFunction(() => document.querySelector('video').src.endsWith('video-fedcba98.mp4') && document.querySelector('video').readyState >= 2
                && Math.abs(document.querySelector('video').currentTime - 4) < .05 && document.querySelector('#transcript').textContent.includes('Replacement current cue'));
        } catch (error) {
            t.diagnostic(`Original replacement failure: ${error.name}: ${error.message}`);
            let media, timer;
            try { media = await Promise.race([f.page.evaluate(() => {
                const video = document.querySelector('video'); if (!video) return { missingVideo: true };
                return { src: video.src, currentSrc: video.currentSrc, time: video.currentTime,
                    duration: video.duration, ready: video.readyState, network: video.networkState, paused: video.paused, seeking: video.seeking,
                    error: video.error?.code, seekable: Array.from({ length: video.seekable.length }, (_, index) => [video.seekable.start(index), video.seekable.end(index)]),
                    transcript: document.querySelector('#transcript')?.textContent, events: window.replacementEvents,
                    droppedEvents: Math.max(0, window.replacementEventCount - window.replacementEvents.length) };
            }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Replacement snapshot exceeded1000ms')), 1000); })]); }
            catch (snapshotError) { media = { unavailable: snapshotError.message }; }
            finally { clearTimeout(timer); }
            t.diagnostic(JSON.stringify({ scope: 'Unchanged replacement predicate failure; generated fixture only', requests,
                droppedRequests: Math.max(0, requestCount - requests.length), errors: f.errors, media }));
            throw error;
        }
        verifyCue.ok((await f.active())[0]?.includes('Replacement current cue'));
        verifyCue.equal(await f.page.locator('video').evaluate(video => video.paused), true);
        verifyCue.deepEqual(f.errors, []);
    });
    test(`${name} late transcript immediately marks the current paused cue`, { timeout: 60000 }, async t => {
        const f = await fixture(t, browserType, options, true);
        await f.seek(4);
        verifyCue.equal(await f.page.locator('#transcript button').count(), 0);
        f.releaseTranscript();
        await f.page.waitForFunction(() => document.querySelectorAll('#transcript button').length === 3);
        verifyCue.deepEqual(await f.active(), ['0:03  Middle fixture cue']);
        verifyCue.equal(await f.page.locator('video').evaluate(video => video.paused), true);
        verifyCue.ok(Math.abs(await f.page.locator('video').evaluate(video => video.currentTime) - 4) < .05);
        verifyCue.deepEqual(f.errors, []);
    });
    test(`${name} hover differs from the active cue, keyboard focus stays visible and footer contrast is measured`, { timeout: 60000 }, async t => {
        const f = await fixture(t, browserType, options);
        await f.page.waitForFunction(() => document.querySelectorAll('#transcript button').length === 3);
        await f.seek(4);
        const footer = await f.page.evaluate(() => {
            const color = getComputedStyle(document.querySelector('footer')).color;
            const background = getComputedStyle(document.documentElement).backgroundColor;
            const luminance = value => {
                const channels = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => channel / 255);
                const linear = channels.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
                return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
            };
            return { color, background, contrast: (luminance(color) + .05) / (luminance(background) + .05) };
        });
        t.diagnostic(`${name} ${f.version}: footer ${JSON.stringify(footer)} at 375 CSS px.`);
        verifyCue.ok(footer.contrast >= 4.5);
        await f.page.locator('#transcript button').first().hover();
        const colors = await f.page.locator('#transcript').evaluate(panel => ({
            hovered: getComputedStyle(panel.querySelector('button')).backgroundColor,
            active: getComputedStyle(panel.querySelector('.active')).backgroundColor,
        }));
        verifyCue.notEqual(colors.hovered, colors.active);
        verifyCue.deepEqual(await f.active(), ['0:03  Middle fixture cue']);
        // macOS WebKit uses Option-Tab to traverse buttons; no host keyboard setting is changed.
        await f.page.locator('#transcript button').first().focus();
        await f.page.keyboard.press(process.platform === 'darwin' && browserType === webkit ? 'Alt+Tab' : 'Tab');
        const focus = await f.page.locator('#transcript button').nth(1).evaluate(button => ({ focused: document.activeElement === button,
            visible: button.matches(':focus-visible'), outline: getComputedStyle(button).outlineStyle, width: getComputedStyle(button).outlineWidth }));
        verifyCue.equal(focus.focused, true); verifyCue.equal(focus.visible, true); verifyCue.equal(focus.outline, 'solid'); verifyCue.equal(focus.width, '3px');
        verifyCue.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        verifyCue.deepEqual(f.errors, []);
    });
}
