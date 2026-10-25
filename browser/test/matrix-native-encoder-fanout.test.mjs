import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNativeEncoderFanout, FANOUT_SCHEMA } from './matrix-native-encoder-fanout.mjs';
import { withNativeEncoderFanout, prepareMatrix } from './matrix-fixture.mjs';
import { sourceTaskObservationWindow } from './cold-trace.mjs';

function harness({ constructorFailsAt = -1, startEvent = () => true, stopEvent = true, stopAdvanceMs = 0, startAdvanceMs = [] } = {}) {
  let time = 0, nextTimer = 0;
  const timers = new Map(), clones = [], recorders = [], calls = [];
  const source = { kind: 'video', readyState: 'live', stops: 0,
    stop() { this.stops++; this.readyState = 'ended'; },
    clone() { const track = { kind: 'video', readyState: 'live', stop() { this.readyState = 'ended'; } }; clones.push(track); return track; } };
  class Stream { constructor(tracks) { this.tracks = tracks; } }
  class Recorder {
    static isTypeSupported(value) { return value === 'video/webm;codecs=vp8'; }
    constructor(stream, options) {
      if (recorders.length === constructorFailsAt) throw new Error('constructor failure');
      this.index = recorders.length; recorders.push(this); this.stream = stream; this.options = options; this.mimeType = options.mimeType;
      this.state = 'inactive'; this.listeners = new Map();
    }
    addEventListener(name, listener) { const values = this.listeners.get(name) ?? []; values.push(listener); this.listeners.set(name, values); }
    emit(name, value = {}) { for (const listener of this.listeners.get(name) ?? []) listener(value); }
    start(timeslice) { calls.push(`start-${this.index}@${time}`); time += startAdvanceMs[this.index] ?? 0; this.timeslice = timeslice; this.state = 'recording'; }
    pause() { this.state = 'paused'; this.emit('pause'); }
    resume() { this.state = 'recording'; this.emit('resume'); }
    stop() { calls.push(`stop-${this.index}`); time += stopAdvanceMs; this.state = 'inactive'; if (stopEvent) this.emit('stop'); }
  }
  const dependencies = { Recorder, Stream, now: () => time,
    schedule(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, due: time + delay }); return id; },
    unschedule(id) { timers.delete(id); } };
  return { source, clones, recorders, calls, dependencies, startEvent,
    acknowledge() { for (const recorder of recorders) if (startEvent(recorder.index)) recorder.emit('start'); },
    advance(value) { time += value; for (const [id, timer] of [...timers]) if (timer.due <= time) { timers.delete(id); timer.callback(); } } };
}

for (const count of [1, 2, 3]) test(`fanout x${count} owns one clone per encoder and shares one Start and finalize expiry`, async () => {
  const h = harness(), fanout = await createNativeEncoderFanout(h.source, count, h.dependencies);
  assert.equal(h.clones.length, count); assert.equal(h.recorders.length, count);
  assert.ok(h.recorders.every((recorder, index) => recorder.stream.tracks[0] === h.clones[index]));
  assert.ok(h.recorders.every(recorder => recorder.options.videoBitsPerSecond === 4_000_000 && recorder.options.mimeType === 'video/webm;codecs=vp8'));
  const starting = fanout.start(); h.acknowledge(); await starting;
  assert.ok(h.recorders.every(recorder => recorder.timeslice === 2000));
  for (let index = 0; index < 5; index++) { fanout.pause(); h.advance(100); fanout.resume(); h.advance(1500); }
  h.recorders.forEach(recorder => recorder.emit('dataavailable', { data: new Blob([`bytes-${recorder.index}`]) }));
  await fanout.stop();
  const group = fanout.snapshot();
  assert.equal(group.schema, FANOUT_SCHEMA); assert.equal(group.count, count); assert.equal(group.encoders.length, count);
  assert.equal(group.startExpiresAtMs, 10_000); assert.equal(group.groupFailure, null);
  for (const raw of group.encoders) {
    assert.equal(raw.startExpiresAtMs, group.startExpiresAtMs); assert.equal(raw.stopExpiresAtMs, group.stopExpiresAtMs);
    assert.equal(raw.stopEvents, 1); assert.equal(raw.cloneEnded, true); assert.deepEqual(raw.failures, []);
    assert.equal(raw.rows.filter(row => row.kind === 'pause-event').length, 5);
  }
  for (let index = 0; index < count; index++) assert.equal(await fanout.blob(index).text(), `bytes-${index}`);
  assert.equal(h.source.stops, 0); assert.throws(() => fanout.blob(count));
});

test('the common Start expiry is fixed before the first call and not renewed per encoder', async () => {
  // A blocking first native Start delays the second call; the second encoder then acknowledges
  // within10s of its own call but after the one group expiry, which must fail.
  const h = harness({ startAdvanceMs: [6_000], startEvent: () => false });
  const fanout = await createNativeEncoderFanout(h.source, 2, h.dependencies);
  const pending = fanout.start(); assert.deepEqual(h.calls, ['start-0@0', 'start-1@6000']);
  h.recorders[0].emit('start'); h.advance(3_999); h.recorders[1].emit('start'); // 9999: inside the common window
  await pending;
  const late = harness({ startAdvanceMs: [6_000], startEvent: () => false });
  const second = await createNativeEncoderFanout(late.source, 2, late.dependencies);
  const failing = second.start(); late.recorders[0].emit('start');
  late.advance(4_000); late.recorders[1].emit('start'); // 10000: only4000ms after its own call
  await assert.rejects(failing, /did not start within10000ms|after its deadline/);
  await assert.rejects(second.stop());
  const group = second.snapshot();
  assert.equal(group.startExpiresAtMs, 10_000); assert.ok(group.encoders.every(raw => raw.startExpiresAtMs === 10_000));
  assert.ok(group.encoders[0].firstStartMs !== null); assert.equal(group.encoders[1].firstStartMs, null);
  assert.ok(group.encoders.every(raw => raw.cloneEnded));
  await fanout.stop();
});

test('one encoder failing Stop still retires every clone and fails the group', async () => {
  const h = harness({ stopEvent: false }), fanout = await createNativeEncoderFanout(h.source, 3, h.dependencies);
  const starting = fanout.start(); h.acknowledge(); await starting;
  const stopping = fanout.stop(); await Promise.resolve(); await Promise.resolve(); h.advance(15_000);
  await assert.rejects(stopping, /stop acknowledgement timed out/);
  assert.ok(fanout.snapshot().encoders.every(raw => raw.cloneEnded)); assert.equal(h.source.stops, 0);
});

test('a synchronous Stop consuming the common15s budget fails the group', async () => {
  const h = harness({ stopAdvanceMs: 8_000 }), fanout = await createNativeEncoderFanout(h.source, 2, h.dependencies);
  const starting = fanout.start(); h.acknowledge(); await starting;
  await assert.rejects(fanout.stop(), /exceeded15000ms/);
  assert.ok(fanout.snapshot().groupFailure);
});

test('construction failure releases every clone already owned and preserves the caller source', async () => {
  const h = harness({ constructorFailsAt: 2 });
  await assert.rejects(createNativeEncoderFanout(h.source, 3, h.dependencies), /constructor failure/);
  assert.equal(h.clones.length, 3); assert.ok(h.clones.every(track => track.readyState === 'ended')); assert.equal(h.source.stops, 0);
  assert.ok(!h.calls.some(call => call.startsWith('start')));
});

test('fanout count is explicit', async () => {
  for (const count of [0, 4, '2', undefined]) await assert.rejects(createNativeEncoderFanout(harness().source, count, harness().dependencies));
});

test('fixture adapter issues every native Start before the source epoch and stops the source first', async () => {
  const h = harness(), rows = [], order = [], metrics = {};
  const observation = { id: 'fanout-generated', session: { stop() { order.push('observation-stop'); return Promise.resolve(); } },
    start() { order.push(`observation-epoch:${h.calls.length}`); }, pause() {}, resume() {},
    snapshot() { return { metrics }; }, async finish() { order.push('source-finish'); return { metrics }; } };
  const value = await withNativeEncoderFanout(observation, h.source, h.dependencies.Recorder, metrics, 3, { ...h.dependencies, emit: row => rows.push(row) });
  const starting = value.start(); h.acknowledge(); await starting;
  assert.deepEqual(order, ['observation-epoch:3']);
  await value.finish();
  assert.deepEqual(rows.map(row => row.phase), ['after-start-call', 'startup-settled', 'before-stop', 'stop-settled']);
  assert.ok(rows.every(row => row.schema === 'rushes.raw-native-vp8-fanout-row/1' && row.count === 3 && row.stopEvents.length === 3));
  assert.equal(metrics.nativeEncoderControl, undefined); assert.equal(metrics.nativeEncoderFanout.count, 3);
  assert.deepEqual(order.slice(1), ['observation-stop', 'source-finish']);
});

const runner = readFileSync(new URL('./matrix.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const begin = runner.indexOf("const long = process.env.RUSHES_M1_LONG === '1';");
const end = runner.indexOf('const root = fileURLToPath(', begin);
const admission = new Function('sourceTaskObservationWindow', 'process', `${runner.slice(begin, end)};return {nativeEncoderFanout,nativeEncoderControl,sourceOnly,targetMs};`);
const base = { RUSHES_M1_SOURCE_MODE: 'native-reference', RUSHES_M1_NATIVE_SOURCE_ONLY: '1' };
test('fanout admission is its own explicit untraced8s source-only diagnostic', () => {
  for (const count of ['1', '2', '3'])
    assert.deepEqual(admission(sourceTaskObservationWindow, { env: { ...base, RUSHES_M1_NATIVE_ENCODER_FANOUT: count }, platform: 'win32' }),
      { nativeEncoderFanout: Number(count), nativeEncoderControl: false, sourceOnly: true, targetMs: 8000 });
  assert.equal(admission(sourceTaskObservationWindow, { env: base, platform: 'win32' }).nativeEncoderFanout, 0);
  for (const change of [{ RUSHES_M1_NATIVE_ENCODER_FANOUT: '0' }, { RUSHES_M1_NATIVE_ENCODER_FANOUT: '4' },
    { RUSHES_M1_NATIVE_ENCODER_CONTROL: '1' }, { RUSHES_M1_NATIVE_SOURCE_ONLY: undefined },
    { RUSHES_M1_LONG: '1' }, { RUSHES_M1_REFERENCE: '1' }, { RUSHES_M1_DIAGNOSTIC: '1' },
    { RUSHES_M1_SOURCE_AUDIO_FRAMES: '480' }, { RUSHES_M1_SOURCE_AUDIO_SINK: 'default' },
    { RUSHES_M1_NATIVE_TRACE_PROOF: '1' }, { RUSHES_M1_SOURCE_AUDIO_TRACE_PROOF: '1' }])
    assert.throws(() => admission(sourceTaskObservationWindow, { env: { ...base, RUSHES_M1_NATIVE_ENCODER_FANOUT: '2', ...change }, platform: 'win32' }));
});
test('fixture rejects fanout outside its source-only admission or combined with the single control', async () => {
  for (const change of [{ sourceOnly: false }, { referenceWitness: false }, { sourceAudioFrames: 480 }, { sourceAudioSink: 'default' },
    { nativeEncoderControl: true }, { nativeEncoderFanout: 4 }, { nativeEncoderFanout: '2' }])
    await assert.rejects(prepareMatrix({ sourceOnly: true, nativeEncoderFanout: 2, sourceMode: 'native-reference', ...change }));
});

test('bounded fanout row parser preserves only scoped scalar lists', () => {
  const start = runner.indexOf('function nativeEncoderFanoutRow('), stop = runner.indexOf('async function retainNativeEncoderFanout()', start);
  const parse = new Function(runner.slice(start, stop) + '; return nativeEncoderFanoutRow;')();
  const row = { schema: 'rushes.raw-native-vp8-fanout-row/1', takeId: 'generated-take', phase: 'after-start-call', count: 2, atMs: 3,
    startCalls: [1, 1], startReturns: [1, 1], startEvents: [0, 0], firstStartMs: [null, 4], stopCalls: [0, 0], stopReturns: [0, 0],
    stopEvents: [0, 0], bytes: [0, 0], failures: [0, 0] };
  assert.deepEqual(parse(row), row);
  for (const change of [{ schema: 'rushes.raw-native-vp8-row/1' }, { count: 4 }, { bytes: [0] }, { bytes: [0, -1] },
    { firstStartMs: [null, 'x'] }, { phase: 'arbitrary' }, { commandLine: 'private' }])
    assert.equal(parse({ ...row, ...change }), undefined);
});

test('the fanout schema never replaces the single-encoder control label', () => {
  assert.match(runner, /if \(nativeEncoderFanout\) \{\n  evidence\.schema = 'rushes\.native-encoder-fanout\/1';/);
  const schema = runner.match(/const evidence = \{ schema: (.*), startedAt:/)[1];
  assert.equal(new Function('nativeEncoderControl', 'sourceOnly', 'softwareEncoderDiagnostic = false', 'return ' + schema)(true, true), 'rushes.native-encoder-control/1');
});
