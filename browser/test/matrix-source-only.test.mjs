import { test } from 'node:test';
import * as sourceFiles from 'node:fs/promises';
import assert from 'node:assert/strict';
import { prepareMatrix } from './matrix-fixture.mjs';

const fixture = await sourceFiles.readFile(new URL('./matrix-fixture.mjs', import.meta.url), 'utf8');
function sourceOnlyBody(text) {
  text = text.replace(/\r\n/g, '\n');
  const begin = text.indexOf('  if (sourceOnly) {\n    const pauses = []');
  const end = text.indexOf('  const session = await createCaptureSession(', begin);
  assert.ok(begin >= 0 && end > begin);
  return text.slice(begin, end);
}
const actualControl = new (Object.getPrototypeOf(async function() {}).constructor)('environment',
  `const { sourceOnly, nativeEncoderControl = false, metrics, performance, id, document, navigator, source, screen, camera, microphone,
    audio, sourceObserverTrack, sourceWorker, toneContext, nativeRecorder, nativeWorker, suppliedReference,
    retireObservations, withNativeEncoderControl } = environment; ${sourceOnlyBody(fixture)} throw new Error('Entered product admission');`);

test('source-only extraction keeps the same actual body for LF and Windows CRLF inputs', () => {
  const lf = fixture.replace(/\r\n/g, '\n');
  assert.equal(sourceOnlyBody(lf.replace(/\n/g, '\r\n')), sourceOnlyBody(lf));
});

async function control({ retirement = Promise.resolve() } = {}) {
  let now = 100, retired = 0, ended = 0, contextClosed = 0;
  const track = { readyState: 'live', stop() { this.readyState = 'ended'; ended++; } };
  const stream = { getTracks: () => [track] };
  const metrics = { states: [], visibility: [] };
  const value = await actualControl({ sourceOnly: true, metrics, id: 'actual-source-control',
    performance: { now: () => now }, document: { visibilityState: 'visible', hasFocus: () => true,
      addEventListener() {}, removeEventListener() {} },
    navigator: { storage: { async getDirectory() { return { async *entries() { yield ['source-reference', {}]; } }; } } },
    source: stream, screen: stream, camera: stream, microphone: stream, audio: { stream },
    toneContext: { async close() { contextClosed++; } },
    retireObservations: async () => { retired++; await retirement; },
  });
  return { value, metrics, time: value => { now = value; }, counts: () => ({ retired, ended, contextClosed }) };
}

test('source-only keeps an explicit diagnostic lifecycle and frozen active observation time', async () => {
  const input = await control(); input.value.start();
  input.time(1600); await input.value.pause(); input.time(1700); await input.value.resume();
  input.time(8200); await input.value.session.stop(); input.time(9000);
  const result = await input.value.finish();
  assert.equal(result.observation.scope, 'source-only'); assert.equal(result.observation.durationMs, 8000);
  assert.equal(result.observation.pauses.length, 1);
  assert.deepEqual(input.metrics.states.map(value => value.state), ['observing', 'paused', 'observing', 'stopping', 'observed']);
  assert.equal(result.manifest, undefined); assert.equal(input.counts().retired, 1);
  assert.equal(input.counts().contextClosed, 1); assert.equal(result.metrics.sourceOnlySourcesEnded, true);
});

test('Stop while a source-only pause is pending cannot be reopened by a late Resume', async () => {
  const retirement = Promise.withResolvers(), input = await control({ retirement: retirement.promise });
  input.value.start(); input.time(500); await input.value.pause(); input.time(600);
  const stop = input.value.session.stop(); input.time(700); await input.value.resume();
  retirement.resolve(); await stop; input.time(1000); await input.value.resume();
  assert.equal(input.metrics.states.at(-1).state, 'observed');
  assert.equal(input.value.elapsed(), 400);
  const result = await input.value.finish(); assert.equal(result.observation.durationMs, 400);
  assert.equal(input.counts().retired, 1);
});

test('source-only options reject incompatible modes before browser or product admission', async () => {
  await assert.rejects(prepareMatrix({ sourceOnly: true, sourceMode: 'container' }), /ordinary native-reference/);
  await assert.rejects(prepareMatrix({ sourceOnly: 'yes' }), /ordinary native-reference/);
  await assert.rejects(prepareMatrix({ sourceOnly: true, sourceMode: 'native-reference', referenceWitness: false }), /ordinary native-reference/);
  await assert.rejects(prepareMatrix({ sourceMode: 'native-reference', sourceAudioFrames: 512 }), /128 or480/);
});

test('a failed raw attachment retires the already-prepared source and preserves setup plus cleanup failures', async () => {
  const saved = { MediaRecorder: globalThis.MediaRecorder, Worker: globalThis.Worker };
  try { for (const cleanupFails of [false, true]) {
    const original = new Error('raw native constructor refused'), cleanup = new Error('source context retirement refused');
    const counts = { readers: 0, observerTrack: 0, worker: 0, context: 0, visibility: 0 };
    const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    const nativeRecorder = function HeldNativeRecorder() {}, nativeWorker = function HeldNativeWorker() {};
    const pending = actualControl({ sourceOnly: true, nativeEncoderControl: true, metrics: { states: [], visibility: [] },
      performance: { now: () => 100 }, id: 'failed-raw-attachment',
      document: { visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() { counts.visibility++; } },
      navigator: { storage: { async getDirectory() { return { async *entries() {} }; } } },
      source: stream, screen: stream, camera: stream, microphone: stream, audio: { stream },
      sourceObserverTrack: { stop() { counts.observerTrack++; } }, sourceWorker: { terminate() { counts.worker++; } },
      toneContext: { async close() { counts.context++; if (cleanupFails) throw cleanup; } }, nativeRecorder, nativeWorker,
      retireObservations: async () => { counts.readers++; },
      withNativeEncoderControl() { throw original; } });
    await assert.rejects(pending, error => {
      if (cleanupFails) { assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [original, cleanup]); }
      else assert.equal(error, original);
      return true;
    });
    assert.equal(track.readyState, 'ended');
    assert.deepEqual(counts, { readers: 1, observerTrack: 1, worker: 1, context: 1, visibility: 1 });
    assert.equal(globalThis.MediaRecorder, nativeRecorder); assert.equal(globalThis.Worker, nativeWorker);
  } } finally { globalThis.MediaRecorder = saved.MediaRecorder; globalThis.Worker = saved.Worker; }
});
