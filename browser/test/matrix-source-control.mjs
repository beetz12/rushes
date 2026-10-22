// Diagnostic: the same native fake camera, without Rushes capture/composition.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
// These handles belong only to this explicitly isolated synthetic-source control.
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const executable = process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32'
  ? join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe') : '/usr/bin/google-chrome');
const fixture = process.env.RUSHES_M1_SOURCE_FILE;
if (!fixture) throw new Error('Set RUSHES_M1_SOURCE_FILE to an already generated native MJPEG fixture.');
const root = fileURLToPath(new URL('..', import.meta.url)), proof = process.env.RUSHES_M1_PROOF || await mkdtemp(join(tmpdir(), 'rushes-native-control-'));
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
server.middlewares.use('/native-control', (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Native fake capture control</title>'); });
await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const samples = [], children = [], browsers = [];
try {
  for (const rendered of [false, true]) {
    const profile = await mkdtemp(join(tmpdir(), 'rushes-native-profile-'));
    const switches = new Map([['headless', 'new'], ['remote-debugging-port', 0], ['user-data-dir', profile],
      ['use-fake-device-for-media-stream', true], ['use-fake-ui-for-media-stream', true],
      ['use-file-for-fake-video-capture', fixture], ['no-first-run', true], ['no-default-browser-check', true],
      ['autoplay-policy', 'no-user-gesture-required']]);
    const argumentsList = [...switches].map(([name, value]) => value === true ? `--${name}` : `--${name}=${value}`);
    argumentsList.push('about:blank');
    const child = spawn(executable, argumentsList, { stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child); let endpoint = '';
    child.stderr.on('data', data => { endpoint ||= data.toString().match(/DevTools listening on (ws:\/\/\S+)/)?.[1] || ''; });
    for (let attempt = 0; !endpoint && attempt < 200; attempt++) await delay(50);
    if (!endpoint) throw new Error('Native control Chrome failed to start.');
    const browser = await chromium.connectOverCDP(endpoint); browsers.push(browser);
    const page = browser.contexts()[0].pages()[0]; await page.goto(`${origin}/native-control`);
    await page.evaluate(async visible => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 }, audio: false });
      if (visible) { const video = document.createElement('video'); video.muted = true; video.srcObject = stream;
        document.body.append(video); await video.play(); }
      const reader = new MediaStreamTrackProcessor({ track: stream.getVideoTracks()[0], maxBufferSize: 1 }).readable.getReader();
      window.probe = { count: 0, firstTimestamp: null, lastTimestamp: null, lastWallMs: 0, state: stream.getVideoTracks()[0].readyState };
      void (async () => { for (;;) { const item = await reader.read(); if (item.done) break;
        window.probe.count++; window.probe.firstTimestamp ??= item.value.timestamp; window.probe.lastTimestamp = item.value.timestamp;
        window.probe.lastWallMs = performance.now(); item.value.close(); } })();
    }, rendered);
    samples.push({ rendered, chrome: browser.version(), page, values: [] });
  }
  const begun = Date.now();
  while (Date.now() - begun < 65000) {
    for (const sample of samples) sample.values.push(await sample.page.evaluate(() => ({ ...window.probe,
      wallMs: performance.now(), visibility: document.visibilityState })));
    console.log(samples.map(sample => ({ rendered: sample.rendered, ...sample.values.at(-1) })));
    await delay(3000);
  }
} finally {
  await writeFile(join(proof, 'native-source-control.json'), JSON.stringify(samples.map(({ page: _page, ...sample }) => sample), null, 2));
  for (const browser of browsers) await browser.close();
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  await server.close();
}
