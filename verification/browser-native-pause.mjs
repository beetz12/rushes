// Generated native MediaRecorder control. No product storage, composition or device access.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ownedTestBrowser } from '../browser/test/owned-test-browser.mjs';

const require = createRequire(new URL('../browser/package.json', import.meta.url));
const { chromium } = require('playwright');
if (process.argv.length !== 3) throw new Error('Usage: node verification/browser-native-pause.mjs <new-proof-directory>');
const proof = resolve(process.argv[2]);
await mkdir(proof, { mode: 0o700 });
const report = { scope: 'Vanilla canvas MediaRecorder paused/unpaused control; duration only, not A/V qualification',
  errors: [], rows: [], retired: false };
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Generated native pause control</title>');
});
let owner;
try {
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  owner = await ownedTestBrowser(AbortSignal.timeout(55_000), () => chromium.launchServer({
    ...(process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE ? { executablePath: process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE }
      : { channel: process.env.RUSHES_CAPTURE_BROWSER || 'chrome' }), headless: true, timeout: 10_000,
  }), endpoint => chromium.connect(endpoint, { timeout: 10_000 }));
  report.chrome = owner.browser.version();
  const page = await owner.browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  report.rows = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d'), feed = canvas.captureStream(0), track = feed.getVideoTracks()[0];
    const sourceEpoch = performance.now();
    const tick = () => {
      context.fillStyle = '#2040e0'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = Math.floor((performance.now() - sourceEpoch) / 500) % 2 ? '#ffffff' : '#000000';
      context.fillRect(0, 0, 64, 64); track.requestFrame();
    };
    tick(); const timer = setInterval(tick, 1000 / 30);
    const rows = ['unpaused', 'paused'].map(kind => {
      const recorder = new MediaRecorder(new MediaStream([track.clone()]), {
        mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 4_000_000,
      });
      const row = { kind, recorder, chunks: [], events: [], calls: [] };
      for (const name of ['start', 'pause', 'resume', 'stop', 'error']) recorder.addEventListener(name, () => {
        row.events.push({ name, pageMs: performance.now(), state: recorder.state });
      });
      recorder.ondataavailable = event => { if (event.data.size) row.chunks.push(event.data); };
      return row;
    });
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const event = (recorder, name) => new Promise((yes, no) => {
      const timeout = setTimeout(() => no(new Error(`Native ${name} event timed out`)), 10_000);
      recorder.addEventListener(name, () => { clearTimeout(timeout); yes(); }, { once: true });
    });
    const call = (row, name, ...args) => {
      const record = { name, before: performance.now(), beforeState: row.recorder.state };
      row.calls.push(record);
      try { row.recorder[name](...args); }
      finally { record.after = performance.now(); record.afterState = row.recorder.state; }
    };
    try {
      const starts = rows.map(row => event(row.recorder, 'start'));
      for (const row of rows) call(row, 'start', 2000);
      await Promise.all(starts);
      await wait(Math.max(0, 2200 - (performance.now() - rows[0].calls[0].before)));
      const paused = rows[1], pause = event(paused.recorder, 'pause'); call(paused, 'pause'); await pause;
      await wait(700);
      const resume = event(paused.recorder, 'resume'); call(paused, 'resume'); await resume;
      await wait(2100);
      const stops = rows.map(row => event(row.recorder, 'stop'));
      for (const row of rows) call(row, 'stop');
      await Promise.all(stops);
      const result = [];
      for (const row of rows) {
        const blob = new Blob(row.chunks, { type: row.recorder.mimeType });
        const video = document.createElement('video'); video.muted = true;
        const url = URL.createObjectURL(blob);
        const loaded = new Promise((yes, no) => {
          const timeout = setTimeout(() => no(new Error('Native control decode timed out')), 10_000);
          const check = () => {
            if (Number.isFinite(video.duration)) { clearTimeout(timeout); yes(); }
            else video.currentTime = 1e6;
          };
          video.onloadeddata = check; video.onseeked = check;
          video.onerror = () => { clearTimeout(timeout); no(new Error('Native control decode failed')); };
        });
        try {
          video.src = url; await loaded;
          const calls = Object.fromEntries(row.calls.map(value => [value.name, value]));
          const pauseMs = calls.pause ? calls.resume.before - calls.pause.before : 0;
          const wallMs = calls.stop.before - calls.start.before;
          const bytes = new Uint8Array(await blob.arrayBuffer()), pieces = [];
          for (let offset = 0; offset < bytes.length; offset += 16384)
            pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 16384)));
          result.push({ kind: row.kind, mime: row.recorder.mimeType, calls: row.calls, events: row.events,
            wallMs, pauseMs, expectedMs: wallMs - pauseMs, decodedMs: video.duration * 1000,
            width: video.videoWidth, height: video.videoHeight, chunkBytes: row.chunks.map(value => value.size),
            base64: btoa(pieces.join('')) });
        } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
      }
      return result;
    } finally {
      clearInterval(timer);
      for (const row of rows) {
        if (row.recorder.state !== 'inactive') row.recorder.stop();
        row.recorder.stream.getTracks().forEach(value => value.stop());
      }
      track.stop();
    }
  });
  for (const row of report.rows) {
    const path = join(proof, `${row.kind}.webm`);
    await writeFile(path, Buffer.from(row.base64, 'base64'), { flag: 'wx' }); delete row.base64;
    const { stdout } = await promisify(execFile)(process.env.RUSHES_FFPROBE || 'ffprobe', [
      '-v', 'error', '-show_packets', '-show_entries', 'packet=codec_type,pts_time,duration_time', '-of', 'json', path,
    ], { timeout: 10_000, maxBuffer: 4 * 1024 ** 2 });
    row.packets = JSON.parse(stdout).packets;
    row.durationPass = Math.abs(row.decodedMs - row.expectedMs) <= 250;
    if (row.events.some(value => value.name === 'error')) report.errors.push(`${row.kind} native encoder reported an error`);
    if (!row.durationPass) report.errors.push(`${row.kind} decoded duration differs from native active call interval by more than250ms`);
    if (!row.packets.length) report.errors.push(`${row.kind} has no decoded packets`);
  }
} catch (error) { report.errors.push(String(error.stack || error)); }
finally {
  for (const row of report.rows) delete row.base64;
  try { await owner?.close(); report.retired = !!owner; } catch (error) { report.errors.push(`Owned cleanup: ${error}`); }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(proof, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
}
console.log(JSON.stringify({ ...report, rows: report.rows.map(({ packets, ...row }) => ({ ...row, packetCount: packets?.length })) }));
if (report.errors.length || !report.retired || report.rows.length !== 2) process.exitCode = 1;
