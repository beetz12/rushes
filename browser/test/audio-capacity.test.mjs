// Actual parent bridge, controlled stream/worker transport only. Real PCM mixing
// and recording acceptance remain in composed-audio/capture/matrix tests.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as bridgeCompiler from 'esbuild';
import * as bridgeFiles from 'node:fs/promises';
import * as bridgeSystem from 'node:os';
import * as bridgePaths from 'node:path';
import * as bridgeURLs from 'node:url';
const root = await bridgeFiles.mkdtemp(bridgePaths.join(bridgeSystem.tmpdir(), 'rushes-audio-capacity-'));
after(() => bridgeFiles.rm(root, { recursive: true, force: true }));
const bundle = await bridgeCompiler.build({ entryPoints: [bridgeURLs.fileURLToPath(new URL('../src/capture/audio.ts', import.meta.url))],
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false });
const moduleFile = bridgePaths.join(root, 'audio.mjs'); await bridgeFiles.writeFile(moduleFile, bundle.outputFiles[0].contents);
const { composedAudio } = await import(bridgeURLs.pathToFileURL(moduleFile).href);
const task = () => new Promise(resolve => setImmediate(resolve));
const bounded = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Controlled transport did not settle')), 2000);
  })]); } finally { clearTimeout(timer); }
};

function transport({ hold = false, now, stopReceipt = true, onFailure, writeGate } = {}) {
  const keys = ['AudioData', 'MediaStreamTrackProcessor', 'MediaStreamTrackGenerator', 'Worker', ...(now ? ['performance'] : [])];
  const original = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const records = [], failures = [], frames = [[], []], outputs = [], clones = [], unacknowledged = [0, 0], peak = [0, 0];
  let worker, receiptCount = 0, allResolve, fullResolve, failureResolve;
  const all = new Promise(resolve => { allResolve = resolve; });
  const full = new Promise(resolve => { fullResolve = resolve; });
  const failed = new Promise(resolve => { failureResolve = resolve; });
  class Frame {
    numberOfChannels = 1; numberOfFrames = 800; sampleRate = 48000; closed = false; copied = false;
    constructor(source, index) {
      if (typeof source === 'object') {
        Object.assign(this, { numberOfChannels: source.numberOfChannels, numberOfFrames: source.numberOfFrames,
          sampleRate: source.sampleRate, timestamp: source.timestamp }); outputs.push(this);
      } else { this.source = source; this.timestamp = 100000 + Math.round(index * 800 * 1e6 / 48000); }
    }
    copyTo(target, options) { assert.equal(this.closed, false); assert.equal(options.planeIndex, 0); this.copied = true; target.fill((this.source + 1) / 4); }
    close() { assert.equal(this.closed, false); this.closed = true; }
  }
  class Track {
    readyState = 'live'; kind = 'audio';
    constructor(readable) { this.readable = readable; }
    clone() { const value = new Track(this.readable); clones.push(value); return value; }
    stop() { this.readyState = 'ended'; }
  }
  const controllers = [];
  const sources = [0, 1].map(source => new Track(new ReadableStream({ start(controller) { controllers[source] = controller; } })));
  class Processor {
    constructor(options) { assert.equal(options.maxBufferSize, 25); this.readable = options.track.readable; }
  }
  class Generator extends Track { constructor() { super(); this.writable = new WritableStream({ write: () => writeGate }); } }
  class ControlledWorker {
    constructor() { worker = this; }
    emit(data) { this.onmessage({ data }); }
    postMessage(message, transfer) {
      if (message.kind === 'setup') { queueMicrotask(() => this.emit({ kind: 'ready' })); return; }
      if (message.kind === 'stop') { if (stopReceipt) setImmediate(() => this.emit({ kind: 'stopped' })); return; }
      assert.equal(message.kind, 'input');
      const accepted = structuredClone(message, { transfer });
      records.push(accepted); // The controlled consumer has accepted these exact bytes already.
      assert.notEqual(accepted.left.buffer, accepted.right.buffer);
      const source = accepted.source, count = accepted.left.length;
      unacknowledged[source] += count; peak[source] = Math.max(peak[source], unacknowledged[source]);
      if (records.length === 30) fullResolve();
      if (!hold) setImmediate(() => {
        unacknowledged[source] -= count;
        this.emit({ kind: 'consumed', source, frames: count });
        if (++receiptCount === 32) allResolve();
      });
    }
    terminate() {}
  }
  for (const [key, value] of Object.entries({ AudioData: Frame, MediaStreamTrackProcessor: Processor,
    MediaStreamTrackGenerator: Generator, Worker: ControlledWorker, ...(now ? { performance: { now } } : {}) }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const mix = composedAudio(sources, message => { failures.push(message); failureResolve(); onFailure?.(message); });
  return { mix, sources, clones, records, failures, frames, outputs, peak, all, full, failed,
    emit: data => worker.emit(data),
    burst() {
      for (let index = 0; index < 16; index++) for (const source of [0, 1]) {
        const frame = new Frame(source, index); frames[source].push(frame); controllers[source].enqueue(frame);
      }
    },
    async close() {
      mix.close(); worker.emit({ kind: 'stopped' }); await task();
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
      }
    } };
}

test('buffered reads wait for task receipts without losing input bytes or exceeding250ms capacity', async () => {
  const f = transport();
  try {
    await f.mix.start(); f.burst(); await bounded(Promise.race([f.all, f.failed]));
    assert.deepEqual(f.failures, []); assert.equal(f.records.length, 32);
    assert.ok(f.peak.every(value => value <= 12000));
    for (const source of [0, 1]) {
      const rows = f.records.filter(row => row.source === source);
      assert.deepEqual(rows.map(row => row.timestamp), f.frames[source].map(frame => frame.timestamp));
      for (const row of rows) {
        assert.equal(row.rate, 48000); assert.equal(row.left.length, 800); assert.equal(row.right.length, 800);
        assert.ok(row.left.every(value => value === (source + 1) / 4));
        assert.ok(row.right.every(value => value === (source + 1) / 4));
      }
      assert.ok(f.frames[source].every(frame => frame.closed));
    }
    assert.ok(f.sources.every(source => source.readyState === 'live'));
  } finally { await f.close(); }
});

test('a missing capacity receipt fails instead of holding a native input indefinitely', async () => {
  const f = transport({ hold: true });
  try {
    await f.mix.start(); const waitingAt = performance.now(); f.burst(); await bounded(f.failed); await task();
    assert.equal(f.failures.length, 1); assert.match(f.failures[0], /capacity receipt timed out/);
    assert.equal(f.records.length, 30); assert.ok(f.frames.every(rows => rows[15].closed));
    assert.equal(f.mix.track.readyState, 'ended');
    const detail = f.mix.diagnostics.parentFailure;
    assert.equal(detail.schema, 1); assert.equal(detail.edge, 'timer');
    assert.deepEqual(detail.pending, [12000, 12000]); assert.deepEqual(detail.posted, [15, 15]);
    assert.deepEqual(detail.consumed, [0, 0]); assert.deepEqual(detail.input.slice(1), [800, 48000]);
    assert.ok([0, 1].includes(detail.input[0]));
    assert.ok(Number.isSafeInteger(detail.waitMs) && detail.waitMs >= 0 && detail.waitMs <= Math.ceil(performance.now() - waitingAt));
    assert.equal(detail.closed, false); assert.equal(detail.quiesced, false); assert.equal(detail.readied, true);
    assert.deepEqual(detail.output, [0, null, 0, 0]); assert.equal(detail.writing, false);
    assert.ok(Object.isFrozen(detail) && Object.isFrozen(detail.pending) && Object.isFrozen(detail.input));
    f.emit({ kind: 'timing', diagnostics: { late: true } });
    assert.equal(f.mix.diagnostics.parentFailure, detail);
  } finally { await f.close(); }
});

test('a late receipt cannot win a delayed timeout callback', async () => {
  let now = 0; const f = transport({ hold: true, now: () => now });
  try {
    await f.mix.start(); f.burst(); await bounded(f.full); await task();
    now = 251; for (const source of [0, 1]) f.emit({ kind: 'consumed', source, frames: 800 });
    await task();
    assert.equal(f.failures.length, 1);
    assert.match(f.failures[0], /capacity receipt timed out/); assert.equal(f.records.length, 30);
    assert.ok(f.frames.every(rows => rows[15].closed));
    assert.equal(f.mix.diagnostics.parentFailure.edge, 'late-wake');
    assert.equal(f.mix.diagnostics.parentFailure.waitMs, 251);
  } finally { await f.close(); }
});

test('partial receipts do not restart the held packet deadline', async () => {
  let now = 0; const f = transport({ hold: true, now: () => now });
  try {
    await f.mix.start(); f.burst(); await bounded(f.full); await task();
    now = 100; for (const source of [0, 1]) f.emit({ kind: 'consumed', source, frames: 200 }); await task();
    assert.equal(f.records.length, 30); assert.equal(f.frames[0][15].copied, false);
    now = 251; for (const source of [0, 1]) f.emit({ kind: 'consumed', source, frames: 200 });
    await task(); assert.equal(f.failures.length, 1); assert.match(f.failures[0], /capacity receipt timed out/);
    assert.equal(f.records.length, 30);
  } finally { await f.close(); }
});

test('quiescence releases held frames but still waits for the actual stopped receipt', async () => {
  const f = transport({ hold: true, stopReceipt: false });
  try {
    await f.mix.start(); f.burst(); await bounded(f.full); await task();
    let stopped = false; const ending = f.mix.quiesce().then(() => { stopped = true; }); await task();
    assert.equal(stopped, false); assert.deepEqual(f.failures, []); assert.equal(f.records.length, 30);
    assert.ok(f.frames.every(rows => rows[15].closed && !rows[15].copied));
    f.emit({ kind: 'stopped' }); await bounded(ending); assert.equal(stopped, true);
    assert.equal(f.mix.track.readyState, 'live');
  } finally { await f.close(); }
});

test('worker ring failures remain fatal while capacity is parked', async () => {
  const f = transport({ hold: true });
  try {
    await f.mix.start(); f.burst(); await bounded(f.full); await task();
    f.emit({ kind: 'error', message: 'Actual worker ring exceeded250ms', diagnostics: { generated: true } });
    await bounded(f.failed); await task();
    assert.match(f.failures[0], /Actual worker ring exceeded250ms/);
    assert.equal(f.records.length, 30); assert.ok(f.frames.every(rows => rows[15].closed));
    assert.equal(f.mix.track.readyState, 'ended');
  } finally { await f.close(); }
});

test('close releases held frames without posting them or stopping the original inputs', async () => {
  const f = transport({ hold: true });
  try {
    await f.mix.start(); f.burst(); await bounded(f.full); await task();
    f.mix.close(); await task();
    assert.equal(f.records.length, 30); assert.deepEqual(f.failures, []);
    assert.ok(f.frames.every(rows => rows[15].closed && !rows[15].copied));
    assert.ok(f.sources.every(source => source.readyState === 'live'));
    assert.equal(f.mix.track.readyState, 'ended');
  } finally { await f.close(); }
});

test('invalid receipt credits cannot free capacity', async () => {
  for (const receipt of [{ source: 2, frames: 800 }, { source: 0, frames: 0 },
    { source: 0, frames: NaN }, { source: 0, frames: 12001 }]) {
    const f = transport({ hold: true });
    try {
      await f.mix.start(); f.burst(); await bounded(f.full); await task();
      f.emit({ kind: 'consumed', ...receipt }); await task();
      assert.deepEqual(f.failures, ['Invalid audio input receipt']);
      assert.equal(f.records.length, 30); assert.ok(f.frames.every(rows => rows[15].closed));
    } finally { await f.close(); }
  }
});

test('Stop before the receipt deadline stays earlier than a delayed continuation', async () => {
  let now = 0; const f = transport({ hold: true, now: () => now });
  try {
    await f.mix.start(); f.burst(); await bounded(f.full); await task();
    now = 240; const ending = f.mix.quiesce(); now = 300;
    await bounded(ending); await task();
    assert.deepEqual(f.failures, []); assert.equal(f.records.length, 30);
    assert.ok(f.frames.every(rows => rows[15].closed && !rows[15].copied));
  } finally { await f.close(); }
});

test('Stop after the receipt deadline cannot hide the earlier capacity failure', async () => {
  let now = 0; const f = transport({ hold: true, now: () => now });
  try {
    await f.mix.start(); f.burst(); await bounded(f.full); await task();
    now = 251; const ending = assert.rejects(f.mix.quiesce(), /closed before its mixer stop acknowledgement/);
    await bounded(f.failed); await ending; await task();
    assert.match(f.failures[0], /capacity receipt timed out/); assert.equal(f.records.length, 30);
  } finally { await f.close(); }
});


test('fatal audio ownership is closed before a synchronous failure consumer is notified', async () => {
  let observed;
  const f = transport({ onFailure: message => {
    observed = { message, clones: f.clones.map(track => track.readyState), output: f.mix.track.readyState,
      originals: f.sources.map(track => track.readyState) };
    f.mix.close(); // A reentrant consumer cannot reclaim or duplicate ownership.
  } });
  try {
    await f.mix.start(); f.emit({ kind: 'error', message: 'Controlled fatal worker failure', diagnostics: {} });
    assert.deepEqual(observed, { message: 'Audio composition failed: Controlled fatal worker failure', clones: ['ended', 'ended'],
      output: 'ended', originals: ['live', 'live'] });
    assert.deepEqual(f.failures, ['Audio composition failed: Controlled fatal worker failure']);
  } finally { await f.close(); }
});
test('a throwing audio failure consumer still observes already-closed ownership', async () => {
  const refused = new Error('Controlled consumer refusal'); let observed;
  const f = transport({ onFailure: () => {
    observed = [...f.clones.map(track => track.readyState), f.mix.track.readyState]; throw refused;
  } });
  try {
    await f.mix.start();
    assert.throws(() => f.emit({ kind: 'error', message: 'Controlled fatal worker failure', diagnostics: {} }), error => error === refused);
    assert.deepEqual(observed, ['ended', 'ended', 'ended']);
    assert.deepEqual(f.failures, ['Audio composition failed: Controlled fatal worker failure']);
  } finally { await f.close(); }
});

test('cleanup refusal cannot suppress the original audio failure notification', async () => {
  const f = transport(), refused = new Error('Controlled output close refusal');
  const stop = f.mix.track.stop;
  try {
    await f.mix.start(); f.mix.track.stop = () => { throw refused; };
    assert.throws(() => f.emit({ kind: 'error', message: 'Original controlled audio failure', diagnostics: {} }), error => error === refused);
    assert.deepEqual(f.failures, ['Audio composition failed: Original controlled audio failure']);
  } finally { f.mix.track.stop = stop; stop.call(f.mix.track); await f.close(); }
});

test('expiry before waiting captures the actual held packet without posting it', async () => {
  let f, calls = 0;
  f = transport({ hold: true, now: () => f?.records.length === 30 ? (calls++ ? 251 : 0) : 0 });
  try {
    await f.mix.start(); f.burst(); await bounded(f.failed); await task();
    assert.equal(f.mix.diagnostics.parentFailure.edge, 'before-wait');
    assert.equal(f.mix.diagnostics.parentFailure.waitMs, 251);
    assert.equal(f.records.length, 30); assert.ok(f.frames.every(rows => rows[15].closed));
  } finally { await f.close(); }
});

test('capacity failure snapshots a pending output write before its separate one-second limit', async () => {
  let release; const writeGate = new Promise(resolve => { release = resolve; });
  const f = transport({ hold: true, writeGate });
  try {
    await f.mix.start();
    f.emit({ kind: 'packet', sequence: 0, timestamp: 100000, data: new Float32Array(960) }); await task();
    f.burst(); await bounded(f.failed); await task();
    const detail = f.mix.diagnostics.parentFailure;
    assert.equal(detail.edge, 'timer'); assert.equal(detail.writing, true);
    assert.deepEqual(detail.output, [1, 0, 0, 0]);
    assert.ok(Number.isSafeInteger(detail.writeAgeMs) && detail.writeAgeMs >= 0);
    assert.equal(detail.closed, false); assert.equal(f.mix.track.readyState, 'ended');
    release(); await task(); await task();
    assert.equal(f.outputs.length, 1); assert.ok(f.outputs.every(frame => frame.closed));
    assert.equal(f.mix.diagnostics.parentFailure, detail); assert.equal(detail.writing, true);
    assert.ok(f.sources.every(track => track.readyState === 'live'));
  } finally { release(); await f.close(); }
});

test('nonfatal transport status is frozen at observation without inventing a failure', async () => {
  let now = 0; const f = transport({ hold: true, now: () => now });
  try {
    await f.mix.start(); const before = f.mix.status();
    assert.equal(before.readied, true); assert.deepEqual(before.pending, [0, 0]); assert.equal(before.lastAgeMs, 0);
    f.burst(); await bounded(f.full); await task(); now = 100;
    const current = f.mix.status();
    assert.deepEqual(current.pending, [12000, 12000]); assert.deepEqual(current.posted, [15, 15]);
    assert.deepEqual(current.consumed, [0, 0]); assert.equal(current.lastAgeMs, 100);
    assert.equal(current.closed, false); assert.equal(current.quiesced, false);
    assert.deepEqual(before.pending, [0, 0]); assert.deepEqual(before.posted, [0, 0]);
    assert.ok(Object.isFrozen(current) && Object.isFrozen(current.pending) && Object.isFrozen(current.output));
    assert.equal(f.mix.diagnostics?.parentFailure, undefined); assert.deepEqual(f.failures, []);
    f.mix.close(); assert.equal(f.mix.status().closed, true); assert.equal(current.closed, false);
  } finally { await f.close(); }
});
