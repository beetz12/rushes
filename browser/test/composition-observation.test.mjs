import * as spanTests from 'node:test';
import * as spanChecks from 'node:assert/strict';
import * as spanBuild from 'esbuild';
import * as spanVM from 'node:vm';
import * as spanURLs from 'node:url';
import * as spanFiles from 'node:fs/promises';
const built = await spanBuild.build({ entryPoints: [spanURLs.fileURLToPath(new URL('../src/capture/composition.worker.ts', import.meta.url))], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ mixed = false, drawMs = 0, cacheMs = 0, constructMs = 0, writeMs = 0, blocked = false, drawFailure = false, writeFailure = false } = {}) {
  let at = 100, surface = 0; const messages = [], inputs = [], outputs = [], writes = [], gates = [];
  class Input {
    closed = 0;
    constructor(stamp, role = 'camera') { this.stamp = stamp; this.role = role; inputs.push(this); }
    get timestamp() { spanChecks.equal(this.closed, 0); return this.stamp; }
    get displayWidth() { spanChecks.equal(this.closed, 0); return 1280; }
    get displayHeight() { spanChecks.equal(this.closed, 0); return 720; }
    close() { spanChecks.equal(this.closed, 0, 'Borrowed input closed twice'); this.closed++; }
  }
  class Canvas {
    constructor() { this.number = surface++; }
    getContext() { const number = this.number; return { fillRect() {}, drawImage(value) {
      if (value instanceof Input) { spanChecks.equal(value.closed, 0); at += value.role === 'screen' ? cacheMs : drawMs; if (drawFailure) throw new Error('Measured draw refusal'); }
    }, save() {}, beginPath() {}, arc() {}, clip() {}, restore() {} }; }
  }
  class Output {
    closed = 0;
    constructor(_canvas, options) { at += constructMs; this.timestamp = options.timestamp; outputs.push(this); }
    close() { spanChecks.equal(this.closed, 0, 'Owned output closed twice'); this.closed++; }
  }
  function source() {
    let resolve;
    const reader = { read: () => new Promise(done => { resolve = done; }),
      push(frame) { spanChecks.ok(resolve, 'The real worker must already be awaiting input'); const done = resolve; resolve = undefined; done({ value: frame, done: false }); },
      cancel() { if (resolve) { const done = resolve; resolve = undefined; done({ done: true }); } return Promise.resolve(); }, releaseLock() {} };
    return { getReader: () => reader, reader };
  }
  const screen = mixed ? source() : undefined, camera = source();
  const writer = { write(frame) { writes.push(frame); at += writeMs; if (writeFailure) return Promise.reject(new Error('Measured write refusal'));
    if (!blocked) return Promise.resolve(); return new Promise(resolve => gates.push(resolve)); }, close: () => Promise.resolve() };
  const realm = { performance: { now: () => at }, OffscreenCanvas: Canvas, VideoFrame: Output,
    postMessage: value => messages.push(structuredClone(value)) };
  spanVM.runInNewContext(built.outputFiles[0].text, realm);
  const send = data => realm.onmessage({ data });
  send({ kind: 'setup', screen, camera, output: { getWriter: () => writer }, width: 1280, height: 720, fps: 30, maxSeconds: 600, bubble: { x: 100, y: 100, size: 180 } });
  return { messages, inputs, outputs, writes, camera, screen, send, advance: value => { at += value; }, setNow: value => { at = value; },
    push: (stamp = 1000000) => camera.reader.push(new Input(stamp)), cache: (stamp = 1000000) => screen.reader.push(new Input(stamp, 'screen')),
    release: () => gates.splice(0).forEach(done => done()),
    async close() { send({ kind: 'stop' }); gates.splice(0).forEach(done => done()); await tick(); await tick(); } };
}
function latest(f) {
  const message = f.messages.filter(value => value.compositionSpans).at(-1);
  spanChecks.ok(message, 'Existing worker messages must carry local observations');
  spanChecks.equal(message.compositionSpans.schema, 'rushes.composition-local-spans/1'); return message.compositionSpans;
}
spanTests.test('controlled draw and frame construction occupy separate real-worker boundaries', async () => {
  const f = fixture({ drawMs: 300, constructMs: 70 });
  try { f.push(123456789); await tick(); const s = latest(f);
    spanChecks.equal(s.rows.preroll.raster.maxMs, 300); spanChecks.equal(s.rows.preroll.construct.maxMs, 70);
    spanChecks.equal(s.rows.preroll['write-wait'].maxMs, 0); spanChecks.equal(s.rows.preroll['lease-camera'].maxMs, 370);
    spanChecks.equal(f.outputs[0].timestamp, 123456789); spanChecks.equal(f.inputs[0].closed, 1); spanChecks.equal(f.outputs[0].closed, 1);
  } finally { await f.close(); }
});
spanTests.test('screen cache work is separate from the driver raster and keeps original input closing', async () => {
  const f = fixture({ mixed: true, cacheMs: 250 });
  try { f.cache(); await tick(); spanChecks.equal(f.inputs[0].closed, 1); f.push(); await tick(); const s = latest(f);
    spanChecks.equal(s.rows.preroll.cache.maxMs, 250); spanChecks.equal(s.rows.preroll.raster.maxMs, 0);
    spanChecks.equal(s.counts.screen, 1); spanChecks.equal(s.counts.camera, 1); spanChecks.equal(f.writes.length, 1);
  } finally { await f.close(); }
});
spanTests.test('synchronous writer work and a delayed write promise stay distinct without extending source leases', async () => {
  const f = fixture({ writeMs: 80, blocked: true });
  try { f.push(); await tick(); spanChecks.equal(f.inputs[0].closed, 1); spanChecks.equal(f.outputs[0].closed, 0);
    spanChecks.equal(f.messages.some(row => row.kind === 'ready'), false); f.advance(300); f.release(); await tick(); const s = latest(f);
    spanChecks.equal(s.rows.preroll['write-call'].maxMs, 80); spanChecks.equal(s.rows.preroll['write-wait'].maxMs, 300);
    spanChecks.equal(s.rows.preroll['lease-camera'].maxMs, 0); spanChecks.equal(f.outputs[0].closed, 1);
    spanChecks.equal(f.messages.filter(row => row.kind === 'ready').length, 1);
  } finally { await f.close(); }
});
spanTests.test('a delayed input read changes only its await boundary while output timing stays short', async () => {
  const f = fixture();
  try { f.advance(300); f.push(); await tick(); const s = latest(f);
    spanChecks.equal(s.rows.preroll['read-camera'].maxMs, 300); spanChecks.equal(s.rows.preroll.raster.maxMs, 0);
    spanChecks.equal(s.rows.preroll['write-wait'].maxMs, 0); spanChecks.equal(f.outputs[0].timestamp, 1000000);
  } finally { await f.close(); }
});
spanTests.test('a read spanning Start stays mixed, while subsequent work is only start-control scoped', async () => {
  const f = fixture();
  try { f.send({ kind: 'start' }); f.advance(25); f.push(); await tick(); const s = latest(f);
    spanChecks.equal(s.phase, 'start-control'); spanChecks.equal(s.rows.mixed['read-camera'].maxMs, 25);
    spanChecks.equal(s.rows['start-control'].raster.count, 1); spanChecks.equal(s.rows.preroll['read-camera'].count, 0);
    f.send({ kind: 'pause' }); f.advance(1200); f.push(1033334); await tick(); const paused = latest(f);
    spanChecks.equal(paused.phase, 'paused'); spanChecks.equal(paused.rows.paused.raster.count, 1);
  } finally { await f.close(); }
});
spanTests.test('cadence-rejected and pre-cache inputs are counted without extra frames or changed timestamps', async () => {
  const f = fixture({ mixed: true });
  try { f.push(900000); await tick(); f.cache(); await tick(); f.push(); await tick(); f.push(1000001); await tick(); await f.close(); const s = latest(f);
    spanChecks.equal(s.counts.notReady, 1); spanChecks.equal(s.counts.rejected, 1); spanChecks.equal(s.counts.admitted, 1);
    spanChecks.equal(f.outputs.length, 1); spanChecks.equal(f.outputs[0].timestamp, 1000000);
    spanChecks.ok(f.inputs.every(frame => frame.closed === 1)); spanChecks.ok(f.outputs.every(frame => frame.closed === 1));
  } finally { await f.close(); }
});
spanTests.test('observations freeze on existing messages and invalid clock spans are not healthy zeroes', async () => {
  const f = fixture();
  try { f.setNow(50); f.push(); await tick(); const first = latest(f); spanChecks.ok(first.invalid > 0);
    f.advance(2000); f.push(1033334); await tick(); const second = latest(f);
    spanChecks.equal(first.rows.preroll.raster.count, 1); spanChecks.equal(second.rows.preroll.raster.count, 2);
    spanChecks.deepEqual([...new Set(f.messages.map(row => row.kind))].sort(), ['progress', 'ready']);
  } finally { await f.close(); }
});
for (const failure of ['draw', 'write']) spanTests.test(`${failure} rejection retains the original error and exactly-once closes`, async () => {
  const f = fixture({ drawFailure: failure === 'draw', writeFailure: failure === 'write' });
  try { f.push(); await tick(); await tick(); spanChecks.equal(f.inputs[0].closed, 1);
    spanChecks.ok(f.outputs.every(frame => frame.closed === 1)); spanChecks.ok(f.messages.some(row => row.kind === 'error' && row.message.includes(`Measured ${failure} refusal`)));
    spanChecks.equal(latest(f).pending.some(row => row.name === 'write-wait'), false);
  } finally { await f.close(); }
});
spanTests.test('pause/resume round-trip cannot hide a pending read boundary', async () => {
  const f = fixture();
  try { f.send({ kind: 'start' }); f.push(); await tick();
    f.send({ kind: 'pause' }); f.advance(10); f.send({ kind: 'resume' }); f.advance(20); f.push(1033334); await tick(); await f.close();
    spanChecks.equal(latest(f).rows.mixed['read-camera'].maxMs, 30);
  } finally { await f.close(); }
});
spanTests.test('pause/resume round-trip cannot hide a pending generator write boundary', async () => {
  const f = fixture({ blocked: true });
  try { f.send({ kind: 'start' }); f.push(); await tick();
    f.send({ kind: 'pause' }); f.advance(70); f.send({ kind: 'resume' }); f.advance(30); f.release(); await tick(); await f.close();
    spanChecks.equal(latest(f).rows.mixed['write-wait'].maxMs, 100);
  } finally { await f.close(); }
});
spanTests.test('actual generated fixture caps32 envelopes and records unavailable or invalid envelopes', async () => {
  const source = await spanFiles.readFile(new URL('./matrix-fixture.mjs', import.meta.url), 'utf8');
  const from = source.indexOf('  // Observe the same owned compositor messages;'), to = source.indexOf('  const session = await createCaptureSession', from);
  spanChecks.ok(from >= 0 && to > from); const metrics = {};
  class LocalWorker { handlers = []; constructor() {} addEventListener(_kind, callback) { this.handlers.push(callback); } emit(data) { for (const callback of this.handlers) callback({ data }); } }
  const realm = { metrics, Worker: LocalWorker, URL, location: { href: 'http://127.0.0.1/fixture', origin: 'http://127.0.0.1' } };
  spanVM.runInNewContext(source.slice(from, to), realm); const worker = new realm.Worker('/src/capture/composition.worker.ts');
  for (let index = 0; index < 40; index++) worker.emit({ kind: 'progress', frameCount: index, compositionSpans: { schema: 'rushes.composition-local-spans/1', phase: 'preroll', rows: {} } });
  spanChecks.equal(metrics.compositionSpans.samples.length, 32); spanChecks.equal(metrics.compositionSpans.dropped, 8);
  worker.emit({ kind: 'ready' }); worker.emit({ kind: 'error', compositionSpans: { schema: 'wrong' } });
  spanChecks.equal(metrics.compositionSpans.missing, 1); spanChecks.equal(metrics.compositionSpans.invalid, 1);
  for (const target of ['/other-worker.mjs', 'http://foreign.invalid/src/capture/composition.worker.ts', 'http://user:pass@127.0.0.1/src/capture/composition.worker.ts']) {
    const unrelated = new realm.Worker(target); unrelated.emit({ kind: 'ready' });
  }
  spanChecks.equal(metrics.compositionSpans.missing, 1);
  const cyclic = { schema: 'rushes.composition-local-spans/1' }; cyclic.self = cyclic;
  spanChecks.doesNotThrow(() => worker.emit({ kind: 'progress', compositionSpans: { schema: 'rushes.composition-local-spans/1', value: 1n } }));
  spanChecks.doesNotThrow(() => worker.emit({ kind: 'progress', compositionSpans: cyclic }));
  spanChecks.equal(metrics.compositionSpans.invalid, 3);
  spanChecks.equal(metrics.compositionSpans.validation, 'envelope-only; numeric table reader required');
});

spanTests.test('existing stopping notification freezes one received prefix with its existing timestamp', async () => {
  const source = await spanFiles.readFile(new URL('./matrix-fixture.mjs', import.meta.url), 'utf8');
  const begin = source.indexOf('onState: state => {', source.indexOf('const session = await createCaptureSession'));
  const end = source.indexOf('    onWarning:', begin); spanChecks.ok(begin > 0 && end > begin);
  let at = 100, reads = 0, retirements = 0;
  const metrics = { states: [], compositionSpans: { samples: [{ frameCount: 1 }], dropped: 2, missing: 1, invalid: 0, beforeStop: null } };
  const realm = { metrics, id: 'generated-prefix-take', performance: { now() { reads++; return at; } }, retireObservations() { retirements++; } };
  spanVM.runInNewContext('globalThis.changed = ({' + source.slice(begin, end) + '}).onState;', realm);
  realm.changed('recording'); at = 200; metrics.compositionSpans.samples.push({ frameCount: 2 }); realm.changed('stopping');
  const prefix = structuredClone(metrics.compositionSpans.beforeStop);
  spanChecks.equal(prefix.wallMs, metrics.states.at(-1).wallMs); spanChecks.equal(reads, 2);
  spanChecks.equal(prefix.retained, 2); spanChecks.equal(prefix.lastRetainedIndex, 1); spanChecks.equal(prefix.received, 5); spanChecks.equal(prefix.takeId, 'generated-prefix-take');
  metrics.compositionSpans.samples.push({ frameCount: 3 }); metrics.compositionSpans.dropped++; at = 300; realm.changed('stopping');
  spanChecks.deepEqual(structuredClone(metrics.compositionSpans.beforeStop), prefix); spanChecks.equal(reads, 3); spanChecks.equal(retirements, 2);
  metrics.compositionSpans = { samples: [], dropped: 0, missing: 0, invalid: 0, beforeStop: null }; realm.changed('stopping');
  spanChecks.equal(metrics.compositionSpans.beforeStop.received, 0); spanChecks.equal(metrics.compositionSpans.beforeStop.lastRetainedIndex, null);
});
