import { test } from 'node:test';
import * as sourceFiles from 'node:fs/promises';
import assert from 'node:assert/strict';
import { prepareMatrix } from './matrix-fixture.mjs';

const fixture = await sourceFiles.readFile(new URL('./matrix-fixture.mjs', import.meta.url), 'utf8');
const begin = fixture.indexOf('  if (sourceOnly) {\n    const pauses = []');
const end = fixture.indexOf('  const session = await createCaptureSession(', begin);
assert.ok(begin >= 0 && end > begin);
const actualControl = new (Object.getPrototypeOf(async function() {}).constructor)('environment',
  `const { sourceOnly, metrics, performance, id, document, navigator, source, screen, camera, microphone,
    audio, sourceObserverTrack, sourceWorker, toneContext, nativeRecorder, nativeWorker, suppliedReference,
    retireObservations } = environment; ${fixture.slice(begin, end)} throw new Error('Entered product admission');`);

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
