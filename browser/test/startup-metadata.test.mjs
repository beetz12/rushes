import test from 'node:test';
import assert from 'node:assert/strict';
import { startupMetadata, startupPrefix, collectStartupMetadata } from './startup-metadata.mjs';
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
