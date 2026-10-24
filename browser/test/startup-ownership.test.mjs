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
async function acknowledgeIssued(f) {
  for (let turnIndex = 0; turnIndex < f.recorders.length; turnIndex++) {
    f.recorders.filter(value => value.startCalls > 0).forEach(value => value.deliverStart()); await turn();
  }
}
async function fixture({ failBeforeEvents = false, heldCheckpoint = false, simulatedClock = false, refuseWarningOnce = false, refuseTerminalCheckpoint = false, heldStops = false, refuseProducerShutdown = false, heldStarts = false, includeCamera = false, audioInput, trackTimers = false, platform = 'Win32', clientPlatform } = {}) {
  const keys = ['isSecureContext', 'navigator', 'OffscreenCanvas', 'VideoFrame', 'MediaStream',
    'MediaStreamTrackProcessor', 'MediaStreamTrackGenerator', 'MediaRecorder', 'Worker', 'document', ...(simulatedClock ? ['performance'] : []), ...(trackTimers ? ['setTimeout', 'clearTimeout'] : [])];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const stopSnapshots = []; let compositorTerminated = false;
  const states = [], recorders = [], saves = [], tracks = [], warnings = [], workerMessages = [], timeouts = [], entered = deferred(), gate = deferred();
  const nativeTimeout = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  let worker, disk, held = false, now = 1, drainSawLive, warningRefused = false;
  class Track extends EventTarget {
    kind = 'video'; readyState = 'live'; enabled = true; muted = false;
    constructor(kind = 'video') { super(); this.kind = typeof kind === 'string' ? kind : kind.kind; tracks.push(this); }
    async applyConstraints(value) { assert.deepEqual(value, { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 30 } }); }
    clone() { return new Track(this.kind); }
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
    state = 'inactive'; startDelivered = false; startCalls = 0; stopCalls = 0; stopEvents = 0;
    constructor(stream, options) { super(); this.mimeType = options.mimeType; this.options = options; this.video = stream.getVideoTracks().length > 0;
      this.addEventListener('stop', () => this.stopEvents++); recorders.push(this); }
    deliverStart() { if (!this.startDelivered) { this.startDelivered = true; this.dispatchEvent(new Event('start')); } }
    start() { this.startCalls++; this.state = 'recording'; if (!failBeforeEvents && !heldStarts) queueMicrotask(() => this.deliverStart()); }
    stop() {
      this.stopCalls++;
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
      workerMessages.push(message.kind);
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
  const globals = {
    ...(trackTimers ? { setTimeout(fn, ms, ...args) { const row = { fn, ms, at: now, cleared: false }; row.id = nativeTimeout(fn, ms, ...args); timeouts.push(row); return row.id; },
      clearTimeout(id) { const row = timeouts.find(value => value.id === id); if (row) row.cleared = true; nativeClear(id); } } : {}),
    document: { createElement() { return { duration: .001, videoWidth: 1280, videoHeight: 720,
    load() { queueMicrotask(() => this.onloadeddata?.()); }, removeAttribute() {} }; } },
    ...(simulatedClock ? { performance: { now: () => now } } : {}), isSecureContext: true, navigator: { platform, ...(clientPlatform !== undefined ? { userAgentData: { platform: clientPlatform } } : {}), storage: { getDirectory() {} } }, OffscreenCanvas: class {},
    VideoFrame: class {}, MediaStream: Stream, MediaStreamTrackGenerator: Generator, MediaRecorder: Recorder,
    Worker: WorkerEndpoint, MediaStreamTrackProcessor: class { readable = new ReadableStream(); } };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  let session; const screenTrack = new Track();
  const audioTrack = audioInput ? new Track('audio') : undefined;
  try {
    session = await createCaptureSession({ id: crypto.randomUUID(), title: 'Controlled startup ownership', mode: includeCamera ? 'screen-camera' : 'screen',
      screen: new Stream([screenTrack, ...(audioInput === 'screen' ? [audioTrack] : [])]),
      ...(includeCamera ? { camera: new Stream([new Track()]) } : {}),
      ...(audioInput === 'microphone' ? { microphone: new Stream([audioTrack]) } : {}), store, persistent: false, backupFolder: false, onState: value => states.push(value),
      onWarning(message, detail) { warnings.push({ message, detail }); if (refuseWarningOnce && !warningRefused) { warningRefused = true; throw new Error('Controlled first warning refusal'); } },
      onCheckpoint(value) { if (refuseTerminalCheckpoint && value.state === 'interrupted') throw new Error('Controlled terminal checkpoint refusal'); } });
  } catch (error) { restore(); throw error; }
  function restore() { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } }
  return { session, states, saves, tracks, recorders, warnings, workerMessages, stopSnapshots,
    endSource: () => screenTrack.dispatchEvent(new Event('ended')),
    activeTimeouts: () => timeouts.filter(value => !value.cleared),
    fireExpired() { for (const value of timeouts.filter(value => !value.cleared && value.at + value.ms <= now)) { value.cleared = true; nativeClear(value.id); value.fn(); } }, releaseStops: () => recorders.filter(value => value.stopCalls > value.stopEvents).forEach(value => value.dispatchEvent(new Event('stop'))), entered: entered.promise, release: gate.resolve,
    stored: () => structuredClone(disk), advance: value => { now += value; }, savedState: () => disk?.state, drainLive: () => drainSawLive,
    fail: () => worker.emit({ kind: 'error', message: 'Controlled compositor failure' }), exists: () => !!disk,
    async close() { gate.resolve(); const canceling = session.cancel();
      if (heldStops) { await turn(); recorders.filter(value => value.stopCalls > value.stopEvents).forEach(value => value.dispatchEvent(new Event('stop'))); }
      try { await canceling; } finally { timeouts.forEach(value => nativeClear(value.id)); restore(); } } };
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
    assert.equal(beforeAck, false); assert.equal(snapshots.length, f.recorders.filter(value => value.startCalls > 0).length);
    assert.equal(f.recorders[0].startCalls, 1); assert.equal(f.recorders[1].startCalls, 0);
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
    assert.equal(beforeAck, false); assert.equal(stops, f.recorders.filter(value => value.startCalls > 0).length);
    assert.equal(f.recorders[0].startCalls, 1); assert.equal(f.recorders[1].startCalls, 0); assert.equal(f.savedState(), 'interrupted');
    assert.ok(f.stored().events.some(value => value.kind === 'producer-shutdown-error' && value.message.includes('Controlled producer shutdown refusal')));
  } finally { await f.close(); }
});


test('cohort admission starts first video and audio-only slots before waiting for a real live first video acknowledgement', { timeout: 5000 }, async () => {
  for (const audioInput of ['screen', 'microphone']) {
    const f = await fixture({ heldStarts: true, includeCamera: true, audioInput });
    const starting = f.session.start(); void starting.catch(() => undefined);
    try {
      await turn(); const first = f.recorders[0], audio = f.recorders.find(value => !value.video);
      const later = f.recorders.filter(value => value.video && value !== first);
      assert.equal(first.startCalls, 1); assert.equal(audio.startCalls, 1); assert.ok(later.every(value => value.startCalls === 0));
      assert.equal(first.options.videoBitsPerSecond, 4000000); assert.equal(f.recorders[1].options.videoBitsPerSecond, 1500000);
      const early = audioInput === 'screen' ? audio : first, last = audioInput === 'screen' ? first : audio;
      early.deliverStart(); await turn(); assert.ok(later.every(value => value.startCalls === 0));
      last.deliverStart(); await turn(); assert.equal(later[0].startCalls, 1); assert.equal(later[1].startCalls, 0);
      later[0].deliverStart(); await turn(); assert.equal(later[1].startCalls, 1);
      later[1].deliverStart(); await starting;
      assert.equal(f.states.at(-1), 'recording');
    } finally { await f.close(); }
  }
});

test('cohort admission keeps the original whole ten-second deadline for a late second cohort', { timeout: 5000 }, async () => {
  const f = await fixture({ heldStarts: true, includeCamera: true, audioInput: 'screen', simulatedClock: true, trackTimers: true });
  const starting = f.session.start().then(() => undefined, error => error.message);
  try {
    await turn(); f.advance(9000); f.recorders.filter(value => value.startCalls > 0).forEach(value => value.deliverStart()); await turn();
    const active = f.activeTimeouts(); assert.equal(active.length, 1); assert.equal(active[0].at + active[0].ms, 10001);
    f.advance(1001); f.fireExpired(); assert.match(await starting, /encoder did not start/);
    const observed = f.warnings.find(value => value.detail?.type === 'encoder-start').detail;
    assert.ok(observed.elapsedMs >= 10000 && observed.elapsedMs < 10002); assert.equal(f.states.at(-1), 'interrupted');
    assert.equal(f.activeTimeouts().length, 0);
  } finally { await f.close(); }
});

test('cohort admission never issues later native starts after Stop, Cancel or source failure', { timeout: 5000 }, async () => {
  for (const terminal of ['stop', 'cancel', 'source']) {
    const f = await fixture({ heldStarts: true, includeCamera: true, audioInput: 'screen' });
    const starting = f.session.start().then(() => undefined, error => error.message);
    try {
      await turn(); const later = f.recorders.filter(value => value.video && value !== f.recorders[0]);
      assert.ok(later.every(value => value.startCalls === 0));
      if (terminal === 'source') f.endSource(); else await f.session[terminal]();
      assert.match(await starting ?? '', /during startup|source ended/); assert.ok(later.every(value => value.startCalls === 0));
      assert.ok(f.tracks.every(value => value.readyState === 'ended'));
    } finally { await f.close(); }
  }
});

test('cohort admission carries an owned pause into every later recorder', { timeout: 5000 }, async () => {
  const f = await fixture({ heldStarts: true, includeCamera: true, audioInput: 'screen' });
  const starting = f.session.start(); void starting.catch(() => undefined);
  try {
    await turn(); await f.session.pause();
    f.recorders.filter(value => value.startCalls > 0).forEach(value => value.deliverStart()); await turn();
    const later = f.recorders.filter(value => value.video && value !== f.recorders[0]);
    assert.equal(later[0].startCalls, 1); assert.equal(later[0].state, 'paused'); assert.equal(later[1].startCalls, 0);
    later[0].deliverStart(); await turn(); assert.equal(later[1].startCalls, 1); assert.equal(later[1].state, 'paused');
    later[1].deliverStart(); await starting;
    assert.equal(f.states.at(-1), 'paused'); assert.ok(f.recorders.every(value => value.state === 'paused'));
    await f.session.resume(); assert.ok(f.recorders.every(value => value.state === 'recording'));
  } finally { await f.close(); }
});


test('cohort admission rejects an inactive native Start even before a terminal owner exists', { timeout: 5000 }, async () => {
  const f = await fixture({ heldStarts: true, includeCamera: true, audioInput: 'screen' });
  const starting = f.session.start().then(() => undefined, error => error.message);
  try {
    await turn(); f.recorders[0].stop();
    assert.match(await starting ?? '', /live start/);
    assert.ok(f.recorders.filter(value => value.video && value !== f.recorders[0]).every(value => value.startCalls === 0));
    assert.equal(f.states.at(-1), 'interrupted');
  } finally { await f.close(); }
});


test('cohort admission rechecks ownership when Cancel follows the last first-cohort acknowledgement', { timeout: 5000 }, async () => {
  const f = await fixture({ heldStarts: true, includeCamera: true, audioInput: 'screen' });
  const starting = f.session.start().then(() => undefined, error => error.message); let canceling;
  try {
    await turn(); f.recorders.find(value => !value.video).deliverStart();
    f.recorders[0].addEventListener('start', () => { canceling = f.session.cancel(); }, { once: true });
    f.recorders[0].deliverStart(); assert.match(await starting ?? '', /during startup/); await canceling;
    assert.ok(f.recorders.filter(value => value.video && value !== f.recorders[0]).every(value => value.startCalls === 0));
    assert.equal(f.exists(), false);
  } finally { await f.close(); }
});


test('platform admission preserves parallel Mac and unknown startup while explicitly selecting Windows only', { timeout: 5000 }, async () => {
  const cases = [
    { platform: 'MacIntel', clientPlatform: 'macOS', cohort: false },
    { platform: 'MacIntel', cohort: false }, { platform: 'unrecognized', cohort: false },
    { platform: 'Win32', clientPlatform: 'Unknown', cohort: false },
    { platform: 'Win32', clientPlatform: null, cohort: false },
    { platform: 'Win32', clientPlatform: 'macOS', cohort: false },
    { platform: 'MacIntel', clientPlatform: 'Windows', cohort: true },
    { platform: 'Win32', clientPlatform: 'Windows', cohort: true }, { platform: 'Win32', cohort: true },
  ];
  for (const input of cases) {
    const f = await fixture({ ...input, heldStarts: true, includeCamera: true, audioInput: 'screen' });
    const starting = f.session.start(); void starting.catch(() => undefined);
    try {
      await turn(); assert.deepEqual(f.recorders.map(value => value.startCalls), input.cohort ? [1, 0, 1, 0] : [1, 1, 1, 1]);
      await acknowledgeIssued(f); await starting;
      const policy = JSON.parse(f.stored().events.find(value => value.kind === 'encoder-admission').message);
      assert.equal(policy.policy, input.cohort ? 'first-video-audio' : 'parallel');
      assert.equal(policy.platformSource, input.clientPlatform === undefined ? 'legacy' : 'client-hint');
      assert.equal(policy.platform, input.clientPlatform === null ? 'unknown' : input.clientPlatform ?? input.platform);
    } finally { await f.close(); }
  }
});

test('platform admission retains terminal ownership and waiter retirement on both branches', { timeout: 5000 }, async () => {
  for (const platform of ['Win32', 'MacIntel']) for (const terminal of ['stop', 'cancel', 'source']) {
    const f = await fixture({ platform, heldStarts: true, includeCamera: true, audioInput: 'screen', simulatedClock: true, trackTimers: true });
    const starting = f.session.start().then(() => undefined, error => error.message);
    try {
      await turn(); const expected = platform === 'Win32' ? [1, 0, 1, 0] : [1, 1, 1, 1];
      assert.deepEqual(f.recorders.map(value => value.startCalls), expected);
      if (terminal === 'source') f.endSource(); else await f.session[terminal]();
      assert.match(await starting ?? '', /during startup|source ended/);
      assert.deepEqual(f.recorders.map(value => value.startCalls), expected); assert.equal(f.activeTimeouts().length, 0);
      assert.ok(f.tracks.every(value => value.readyState === 'ended'));
    } finally { await f.close(); }
  }
});

test('platform admission freezes actual issued slots and still joins their held Stop acknowledgements', { timeout: 5000 }, async () => {
  for (const platform of ['Win32', 'MacIntel']) {
    const f = await fixture({ platform, heldStarts: true, heldStops: true, includeCamera: true, audioInput: 'screen', simulatedClock: true, trackTimers: true });
    let settled = false; const starting = f.session.start().then(() => { settled = true; }, error => { settled = true; return error.message; });
    try {
      await turn(); const expected = platform === 'Win32' ? [1, 0, 1, 0] : [1, 1, 1, 1];
      assert.deepEqual(f.recorders.map(value => value.startCalls), expected);
      assert.equal(f.activeTimeouts().length, 1); assert.equal(f.activeTimeouts()[0].at + f.activeTimeouts()[0].ms, 10001);
      f.advance(10001); f.fireExpired(); await turn();
      const detail = f.warnings.find(value => value.detail?.type === 'encoder-start').detail;
      assert.deepEqual(detail.encoders.map(value => value[2]), expected); assert.deepEqual(detail.encoders.map(value => value[3]), expected);
      assert.deepEqual(detail.encoders.map(value => value[1]), expected.map(value => value ? 'recording' : 'inactive'));
      assert.ok(Object.isFrozen(detail) && Object.isFrozen(detail.encoders)); assert.equal(detail.released, false);
      assert.deepEqual(detail.encoders.map(value => value[4]), [0, 0, 0, 0]);
      assert.equal(settled, false); assert.equal(f.stopSnapshots.length, platform === 'Win32' ? 2 : 4);
      assert.deepEqual(f.recorders.map(value => value.stopCalls), expected);
      assert.deepEqual(f.recorders.map(value => value.stopEvents), [0, 0, 0, 0]);
      assert.ok(f.stopSnapshots.every(value => value.tracksEnded && value.compositorTerminated));
      f.releaseStops(); assert.match(await starting ?? '', /encoder did not start/);
      assert.deepEqual(f.recorders.map(value => value.stopEvents), expected);
      assert.deepEqual(f.recorders.map(value => value.startCalls), expected); assert.equal(f.activeTimeouts().length, 0);
      assert.equal(f.savedState(), 'interrupted');
    } finally { f.releaseStops(); await f.close(); }
  }
});

test('platform admission preserves nonterminal pause and rejects inactive Start on both branches', { timeout: 5000 }, async () => {
  for (const platform of ['Win32', 'MacIntel']) {
    const f = await fixture({ platform, heldStarts: true, includeCamera: true, audioInput: 'screen' });
    const starting = f.session.start(); void starting.catch(() => undefined);
    try {
      await turn(); await f.session.pause();
      await acknowledgeIssued(f); await starting;
      assert.ok(f.recorders.every(value => value.state === 'paused')); await f.session.resume();
      assert.ok(f.recorders.every(value => value.state === 'recording'));
    } finally { await f.close(); }
    const bad = await fixture({ platform, heldStarts: true, includeCamera: true, audioInput: 'screen' });
    const refused = bad.session.start().then(() => undefined, error => error.message);
    try { await turn(); const calls = bad.recorders.map(value => value.startCalls); bad.recorders[0].stop();
      assert.match(await refused ?? '', /live start/); assert.deepEqual(bad.recorders.map(value => value.startCalls), calls);
    } finally { await bad.close(); }
  }
});


test('platform admission rejects a last-acknowledgement Cancel without reviving either branch', { timeout: 5000 }, async () => {
  for (const platform of ['Win32', 'MacIntel']) {
    const f = await fixture({ platform, heldStarts: true, includeCamera: true, audioInput: 'screen' });
    const starting = f.session.start().then(() => undefined, error => error.message); let canceling;
    try {
      await turn(); const issued = f.recorders.filter(value => value.startCalls > 0), last = issued.at(-1);
      const calls = f.recorders.map(value => value.startCalls);
      issued.slice(0, -1).forEach(value => value.deliverStart());
      last.addEventListener('start', () => { canceling = f.session.cancel(); }, { once: true }); last.deliverStart();
      assert.match(await starting ?? '', /during startup/); await canceling;
      assert.deepEqual(f.recorders.map(value => value.startCalls), calls); assert.equal(f.exists(), false);
    } finally { await f.close(); }
  }
});


test('serial remaining video waits for the middle live acknowledgement before issuing the last Windows video', { timeout: 5000 }, async () => {
  const f = await fixture({ heldStarts: true, includeCamera: true, audioInput: 'screen' });
  const starting = f.session.start(); void starting.catch(() => undefined);
  try {
    await turn(); assert.deepEqual(f.recorders.map(value => value.startCalls), [1, 0, 1, 0]);
    f.recorders.filter(value => value.startCalls > 0).forEach(value => value.deliverStart()); await turn();
    assert.deepEqual(f.recorders.map(value => value.startCalls), [1, 1, 1, 0]);
    f.recorders[1].deliverStart(); await turn(); assert.deepEqual(f.recorders.map(value => value.startCalls), [1, 1, 1, 1]);
    f.recorders[3].deliverStart(); await starting; assert.equal(f.states.at(-1), 'recording');
  } finally { await f.close(); }
});

test('serial remaining video does not revive the last slot after middle-acknowledgement Cancel', { timeout: 5000 }, async () => {
  const f = await fixture({ heldStarts: true, includeCamera: true, audioInput: 'screen' });
  const starting = f.session.start().then(() => undefined, error => error.message); let canceling;
  try {
    await turn(); f.recorders.filter(value => value.startCalls > 0).forEach(value => value.deliverStart()); await turn();
    assert.deepEqual(f.recorders.map(value => value.startCalls), [1, 1, 1, 0]);
    f.recorders[1].addEventListener('start', () => { canceling = f.session.cancel(); }, { once: true });
    f.recorders[1].deliverStart(); assert.match(await starting ?? '', /during startup/); await canceling;
    assert.equal(f.recorders[3].startCalls, 0); assert.equal(f.exists(), false);
  } finally { await f.close(); }
});

test('serial remaining video keeps the original deadline after a near-deadline middle acknowledgement', { timeout: 5000 }, async () => {
  const f = await fixture({ heldStarts: true, includeCamera: true, audioInput: 'screen', simulatedClock: true, trackTimers: true });
  const starting = f.session.start().then(() => undefined, error => error.message);
  try {
    await turn(); f.advance(100); f.recorders.filter(value => value.startCalls > 0).forEach(value => value.deliverStart()); await turn();
    assert.deepEqual(f.recorders.map(value => value.startCalls), [1, 1, 1, 0]);
    f.advance(9800); f.recorders[1].deliverStart(); await turn();
    assert.equal(f.recorders[3].startCalls, 1); assert.equal(f.activeTimeouts().length, 1);
    assert.equal(f.activeTimeouts()[0].at + f.activeTimeouts()[0].ms, 10001);
    f.advance(101); f.fireExpired(); assert.match(await starting ?? '', /composed encoder did not start/);
    const detail = f.warnings.find(value => value.detail?.type === 'encoder-start').detail;
    assert.equal(detail.role, 'composed'); assert.ok(detail.elapsedMs >= 10000 && detail.elapsedMs <= 10002);
    assert.equal(f.activeTimeouts().length, 0);
  } finally { await f.close(); }
});

test('serial remaining video rejects an inactive middle Start without issuing composed', { timeout: 5000 }, async () => {
  const f = await fixture({ heldStarts: true, includeCamera: true, audioInput: 'screen' });
  const starting = f.session.start().then(() => undefined, error => error.message);
  try {
    await turn(); f.recorders.filter(value => value.startCalls > 0).forEach(value => value.deliverStart()); await turn();
    assert.deepEqual(f.recorders.map(value => value.startCalls), [1, 1, 1, 0]); f.recorders[1].stop();
    assert.match(await starting ?? '', /camera encoder did not acknowledge a live start/);
    assert.equal(f.recorders[3].startCalls, 0); assert.equal(f.states.at(-1), 'interrupted');
  } finally { await f.close(); }
});

test('serial remaining video retains Stop, Cancel and source owners while waiting for the middle slot', { timeout: 5000 }, async () => {
  for (const terminal of ['stop', 'cancel', 'source']) {
    const f = await fixture({ heldStarts: true, includeCamera: true, audioInput: 'screen' });
    const starting = f.session.start().then(() => undefined, error => error.message);
    try {
      await turn(); f.recorders.filter(value => value.startCalls > 0).forEach(value => value.deliverStart()); await turn();
      assert.deepEqual(f.recorders.map(value => value.startCalls), [1, 1, 1, 0]);
      if (terminal === 'source') f.endSource(); else await f.session[terminal]();
      assert.match(await starting ?? '', /during startup|source ended/); assert.equal(f.recorders[3].startCalls, 0);
      assert.ok(f.tracks.every(value => value.readyState === 'ended'));
    } finally { await f.close(); }
  }
});

test('serial startup failure still waits for each issued native Stop acknowledgement and proves no process retirement', { timeout: 5000 }, async () => {
  const f = await fixture({ heldStarts: true, heldStops: true, includeCamera: true, audioInput: 'screen', simulatedClock: true, trackTimers: true });
  let settled = false; const starting = f.session.start().then(() => { settled = true; }, error => { settled = true; return error.message; });
  try {
    await turn(); f.recorders.filter(value => value.startCalls > 0).forEach(value => value.deliverStart()); await turn();
    assert.deepEqual(f.recorders.map(value => value.startCalls), [1, 1, 1, 0]); f.advance(10001); f.fireExpired(); await turn();
    assert.equal(settled, false); assert.deepEqual(f.recorders.map(value => value.stopCalls), [1, 1, 1, 0]);
    assert.deepEqual(f.recorders.map(value => value.stopEvents), [0, 0, 0, 0]);
    assert.ok(f.stopSnapshots.every(value => value.tracksEnded && value.compositorTerminated));
    f.releaseStops(); assert.match(await starting ?? '', /camera encoder did not start/);
    assert.deepEqual(f.recorders.map(value => value.stopEvents), [1, 1, 1, 0]);
    assert.equal(f.recorders[3].startCalls, 0); assert.equal(f.activeTimeouts().length, 0);
  } finally { f.releaseStops(); await f.close(); }
});
