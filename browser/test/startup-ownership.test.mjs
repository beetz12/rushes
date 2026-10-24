// Actual coordinator; controlled lifecycle/transport only, no encoded-media claim.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as ownershipCompiler from 'esbuild';
import * as ownershipFiles from 'node:fs/promises';
import * as ownershipSystem from 'node:os';
import * as ownershipPaths from 'node:path';
import * as ownershipURLs from 'node:url';
const root = await ownershipFiles.mkdtemp(ownershipPaths.join(ownershipSystem.tmpdir(), 'rushes-start-ownership-'));
after(() => ownershipFiles.rm(root, { recursive: true, force: true }));
const compiled = await ownershipCompiler.build({ entryPoints: [ownershipURLs.fileURLToPath(new URL('../src/capture/index.ts', import.meta.url))],
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false });
const path = ownershipPaths.join(root, 'capture.mjs'); await ownershipFiles.writeFile(path, compiled.outputFiles[0].contents);
const { createCaptureSession } = await import(ownershipURLs.pathToFileURL(path).href);
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; }
async function fixture({ failBeforeEvents = false, heldCheckpoint = false, simulatedClock = false, refuseWarningOnce = false, refuseTerminalCheckpoint = false, heldStops = false, refuseProducerShutdown = false } = {}) {
  const keys = ['isSecureContext', 'navigator', 'OffscreenCanvas', 'VideoFrame', 'MediaStream',
    'MediaStreamTrackProcessor', 'MediaStreamTrackGenerator', 'MediaRecorder', 'Worker', 'document', ...(simulatedClock ? ['performance'] : [])];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const stopSnapshots = []; let compositorTerminated = false;
  const states = [], recorders = [], saves = [], tracks = [], entered = deferred(), gate = deferred();
  let worker, disk, held = false, now = 1, drainSawLive, warningRefused = false;
  class Track extends EventTarget {
    kind = 'video'; readyState = 'live'; enabled = true; muted = false;
    constructor() { super(); tracks.push(this); }
    async applyConstraints(value) { assert.deepEqual(value, { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 30 } }); }
    clone() { return new Track(); }
    stop() { this.readyState = 'ended'; }
  }
  class Stream {
    constructor(values = []) { this.tracks = [...values]; }
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter(value => value.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter(value => value.kind === 'audio'); }
    addTrack(value) { this.tracks.push(value); }
  }
  class Generator extends Track { writable = new WritableStream(); }
  class Recorder extends EventTarget {
    static isTypeSupported() { return true; }
    state = 'inactive'; startDelivered = false;
    constructor(_stream, options) { super(); this.mimeType = options.mimeType; recorders.push(this); }
    deliverStart() { if (!this.startDelivered) { this.startDelivered = true; this.dispatchEvent(new Event('start')); } }
    start() { this.state = 'recording'; if (!failBeforeEvents) queueMicrotask(() => this.deliverStart()); }
    stop() {
      stopSnapshots.push({ tracksEnded: tracks.every(value => value.readyState === 'ended'), compositorTerminated });
      this.state = 'inactive'; queueMicrotask(() => { this.deliverStart(); if (!heldStops) this.dispatchEvent(new Event('stop')); });
    }
    requestData() { queueMicrotask(() => { const event = new Event('dataavailable'); event.data = new Blob(); this.dispatchEvent(event); }); }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
  }
  class WorkerEndpoint {
    constructor() { worker = this; }
    emit(data) {
      try { this.onmessage({ data }); } catch (error) {
        if (!refuseWarningOnce || error.message !== 'Controlled first warning refusal') throw error;
        recorders.forEach(value => value.deliverStart());
      }
    }
    postMessage(message) {
      if (message.kind === 'setup') queueMicrotask(() => this.emit({ kind: 'ready' }));
      if (message.kind === 'start' && failBeforeEvents) queueMicrotask(() => this.emit({ kind: 'error', message: 'Controlled compositor failure' }));
    }
    terminate() { compositorTerminated = true; if (refuseProducerShutdown) throw new Error('Controlled producer shutdown refusal'); }
  }
  let storeTail = Promise.resolve();
  const serialized = operation => { const result = storeTail.then(operation); storeTail = result.catch(() => undefined); return result; };
  const store = {
    create: value => serialized(async () => { disk = structuredClone(value); }),
    save: value => serialized(async () => {
      saves.push(value.state);
      if (heldCheckpoint && !held && value.state === 'recording') { held = true; entered.resolve(); await gate.promise; }
      disk = structuredClone(value);
    }),
    load: () => serialized(async () => { if (!disk) throw new Error('Controlled draft absent'); return structuredClone(disk); }),
    remove: () => serialized(async () => { disk = undefined; }),
    readSnapshot: () => serialized(async () => {
      drainSawLive ??= tracks.every(value => value.readyState === 'live');
      return { manifest: structuredClone(disk), tracks: new Map(disk.tracks.map(value => [value.kind, new Blob(['controlled extent double'])])),
        read: { queueWaitMs: 0, integrityMs: 0, assemblyMs: 0, chunks: 0, bytes: 0 } };
    }),
  };
  const globals = { document: { createElement() { return { duration: .001, videoWidth: 1280, videoHeight: 720,
    load() { queueMicrotask(() => this.onloadeddata?.()); }, removeAttribute() {} }; } },
    ...(simulatedClock ? { performance: { now: () => now } } : {}), isSecureContext: true, navigator: { storage: { getDirectory() {} } }, OffscreenCanvas: class {},
    VideoFrame: class {}, MediaStream: Stream, MediaStreamTrackGenerator: Generator, MediaRecorder: Recorder,
    Worker: WorkerEndpoint, MediaStreamTrackProcessor: class { readable = new ReadableStream(); } };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  let session;
  try {
    session = await createCaptureSession({ id: crypto.randomUUID(), title: 'Controlled startup ownership', mode: 'screen',
      screen: new Stream([new Track()]), store, persistent: false, backupFolder: false, onState: value => states.push(value),
      onWarning() { if (refuseWarningOnce && !warningRefused) { warningRefused = true; throw new Error('Controlled first warning refusal'); } },
      onCheckpoint(value) { if (refuseTerminalCheckpoint && value.state === 'interrupted') throw new Error('Controlled terminal checkpoint refusal'); } });
  } catch (error) { restore(); throw error; }
  function restore() { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } }
  return { session, states, saves, tracks, recorders, stopSnapshots, releaseStops: () => recorders.forEach(value => value.dispatchEvent(new Event('stop'))), entered: entered.promise, release: gate.resolve,
    stored: () => structuredClone(disk), advance: value => { now += value; }, savedState: () => disk?.state, drainLive: () => drainSawLive,
    fail: () => worker.emit({ kind: 'error', message: 'Controlled compositor failure' }), exists: () => !!disk,
    async close() { gate.resolve(); if (heldStops) recorders.forEach(value => value.dispatchEvent(new Event('stop'))); try { await session.cancel(); } finally { restore(); } } };
}
test('late native start events after compositor failure cannot resolve startup successfully', { timeout: 5000 }, async () => {
  const f = await fixture({ failBeforeEvents: true });
  try {
    const error = await f.session.start().then(() => undefined, error => error.message);
    assert.match(error ?? '', /Controlled compositor failure/);
    assert.equal(f.states.at(-1), 'interrupted'); assert.ok(f.recorders.every(value => value.state === 'inactive'));
    assert.ok(f.tracks.every(value => value.readyState === 'ended'));
    assert.equal(f.saves.filter(value => value === 'recording').length, 0);
  } finally { await f.close(); }
});
test('failure during the initial checkpoint rejects startup after terminal persistence', { timeout: 5000 }, async () => {
  const f = await fixture({ heldCheckpoint: true });
  try {
    const starting = f.session.start().then(() => undefined, error => error.message); await f.entered;
    f.fail(); await turn(); f.release();
    assert.match(await starting ?? '', /Controlled compositor failure/);
    assert.equal(f.states.at(-1), 'interrupted'); assert.equal(f.saves.at(-1), 'interrupted');
  } finally { await f.close(); }
});
test('cancel joins an issued initial checkpoint before removing its draft and rejecting startup', { timeout: 5000 }, async () => {
  const f = await fixture({ heldCheckpoint: true });
  try {
    const starting = f.session.start().then(() => undefined, error => error.message); await f.entered;
    let canceled = false; const canceling = f.session.cancel().then(() => { canceled = true; }); await turn();
    const beforeRelease = canceled; f.release(); await canceling; const error = await starting;
    assert.equal(beforeRelease, false); assert.match(error ?? '', /during startup/); assert.equal(f.exists(), false);
    assert.equal(f.states.at(-1), 'failed');
  } finally { await f.close(); }
});
test('ordinary startup and a pause during the initial checkpoint remain successful', { timeout: 5000 }, async () => {
  for (const heldCheckpoint of [false, true]) {
    const f = await fixture({ heldCheckpoint });
    try {
      const starting = f.session.start();
      if (heldCheckpoint) { await f.entered; const pausing = f.session.pause(); f.release(); await pausing; }
      await starting; assert.equal(f.states.at(-1), heldCheckpoint ? 'paused' : 'recording');
      assert.ok(f.recorders.every(value => value.state === (heldCheckpoint ? 'paused' : 'recording')));
    } finally { await f.close(); }
  }
});

test('an intentional Stop retains its valid owned drain while startup rejects after the checkpoint', { timeout: 5000 }, async () => {
  const f = await fixture({ heldCheckpoint: true });
  try {
    const starting = f.session.start().then(() => undefined, error => error.message); await f.entered;
    const stopping = f.session.stop(); f.release();
    const [error, manifest] = await Promise.all([starting, stopping]);
    assert.match(error ?? '', /during startup/); assert.equal(manifest.state, 'complete');
    assert.equal(manifest.recoveryNote, undefined); assert.equal(f.savedState(), 'complete');
    assert.equal(f.drainLive(), true); assert.deepEqual(f.states, ['recording', 'stopping', 'complete']);
  } finally { await f.close(); }
});
test('automatic Stop claimed synchronously at deadline arming also owns startup completion', { timeout: 5000 }, async () => {
  const f = await fixture({ heldCheckpoint: true, simulatedClock: true });
  try {
    const starting = f.session.start().then(() => undefined, error => error.message); await f.entered;
    f.advance(600010); f.release();
    assert.match(await starting ?? '', /Automatic stop was delayed beyond the take limit/);
    const manifest = await f.session.stop(); assert.equal(manifest.state, 'interrupted');
    assert.match(manifest.recoveryNote, /Automatic stop was delayed/);
  } finally { await f.close(); }
});

test('a refused first failure callback does not fabricate a cleanup owner', { timeout: 5000 }, async () => {
  const f = await fixture({ failBeforeEvents: true, refuseWarningOnce: true });
  try {
    await assert.rejects(f.session.start(), /Controlled compositor failure/);
    assert.equal(f.savedState(), 'interrupted'); assert.equal(f.states.at(-1), 'interrupted');
    assert.ok(f.tracks.every(value => value.readyState === 'ended'));
  } finally { await f.close(); }
});
test('the first failure remains primary and an existing owner rejection survives as cause', { timeout: 5000 }, async () => {
  const f = await fixture({ failBeforeEvents: true, refuseTerminalCheckpoint: true });
  try {
    const error = await f.session.start().then(() => undefined, value => value);
    assert.match(error?.message ?? '', /Controlled compositor failure/);
    assert.match(error.cause?.message ?? '', /Controlled terminal checkpoint refusal/);
    assert.equal(f.savedState(), 'interrupted'); assert.ok(f.tracks.every(value => value.readyState === 'ended'));
  } finally { await f.close().catch(error => assert.match(error.message, /Controlled terminal checkpoint refusal/)); }
});

test('fatal Stop requests owned producer shutdown first but still awaits real stop acknowledgements', { timeout: 5000 }, async () => {
  const f = await fixture({ failBeforeEvents: true, heldStops: true });
  try {
    let settled = false;
    const starting = f.session.start().then(() => { settled = true; }, error => { settled = true; return error.message; });
    await turn(); const beforeAck = settled;
    const snapshots = structuredClone(f.stopSnapshots); f.releaseStops();
    assert.match(await starting ?? '', /Controlled compositor failure/);
    assert.equal(beforeAck, false); assert.equal(snapshots.length, 2);
    assert.ok(snapshots.every(value => value.tracksEnded && value.compositorTerminated));
    assert.equal(f.savedState(), 'interrupted');
  } finally { await f.close(); }
});

test('a fatal producer shutdown refusal cannot skip native Stop or its acknowledgement join', { timeout: 5000 }, async () => {
  const f = await fixture({ failBeforeEvents: true, heldStops: true, refuseProducerShutdown: true });
  try {
    let settled = false;
    const starting = f.session.start().then(() => { settled = true; }, error => { settled = true; return error.message; });
    await turn(); const beforeAck = settled; const stops = f.stopSnapshots.length; f.releaseStops();
    assert.match(await starting ?? '', /Controlled compositor failure/);
    assert.equal(beforeAck, false); assert.equal(stops, 2); assert.equal(f.savedState(), 'interrupted');
    assert.ok(f.stored().events.some(value => value.kind === 'producer-shutdown-error' && value.message.includes('Controlled producer shutdown refusal')));
  } finally { await f.close(); }
});
