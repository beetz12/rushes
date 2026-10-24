import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
let server, browser, origin;
const precisionHeaders = new Headers();
precisionHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
precisionHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0,
    // These two 200us instruments require an explicitly qualified clock context.
    headers: Object.fromEntries(precisionHeaders) } });
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ ...(process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE ? { executablePath: process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE } : { channel: 'chrome' }), headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });
test('one composed input retains actual PCM references and independent lifetime', { timeout: 15000 }, async () => {
  const page = await browser.newPage();
  try {
    const response = await page.goto(origin);
    assert.equal(response.headers()['cross-origin-opener-policy'], 'same-origin');
    assert.equal(response.headers()['cross-origin-embedder-policy'], 'require-corp');
    const result = await page.evaluate(async () => {
      if (!crossOriginIsolated) throw new Error('Audio microprecision context is not isolated');
      const { composedAudio } = await import('/src/capture/audio.ts');
      const source = new MediaStreamTrackGenerator({ kind: 'audio' }), writer = source.writable.getWriter();
      const mix = composedAudio([source]);
      const observer = mix.track.clone(), reader = new MediaStreamTrackProcessor({ track: observer }).readable.getReader();
      const base = Math.round(performance.now() * 1000), packets = [];
      let timedOut = false, deadline;
      try {
        await mix.start();
        const reading = (async () => {
          for (;;) {
            const item = await reader.read(); if (item.done) return;
            try {
              const pcm = new Float32Array(item.value.numberOfFrames);
              item.value.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
              if (pcm.some(value => value !== 0)) {
                packets.push({ timestamp: item.value.timestamp, rate: item.value.sampleRate, frames: item.value.numberOfFrames, pcm: [...pcm] });
                if (packets.length === 3) return;
              }
            } finally { item.value.close(); }
          }
        })();
        deadline = setTimeout(() => { timedOut = true; void reader.cancel(); }, 1500);
        for (let packet = 0; packet < 3; packet++) {
          const pcm = Float32Array.from({ length: 480 }, (_, index) => (packet * 480 + index + 1) / 2000);
          const data = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: 480, numberOfChannels: 1,
            timestamp: base + packet * 10000, data: pcm });
          try { await writer.write(data); } finally { data.close(); }
        }
        await reading;
        mix.close(); mix.close();
        return { base, packets, timedOut, sourceState: source.readyState, composedState: mix.track.readyState };
      } finally { clearTimeout(deadline); await reader.cancel().catch(() => {}); observer.stop(); mix.close(); source.stop(); writer.releaseLock(); }
    });
    assert.equal(result.timedOut, false); assert.equal(result.packets.length, 3);
    assert.equal(result.sourceState, 'live'); assert.equal(result.composedState, 'ended');
    for (const [packet, value] of result.packets.entries()) {
      assert.equal(value.rate, 48000); assert.equal(value.frames, 480);
      assert.ok(Math.abs(value.timestamp - (result.base + packet * 10000)) <= 200,
        `source reference changed by ${value.timestamp - (result.base + packet * 10000)}us`);
      assert.deepEqual(value.pcm, Array.from(Float32Array.from({ length: 480 }, (_, index) => (packet * 480 + index + 1) / 2000)));
    }
  } finally { await page.close(); }
});
for (const dedicatedAvailable of [true, false]) test(`two-input mixer retains Window references and stereo PCM with dedicated endpoint ${dedicatedAvailable ? 'available' : 'unavailable'}`, { timeout: 15000 }, async () => {
  const page = await browser.newPage();
  try {
    const response = await page.goto(origin);
    assert.equal(response.headers()['cross-origin-opener-policy'], 'same-origin');
    assert.equal(response.headers()['cross-origin-embedder-policy'], 'require-corp');
    const result = await page.evaluate(async dedicatedAvailable => {
      if (!crossOriginIsolated) throw new Error('Audio microprecision context is not isolated');
      const NativeWorker = Worker;
      if (!dedicatedAvailable) globalThis.Worker = class extends NativeWorker {
        constructor(url, options) {
          if (String(url).includes('/audio.worker')) throw new Error('Controlled dedicated mixer endpoint unavailable');
          super(url, options);
        }
      };
      const { composedAudio } = await import('/src/capture/audio.ts');
      const sources = [0, 1].map(() => new MediaStreamTrackGenerator({ kind: 'audio' }));
      const writers = sources.map(source => source.writable.getWriter()), failures = [];
      const mix = composedAudio(sources, message => failures.push(message));
      const observer = mix.track.clone(), reader = new MediaStreamTrackProcessor({ track: observer }).readable.getReader();
      const packets = [], base = 37000;
      let timedOut = false, deadline;
      try {
        const reading = (async () => {
          for (;;) {
            const item = await reader.read(); if (item.done) return;
            try {
              const planes = [0, 1].map(planeIndex => {
                const data = new Float32Array(item.value.numberOfFrames); item.value.copyTo(data, { planeIndex, format: 'f32-planar' }); return [...data];
              });
              packets.push({ timestamp: item.value.timestamp, rate: item.value.sampleRate, frames: item.value.numberOfFrames, planes });
              if (packets.length === 3) return;
            } finally { item.value.close(); }
          }
        })();
        deadline = setTimeout(() => { timedOut = true; void reader.cancel(); }, 2000);
        for (let packet = 0; packet < 3; packet++) {
          for (const [source, writer] of writers.entries()) {
            const planes = source === 0 ? [.2, .4] : [.6, -.2];
            const pcm = new Float32Array(960); pcm.fill(planes[0], 0, 480); pcm.fill(planes[1], 480);
            const data = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: 480, numberOfChannels: 2,
              timestamp: base + packet * 10000, data: pcm });
            try { await writer.write(data); } finally { data.close(); }
          }
        }
        await Promise.all([mix.start(), reading]); mix.close();
        return { packets, failures, timedOut, sourceStates: sources.map(track => track.readyState), outputState: mix.track.readyState };
      } finally { clearTimeout(deadline); await reader.cancel().catch(() => {}); observer.stop(); mix.close(); sources.forEach(track => track.stop()); writers.forEach(writer => writer.releaseLock()); globalThis.Worker = NativeWorker; }
    }, dedicatedAvailable);
    assert.equal(result.timedOut, false); assert.deepEqual(result.failures, []); assert.equal(result.packets.length, 3);
    assert.deepEqual(result.sourceStates, ['live', 'live']); assert.equal(result.outputState, 'ended');
    for (const [packet, value] of result.packets.entries()) {
      assert.equal(value.rate, 48000); assert.equal(value.frames, 480);
      assert.ok(Math.abs(value.timestamp - (37000 + packet * 10000)) <= 200, `unexpected audio reference${value.timestamp}`);
      assert.ok(value.planes[0].every(sample => Math.abs(sample - .4) < 1e-6));
      assert.ok(value.planes[1].every(sample => Math.abs(sample - .1) < 1e-6));
    }
  } finally { await page.close(); }
});
