import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withNativeEncoderControl, prepareMatrix } from './matrix-fixture.mjs';
import { sourceTaskObservationWindow } from './cold-trace.mjs';

const runner = readFileSync(new URL('./matrix.mjs', import.meta.url), 'utf8');
const begin = runner.indexOf("const long = process.env.RUSHES_M1_LONG === '1';");
const end = runner.indexOf('const root = fileURLToPath(', begin);
const admission = new Function('sourceTaskObservationWindow', 'process', `${runner.slice(begin, end)};return {nativeEncoderControl,sourceOnly,targetMs};`);
const baseEnvironment = { RUSHES_M1_SOURCE_MODE: 'native-reference', RUSHES_M1_NATIVE_SOURCE_ONLY: '1', RUSHES_M1_NATIVE_ENCODER_CONTROL: '1' };
test('raw native mode is explicit, short, untraced, source-only and cannot replace an ordinary source verdict', () => {
  assert.deepEqual(admission(sourceTaskObservationWindow, { env: baseEnvironment, platform: 'win32' }), { nativeEncoderControl: true, sourceOnly: true, targetMs: 8000 });
  assert.deepEqual(admission(sourceTaskObservationWindow, { env: { RUSHES_M1_SOURCE_MODE: 'native-reference', RUSHES_M1_NATIVE_SOURCE_ONLY: '1' }, platform: 'win32' }), { nativeEncoderControl: false, sourceOnly: true, targetMs: 8000 });
  for (const change of [{ RUSHES_M1_NATIVE_ENCODER_CONTROL: '0' }, { RUSHES_M1_NATIVE_SOURCE_ONLY: undefined },
    { RUSHES_M1_LONG: '1' }, { RUSHES_M1_REFERENCE: '1' }, { RUSHES_M1_DIAGNOSTIC: '1' },
    { RUSHES_M1_SOURCE_AUDIO_FRAMES: '480' }, { RUSHES_M1_SOURCE_AUDIO_SINK: 'default' },
    { RUSHES_M1_NATIVE_TRACE_PROOF: '1' }, { RUSHES_M1_SOURCE_AUDIO_TRACE_PROOF: '1' }])
    assert.throws(() => admission(sourceTaskObservationWindow, { env: { ...baseEnvironment, ...change }, platform: 'win32' }));
});
test('fixture rejects a raw encoder before ordinary/full or altered source admission', async () => {
  for (const change of [{ sourceOnly: false }, { referenceWitness: false }, { sourceAudioFrames: 480 }, { sourceAudioSink: 'default' }])
    await assert.rejects(prepareMatrix({ sourceOnly: true, nativeEncoderControl: true, sourceMode: 'native-reference', ...change }));
});

function control({ refuseStart = false } = {}) {
  let now = 100, stoppedAt, startedAt, first, sourceEnded = 0, epoch;
  const order = [], rows = [], metrics = { states: [] }, clones = [];
  const source = { kind: 'video', readyState: 'live', clone() { const value = { readyState: 'live', stop() { this.readyState = 'ended'; } }; clones.push(value); return value; } };
  class Stream { constructor(tracks) { this.tracks = tracks; } }
  class NativeRecorder extends EventTarget {
    static isTypeSupported(value) { return value === 'video/webm;codecs=vp8'; }
    constructor(_stream, options) { super(); first = this; this.state = 'inactive'; this.mimeType = options.mimeType; }
    start() { order.push('native-start-call'); this.state = 'recording'; queueMicrotask(() => this.dispatchEvent(new Event(refuseStart ? 'error' : 'start'))); }
    pause() { this.state = 'paused'; this.dispatchEvent(new Event('pause')); }
    resume() { this.state = 'recording'; this.dispatchEvent(new Event('resume')); }
    stop() { order.push('native-stop-call'); now += 100; this.state = 'inactive'; queueMicrotask(() => this.dispatchEvent(new Event('stop'))); }
  }
  const observation = { id: 'raw-generated', session: { stop() { stoppedAt ??= now; order.push('observation-stop'); return Promise.resolve(); } },
    start() { startedAt = now; epoch = now; order.push('observation-epoch'); }, pause() {}, resume() {},
    snapshot() { return structuredClone({ metrics, observation: { durationMs: (stoppedAt ?? now) - startedAt } }); },
    async finish() { sourceEnded++; source.readyState = 'ended'; return this.snapshot(); } };
  const value = withNativeEncoderControl(observation, source, NativeRecorder, metrics, { Stream, now: () => now, emit: row => rows.push(row) });
  return { value, rows, order, metrics, clones, source, recorder: () => first, advance: ms => { now += ms; }, epoch: () => epoch, ended: () => sourceEnded };
}
test('raw adapter preserves existing source observation and freezes its epoch before native finalization', async () => {
  const h = control(); await h.value.start(); assert.deepEqual(h.order.slice(0, 2), ['native-start-call', 'observation-epoch']);
  for (let index = 0; index < 5; index++) { h.value.pause(); h.value.resume(); }
  h.advance(8000); const result = await h.value.finish();
  assert.equal(result.observation.durationMs, 8000); assert.equal(h.clones.length, 1); assert.equal(h.clones[0].readyState, 'ended');
  assert.deepEqual(h.rows.map(row => row.phase), ['after-start-call', 'startup-settled', 'before-stop', 'stop-settled']);
  assert.equal(result.metrics.nativeEncoderControl.firstStartMs, h.epoch()); assert.equal(h.ended(), 1);
  assert.ok(h.order.indexOf('observation-stop') < h.order.indexOf('native-stop-call'));
});
test('raw adapter retains startup failure and retires both raw clone and existing source observation', async () => {
  const h = control({ refuseStart: true }); await assert.rejects(h.value.start(), /encoder error/);
  await h.value.finish(); assert.equal(h.clones[0].readyState, 'ended'); assert.equal(h.ended(), 1);
  assert.ok(h.metrics.nativeEncoderControl.failures.length > 0); assert.equal(h.metrics.nativeEncoderControl.firstStartMs, null);
});

test('bounded raw diagnostic parser preserves only scoped scalar rows', () => {
  const start = runner.indexOf('function nativeEncoderRow('), end = runner.indexOf('async function retainNativeEncoder()', start);
  const parse = new Function(runner.slice(start, end) + '; return nativeEncoderRow;')();
  const row = { schema: 'rushes.raw-native-vp8-row/1', takeId: 'generated-take', phase: 'after-start-call', atMs: 3,
    startCalls: 1, startReturns: 1, startEvents: 0, firstStartMs: null, stopCalls: 0, stopReturns: 0, stopEvents: 0, bytes: 0, failures: 0 };
  assert.deepEqual(parse(row), row);
  for (const change of [{ schema: 'rushes.independent-m1/1' }, { phase: 'arbitrary' }, { bytes: -1 }, { commandLine: 'private' }])
    assert.equal(parse({ ...row, ...change }), undefined);
  const schema = runner.match(/const evidence = \{ schema: (.*), startedAt:/)[1];
  assert.equal(new Function('nativeEncoderControl', 'sourceOnly', 'return '+schema)(true, true), 'rushes.native-encoder-control/1');
  assert.equal(new Function('nativeEncoderControl', 'sourceOnly', 'return '+schema)(false, true), 'rushes.source-load-control/1');
});
