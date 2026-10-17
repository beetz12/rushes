import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { nativeClockSeed, timestampSeed } from './native-clock-seed.mjs';
import { beginColdTrace, requireNativeClockTrace } from './cold-trace.mjs';
import * as clockFiles from 'node:fs/promises';
import * as hostDirectories from 'node:os';
import * as clockPaths from 'node:path';
let browser, server, origin;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'native-clock-capability', configureServer(value) {
      value.middlewares.use('/clock-fixture', (_request, response) => {
        response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Generated scalar conversion control</title>');
      });
    } }] });
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE,
    ...(process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE ? {} : { channel: 'chrome' }), headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });
test('only the exact unique finite native Timestamp is admitted', () => {
  assert.equal(timestampSeed([{ name: 'ThreadTime', value: 999 }, { name: 'Timestamp', value: 123.125 }]), 123125000);
  for (const metrics of [[], [{ name: 'Timestamp', value: 0 }], [{ name: 'Timestamp', value: NaN }],
    [{ name: 'Timestamp', value: '123' }], [{ name: 'Timestamp', value: 1e15 }],
    [{ name: 'Timestamp', value: 123 }, { name: 'Timestamp', value: 124 }]])
    assert.throws(() => timestampSeed(metrics), /one finite native Timestamp/);
});
test('failed metric sampling or disable still detaches its page session', async () => {
  for (const failure of ['Performance.enable', 'Performance.getMetrics', 'Performance.disable', 'changed-document']) {
    const calls = []; let document, read = 0;
    const session = { send: async (method, parameters) => {
      calls.push(method);
      if (method === 'Performance.enable') assert.deepEqual(parameters, { timeDomain: 'timeTicks' });
      if (method === failure) throw new Error(`Deliberate ${failure}`);
      return { metrics: [{ name: 'Timestamp', value: 123 }] };
    }, detach: async () => { calls.push('detach'); } };
    const page = { context: () => ({ newCDPSession: async () => session }), evaluate: async (_, token) => {
      if (token) document = token;
      return { token: failure === 'changed-document' && read++ ? 'different' : document, timeOrigin: 1000, pageMs: 2 };
    } };
    await assert.rejects(nativeClockSeed(page), /seed acquisition failed/);
    assert.deepEqual(calls.slice(-2), ['Performance.disable', 'detach']);
  }
});
test('a page session created after the sampling deadline is retired without enabling metrics', { timeout: 5000 }, async () => {
  const calls = []; let release;
  const detached = new Promise(resolve => { release = resolve; });
  const page = { evaluate: async (_, token) => ({ token, timeOrigin: 1000, pageMs: 2 }),
    context: () => ({ newCDPSession: () => new Promise(resolve => setTimeout(() => resolve({
      send: async method => { calls.push(method); }, detach: async () => { calls.push('detach'); release(); },
    }), 1600)) }) };
  await assert.rejects(nativeClockSeed(page), /seed acquisition failed/);
  await detached; assert.deepEqual(calls, ['detach']);
});
test('native clock conversion works with both device APIs refused', { timeout: 15000 }, async () => {
  const page = await browser.newPage();
  const temporary = await clockFiles.mkdtemp(clockPaths.join(hostDirectories.tmpdir(), 'rushes-native-clock-'));
  let trace;
  try {
    await page.goto(`${origin}/clock-fixture`);
    await page.evaluate(() => {
      globalThis.deviceAttempts = 0;
      for (const method of ['getUserMedia', 'getDisplayMedia']) navigator.mediaDevices[method] = async () => {
        globalThis.deviceAttempts++; throw new Error('Clock conversion must not acquire devices');
      };
    });
    trace = await beginColdTrace(browser, page, clockPaths.join(temporary, 'trace'));
    const seed = await nativeClockSeed(page);
    const result = await page.evaluate(async seed => {
      const { nativeReferenceClock } = await import('/test/native-reference-clock.mjs');
      return { clock: await nativeReferenceClock(seed), deviceAttempts: globalThis.deviceAttempts };
    }, seed);
    assert.equal(result.clock.error, undefined); assert.equal(result.clock.converter.qualified, true);
    assert.equal(result.clock.observations.length, 3); assert.equal(result.deviceAttempts, 0);
    assert.deepEqual(result.clock.cleanupErrors, []);
    const report = await trace.finish({ scope: 'Clock capability; device APIs refused' });
    assert.equal(requireNativeClockTrace(report, result.clock).qualified, true);
    for (const shift of [37, 300]) {
      const changed = structuredClone(report); changed.clock.traceOriginUs += shift * 1000;
      assert.throws(() => requireNativeClockTrace(changed, result.clock), /origins disagree/);
    }
    const changed = structuredClone(report); changed.clock.callTimes.at(-1).nativeCallTimeUs += 300000;
    assert.throws(() => requireNativeClockTrace(changed, result.clock), /independent page bracket/);
  } finally {
    if (trace) await trace.finish({ cleanup: true }).catch(() => {});
    await page.close(); await clockFiles.rm(temporary, { recursive: true });
  }
});
test('invalid, stale, wrong-window and wrong-domain supplied seeds never fall back to a device', { timeout: 30000 }, async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/clock-fixture`);
    await page.evaluate(() => {
      globalThis.deviceAttempts = 0;
      for (const method of ['getUserMedia', 'getDisplayMedia']) navigator.mediaDevices[method] = async () => {
        globalThis.deviceAttempts++; throw new Error('No clock fallback');
      };
    });
    const seed = await nativeClockSeed(page);
    const result = await page.evaluate(async seed => {
      const { nativeReferenceClock } = await import('/test/native-reference-clock.mjs');
      const changed = [null, { ...seed, timestampUs: 0 }, { ...seed, timestampUs: NaN },
        { ...seed, timestampUs: Number.MAX_SAFE_INTEGER }, { ...seed, timestampUs: performance.now() },
        { ...seed, timeOrigin: seed.timeOrigin + 1 }, { ...seed, token: 'another-window' },
        { ...seed, beforePageMs: seed.beforePageMs - 1600 }];
      const results = [];
      for (const value of changed) results.push(await nativeReferenceClock(value));
      return { results, attempts: globalThis.deviceAttempts };
    }, seed);
    assert.equal(result.attempts, 0);
    for (const row of result.results) { assert.match(row.error, /Invalid, stale or cross-document/); assert.equal(row.converter, undefined); }
  } finally { await page.close(); }
});
test('a distant but safe native scalar cannot pass the actual generator captureTime checks', { timeout: 15000 }, async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/clock-fixture`); const seed = await nativeClockSeed(page);
    const result = await page.evaluate(async seed => {
      const { nativeReferenceClock } = await import('/test/native-reference-clock.mjs');
      return nativeReferenceClock({ ...seed, timestampUs: seed.timestampUs + 61000000 });
    }, seed);
    assert.match(result.error, /captureTime/); assert.equal(result.converter, undefined);
    assert.deepEqual(result.cleanupErrors, []);
  } finally { await page.close(); }
});
test('clock capability fails closed when native timestamp promotion is disabled', { timeout: 15000 }, async () => {
  const disabled = await chromium.launch({ executablePath: process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE,
    ...(process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE ? {} : { channel: 'chrome' }), headless: true,
    args: ['--disable-features=BreakoutBoxWriteVideoFrameCaptureTimestamp'] });
  try {
    const page = await disabled.newPage(); await page.goto(`${origin}/clock-fixture`); const seed = await nativeClockSeed(page);
    const result = await page.evaluate(async seed => {
      const { nativeReferenceClock } = await import('/test/native-reference-clock.mjs'); return nativeReferenceClock(seed);
    }, seed);
    assert.match(result.error, /captureTime/); assert.equal(result.converter, undefined);
    assert.deepEqual(result.cleanupErrors, []);
  } finally { await disabled.close(); }
});
