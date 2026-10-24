import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeEncoderControl } from './matrix-native-encoder-control.mjs';

function harness({ constructorFails = false, stopEvent = true, syntheticStart = false, stopAdvanceMs = 0 } = {}) {
  let time = 0, nextTimer = 0, recorder;
  const timers = new Map(), clones = [];
  const source = { kind: 'video', readyState: 'live', stops: 0,
    stop() { this.stops++; this.readyState = 'ended'; },
    clone() { const track = { kind: 'video', readyState: 'live', stop() { this.readyState = 'ended'; } }; clones.push(track); return track; } };
  class Stream { constructor(tracks) { this.tracks = tracks; } }
  class Recorder {
    static isTypeSupported(value) { return value === 'video/webm;codecs=vp8'; }
    constructor(stream, options) {
      if (constructorFails) throw new Error('constructor failure');
      recorder = this; this.stream = stream; this.options = options; this.mimeType = options.mimeType;
      this.state = 'inactive'; this.listeners = new Map();
    }
    addEventListener(name, listener) { const values = this.listeners.get(name) ?? []; values.push(listener); this.listeners.set(name, values); }
    emit(name, value = {}) { for (const listener of this.listeners.get(name) ?? []) listener(value); }
    start(timeslice) { this.timeslice = timeslice; this.state = 'recording'; }
    pause() { this.state = 'paused'; this.emit('pause'); }
    resume() { this.state = 'recording'; this.emit('resume'); }
    stop() { time += stopAdvanceMs; this.state = 'inactive'; if (syntheticStart) this.emit('start'); if (stopEvent) this.emit('stop'); }
  }
  const dependencies = { Recorder, Stream, now: () => time,
    schedule(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, due: time + delay }); return id; },
    unschedule(id) { timers.delete(id); } };
  return { source, clones, dependencies, recorder: () => recorder,
    advance(value, deliverTimers = true) { time += value; if (!deliverTimers) return; for (const [id, timer] of [...timers]) if (timer.due <= time) { timers.delete(id); timer.callback(); } } };
}

test('raw control requires a real live start callback and owns only its one native clone', async () => {
  const h = harness(), control = createNativeEncoderControl(h.source, h.dependencies), recorder = h.recorder();
  let resolved = false; const starting = control.start().then(() => { resolved = true; });
  await Promise.resolve(); assert.equal(resolved, false); assert.equal(recorder.state, 'recording');
  assert.equal(h.clones.length, 1); assert.deepEqual(recorder.stream.tracks, h.clones);
  assert.deepEqual(recorder.options, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 4_000_000 });
  assert.equal(recorder.timeslice, 2000);
  recorder.emit('start'); await starting;
  for (let index = 0; index < 5; index++) { control.pause(); h.advance(100); control.resume(); h.advance(1500); }
  recorder.emit('dataavailable', { data: new Blob(['native fixture bytes']) });
  const firstStop = control.stop(); assert.equal(control.stop(), firstStop); await firstStop;
  const row = control.snapshot(); assert.equal(row.stopEvents, 1); assert.equal(row.cloneEnded, true);
  assert.equal(row.originalLive, true); assert.equal(h.source.stops, 0); assert.equal(row.failures.length, 0);
  assert.equal(row.rows.filter(value => value.kind === 'pause-event').length, 5);
  assert.equal(await control.blob().text(), 'native fixture bytes');
});

test('a synthetic inactive start from native Stop never replaces the failed startup acknowledgement', async () => {
  const h = harness({ syntheticStart: true }), control = createNativeEncoderControl(h.source, h.dependencies);
  const starting = control.start(); h.advance(10_000);
  await assert.rejects(starting, /did not start within10000ms/);
  await assert.rejects(control.stop(), /did not start within10000ms/);
  const row = control.snapshot(); assert.equal(row.startEvents, 1); assert.equal(row.firstStartMs, null);
  assert.equal(row.stopEvents, 1); assert.equal(row.cloneEnded, true); assert.equal(h.source.stops, 0);
});

test('missing actual native stop acknowledgement fails at the existing15s boundary and releases the clone', async () => {
  const h = harness({ stopEvent: false }), control = createNativeEncoderControl(h.source, h.dependencies);
  const starting = control.start(); h.recorder().emit('start'); await starting;
  const stopping = control.stop(); await Promise.resolve(); h.advance(15_000);
  await assert.rejects(stopping, /stop acknowledgement timed out/);
  assert.equal(control.snapshot().stopEvents, 0); assert.equal(control.snapshot().cloneEnded, true); assert.equal(h.source.stops, 0);
});

test('raw constructor failure releases its clone and preserves the caller source', () => {
  const h = harness({ constructorFails: true });
  assert.throws(() => createNativeEncoderControl(h.source, h.dependencies), /constructor failure/);
  assert.equal(h.clones[0].readyState, 'ended'); assert.equal(h.source.stops, 0);
});

test('bounded raw evidence cannot silently accept excess encoded data', async () => {
  const h = harness(), control = createNativeEncoderControl(h.source, h.dependencies);
  const starting = control.start(); h.recorder().emit('start'); await starting;
  h.recorder().emit('dataavailable', { data: { size: 32 * 1024 ** 2 + 1 } });
  await assert.rejects(control.stop(), /memory bound/);
  assert.equal(control.snapshot().bytes, 0); assert.equal(control.snapshot().cloneEnded, true);
});

test('a late live start callback cannot overtake an already elapsed10s deadline', async () => {
  const h = harness(), control = createNativeEncoderControl(h.source, h.dependencies);
  const starting = control.start(); h.advance(10_000, false); h.recorder().emit('start');
  await assert.rejects(starting); assert.equal(control.snapshot().firstStartMs, null);
  await assert.rejects(control.stop()); assert.equal(control.snapshot().cloneEnded, true);
});
test('Stop before Start releases its own clone without pretending a native acknowledgement', async () => {
  const h = harness(), control = createNativeEncoderControl(h.source, h.dependencies);
  await assert.rejects(control.stop(), /before its start call/);
  assert.equal(control.snapshot().stopEvents, 0); assert.equal(control.snapshot().cloneEnded, true); assert.equal(h.source.stops, 0);
});

test('a synchronous native Stop consuming the15s budget is retained as failure despite its later event', async () => {
  const h = harness({ stopAdvanceMs: 15_001 }), control = createNativeEncoderControl(h.source, h.dependencies);
  const starting = control.start(); h.recorder().emit('start'); await starting;
  await assert.rejects(control.stop(), /exceeded15000ms/);
  assert.equal(control.snapshot().stopEvents, 1); assert.equal(control.snapshot().cloneEnded, true);
});
