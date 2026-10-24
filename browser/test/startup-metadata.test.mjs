import * as workerFixtureFiles from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startupMetadata, startupPrefix, collectStartupMetadata, audioFailureMetadata, lateAudioMetadata } from './startup-metadata.mjs';
const base = { takeId: 'generated-case', index: 0, timeMs: 42.5 };
const line = row => startupPrefix + JSON.stringify(row);
const warning = { ...base, kind: 'warning', state: 'recording', message: 'Audio sink write timed out' };
const phase = { ...base, kind: 'phase', phase: 'journal-load-entered' };
const event = { ...base, kind: 'recorder-event', id: 4, role: 'composed', event: 'start', state: 'recording' };
test('bounded actual warning, native-event and existing-await receipts retain their exact scalar data', () => {
  for (const row of [warning, phase, event, { ...warning, message: '\u0000'.repeat(512) }])
    assert.deepEqual(startupMetadata(line(row)), row);
});
test('arbitrary payload, unknown fields, malformed enums and ambiguous identity cannot become startup evidence', () => {
  const bad = [
    { ...warning, frames: [1, 2] }, { ...warning, message: { samples: [1] } },
    { ...warning, message: 'x'.repeat(513) }, { ...warning, state: 'unknown' },
    { ...event, id: 5 }, { ...event, id: 0 }, { ...event, event: 'dataavailable' },
    { ...phase, phase: 'invented' }, { ...phase, index: 256 }, { ...phase, index: -1 },
    { ...phase, index: .5 }, { ...phase, timeMs: Infinity }, { ...phase, takeId: '../unowned' },
    { ...phase, takeId: 'x'.repeat(129) }, { ...phase, timeMs: -1 }, { ...phase, kind: 'payload' }
  ];
  for (const row of bad) assert.equal(startupMetadata(line(row)), undefined, JSON.stringify(row));
  for (const value of [null, {}, '', 'ordinary console', startupPrefix + '{', startupPrefix + '[]', 'x'.repeat(4097)])
    assert.equal(startupMetadata(value), undefined);
});

test('bounded collector reports missing, duplicate, foreign-take, invalid and overflow rows without hiding the first warning', () => {
  const evidence = { startupObservations: [], invalidStartupObservations: 0, droppedStartupObservations: 0,
    nextStartupObservationIndex: 0, startupObservationSequenceErrors: 0 };
  assert.equal(collectStartupMetadata(evidence, 'ordinary console'), undefined);
  assert.equal(collectStartupMetadata(evidence, startupPrefix + '{'), undefined);
  assert.equal(evidence.invalidStartupObservations, 1);
  assert.deepEqual(collectStartupMetadata(evidence, line(phase)), phase);
  const firstWarning = { ...warning, index: 2 };
  assert.deepEqual(collectStartupMetadata(evidence, line(firstWarning)), firstWarning);
  collectStartupMetadata(evidence, line(firstWarning));
  collectStartupMetadata(evidence, line({ ...phase, index: 3, takeId: 'another-case' }));
  assert.equal(evidence.startupObservationSequenceErrors, 3);
  assert.equal(evidence.startupObservationTakeId, base.takeId);
  for (let index = 4; index < 129; index++) collectStartupMetadata(evidence, line({ ...phase, index }));
  assert.equal(evidence.startupObservations.length, 128);
  assert.equal(evidence.droppedStartupObservations, 1);
  assert.deepEqual(evidence.startupObservations[1], firstWarning);
  assert.equal(evidence.nextStartupObservationIndex, 129);
  assert.deepEqual(evidence.firstStartupWarning, firstWarning);
  const full = { startupObservations: [], invalidStartupObservations: 0, droppedStartupObservations: 0,
    nextStartupObservationIndex: 0, startupObservationSequenceErrors: 0 };
  for (let index = 0; index < 128; index++) collectStartupMetadata(full, line({ ...phase, index }));
  const lateWarning = { ...warning, index: 128 };
  assert.deepEqual(collectStartupMetadata(full, line(lateWarning)), lateWarning);
  assert.deepEqual(full.firstStartupWarning, lateWarning);
  collectStartupMetadata(full, line({ ...warning, index: 129, message: 'later warning' }));
  assert.deepEqual(full.firstStartupWarning, lateWarning);
  assert.equal(full.startupObservations.length, 128);
  assert.equal(full.droppedStartupObservations, 2);
});

const audio = { schema: 1, edge: 'timer', input: [0, 800, 48000], pending: [12000, 12000],
  posted: [15, 15], consumed: [0, 0], waitMs: 251, messages: 1, lastKind: 'ready', lastAgeMs: 252,
  output: [0, null, 0, 0], writing: false, writeAgeMs: null, readied: true, quiesced: false, closed: false };
test('first audio failure is exact bounded scalar warning detail and never raw worker payload', () => {
  const row = { ...warning, audio }; assert.deepEqual(startupMetadata(line(row)), row);
  assert.equal(audioFailureMetadata(audio), audio);
  for (const changed of [{ ...audio, pcm: [1] }, { ...audio, edge: 'guessed' }, { ...audio, input: [2, 800, 48000] },
    { ...audio, input: [0, 0, 48000] }, { ...audio, pending: [0, 0, 0] }, { ...audio, posted: [-1, 0] },
    { ...audio, consumed: [1.5, 0] }, { ...audio, waitMs: 2147483648 }, { ...audio, lastKind: 'samples' },
    { ...audio, output: [0, 'unknown', 0, 0] }, { ...audio, writing: 1 }, { ...audio, writeAgeMs: -1 }]) {
    assert.equal(audioFailureMetadata(changed), undefined);
    assert.equal(startupMetadata(line({ ...warning, audio: changed })), undefined);
  }
});
test('maximal audio detail plus512 escaped warning characters fits the unchanged4096 raw limit', () => {
  const max = 2147483647;
  const detail = { schema: 1, edge: 'before-wait', input: [1, max, max], pending: [max, max], posted: [max, max],
    consumed: [max, max], waitMs: max, messages: max, lastKind: 'consumed', lastAgeMs: max,
    output: [max, max, max, max], writing: false, writeAgeMs: max, readied: false, quiesced: false, closed: false };
  const row = { ...warning, takeId: 'x'.repeat(128), index: 255, timeMs: Number.MAX_VALUE, message: '\u0000'.repeat(512), audio: detail };
  assert.ok(line(row).length <= 4096, `actual raw length ${line(row).length}`);
  assert.deepEqual(startupMetadata(line(row)), row);
});
test('late audio rows accept only owned consumed/error/stopped scalars', () => {
  for (const detail of [{ event: 'consumed', afterMs: 10, source: 1, frames: 480 },
    { event: 'error', afterMs: 0, message: 'Controlled late error' }, { event: 'stopped', afterMs: 100 }]) {
    assert.equal(lateAudioMetadata(detail), detail);
    const row = { ...base, kind: 'audio-late', workerId: 0, ...detail };
    assert.deepEqual(startupMetadata(line(row)), row);
    assert.equal(startupMetadata(line({ ...row, workerId: 1 })), undefined);
    assert.equal(startupMetadata(line({ ...row, data: [1, 2] })), undefined);
  }
  for (const value of [{ event: 'packet', afterMs: 0 }, { event: 'consumed', afterMs: 0, source: 2, frames: 480 },
    { event: 'consumed', afterMs: 0, source: 0, frames: 0 }, { event: 'error', afterMs: 0, message: 'x'.repeat(513) },
    { event: 'stopped', afterMs: Infinity }, { event: 'stopped', afterMs: -1 }]) assert.equal(lateAudioMetadata(value), undefined);
});
test('actual generated Worker listener positively identifies audio and retains only three late kinds', () => {
  const source = workerFixtureFiles.readFileSync(new URL('./matrix-fixture.mjs', import.meta.url), 'utf8');
  const begin = source.indexOf('  if (startupObservation) {\n    metrics.audioLateDropped');
  const end = source.indexOf("  const kinds = ['screen'", begin); assert.ok(begin >= 0 && end > begin);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Worker'), rows = [], metrics = { observerErrors: [] };
  class Endpoint extends EventTarget { emit(data) { this.dispatchEvent(new MessageEvent('message', { data })); } }
  try {
    const actual = new Function('startupObservation', 'metrics', 'nativeWorker', 'location', 'startup', 'audioFailureAt',
      'observedAudioWorker', 'audioLateKinds', 'performance', 'lateAudioMetadata', `${source.slice(begin, end)}\nreturn { Worker: globalThis.Worker, failed: value => audioFailureAt = value };`);
    const f = actual(true, metrics, Endpoint, { href: 'http://generated.invalid/' }, row => rows.push(row), undefined,
      undefined, new Set(), { now: () => 20 }, lateAudioMetadata);
    const other = new f.Worker('http://generated.invalid/src/capture/compositor.worker.ts');
    const owned = new f.Worker('http://generated.invalid/src/capture/audio.worker.ts?worker_file&type=module');
    owned.emit({ kind: 'consumed', source: 0, frames: 480 }); assert.equal(rows.length, 0);
    f.failed(10); other.emit({ kind: 'error', message: 'Wrong worker' });
    owned.emit({ kind: 'packet', data: new Float32Array(960) });
    owned.emit({ kind: 'consumed', source: 2, frames: 480 });
    owned.emit({ kind: 'consumed', source: 0, frames: 480 });
    owned.emit({ kind: 'consumed', source: 1, frames: 480 });
    owned.emit({ kind: 'error', message: 'Controlled late error', pcm: [1, 2] });
    owned.emit({ kind: 'stopped' }); owned.emit({ kind: 'stopped' });
    assert.deepEqual(rows, [{ kind: 'audio-late', workerId: 0, event: 'consumed', afterMs: 10, source: 0, frames: 480 },
      { kind: 'audio-late', workerId: 0, event: 'error', afterMs: 10, message: 'Controlled late error' },
      { kind: 'audio-late', workerId: 0, event: 'stopped', afterMs: 10 }]);
    assert.equal(metrics.audioLateInvalid, 1); assert.equal(metrics.audioLateDropped, 2);
    assert.deepEqual(metrics.audioWorkerIdentity, { id: 0, pathname: '/src/capture/audio.worker.ts' });
    new f.Worker('http://generated.invalid/src/capture/audio.worker.ts'); assert.equal(metrics.observerErrors.length, 1);
  } finally { if (previous) Object.defineProperty(globalThis, 'Worker', previous); else delete globalThis.Worker; }
});
