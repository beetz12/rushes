import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualifyOrdinalStimulus } from './matrix-calibration.mjs';
import { productSyncSourceVerdict, requireProductSyncSource } from './matrix-source-qualification.mjs';
import { readFile } from 'node:fs/promises';
import { requireQualifiedOrdinalStimulus } from './matrix-calibration.mjs';

const points = [1, 2, 3].map(ordinal => ({ ordinal, driftMs: 0, uncertaintyMs: 20 }));
const container = { qualified: true, sourceKind: 'encoded-common-content-timeline',
  decoded: { timeBasis: 'same-container presentation timestamps', points } };

test('300ms constant feed latency can preserve shape and zero export lag but cannot grant product-sync acceptance', () => {
  const inputs = [0, 1, 2, 3].map(ordinal => ({ ordinal, timestamp: 1000000000 + ordinal * 500000 }));
  const emissions = inputs.map(input => ({ measurement: 'emission', ordinal: input.ordinal,
    sourceTimestampUs: input.timestamp, audioFrame: 14400 + input.ordinal * 24000, sampleRate: 48000, blockLength: 128 }));
  assert.equal(qualifyOrdinalStimulus(inputs, emissions).qualified, true);
  assert.ok(points.every(point => point.driftMs === 0));
  assert.equal(productSyncSourceVerdict('native-feedback', { qualified: true, decoded: { points } }).eligible, false);
  assert.throws(() => requireProductSyncSource('native-feedback', container), /PRODUCT_SYNC_SOURCE_UNQUALIFIED/);
});
test('only independently qualified common-content phase can reach normal product-sync acceptance', () => {
  assert.equal(requireProductSyncSource('container', container).eligible, true);
  for (const qualification of [undefined, {}, { ...container, qualified: false },
    { ...container, sourceKind: 'relative-emission-shape' },
    { ...container, decoded: { ...container.decoded, timeBasis: 'unknown' } },
    { ...container, decoded: { ...container.decoded, points: [] } },
    { ...container, decoded: { ...container.decoded, points: points.map(point => ({ ...point, driftMs: 85 })) } }])
    assert.throws(() => requireProductSyncSource('container', qualification), /PRODUCT_SYNC_SOURCE_UNQUALIFIED/);
});

test('normal matrix gates reject unknown input phase even when shape and zero export lag pass', async () => {
  const filename = process.env.RUSHES_ORACLE_MATRIX_SOURCE || new URL('./matrix.mjs', import.meta.url);
  const source = await readFile(filename, 'utf8');
  const first = source.indexOf('  evidence.calibrationQualification =');
  const last = source.indexOf('  evidence.sync = {};', first);
  assert.ok(first >= 0 && last > first, 'Actual matrix qualification block must be present');
  const inputs = [0, 1, 2, 3].map(ordinal => ({ ordinal, timestamp: 1000000000 + ordinal * 500000 }));
  const emissions = inputs.map(input => ({ measurement: 'emission', ordinal: input.ordinal,
    sourceTimestampUs: input.timestamp, audioFrame: 14400 + input.ordinal * 24000, sampleRate: 48000, blockLength: 128 }));
  const evidence = { failures: [], recording: { metrics: { calibrationInputEdges: inputs, calibrationAudioEdges: emissions } } };
  const check = (name, operation) => { try { operation(); } catch (error) { evidence.failures.push(name + ': ' + error); } };
  const runBlock = Object.getPrototypeOf(async function () {}).constructor;
  await new runBlock('evidence', 'sourceMode', 'requireQualifiedOrdinalStimulus', 'productSyncSourceVerdict',
    'requireProductSyncSource', 'check', 'save', source.slice(first, last))(
    evidence, 'native-feedback', requireQualifiedOrdinalStimulus, productSyncSourceVerdict,
    requireProductSyncSource, check, async () => {});
  assert.equal(evidence.calibrationQualification.qualified, true);
  assert.ok(points.every(point => point.driftMs === 0));
  const exitExpression = source.match(/process\.exitCode = ([^;]+);/);
  assert.ok(exitExpression, 'Actual matrix terminal verdict must be present');
  const exit = new Function('evidence', 'return (' + exitExpression[1] + ');')(evidence);
  assert.equal(exit, 1, 'The real matrix qualification/terminal policy must refuse unknown input phase');
});

test('measured supplied-reference mode requires its own same-run clock/content/coverage witness', () => {
  const source = { qualified: true, sourceKind: 'measured-supplied-track-reference-timeline',
    sameRun: true, sameWindow: true, timeOrigin: 1, wholeExtentCovered: true, joinsWithin250ms: true,
    converter: { qualified: true, arrivalTimeUsed: false, recordedAVPhaseUsed: false },
    decoded: { timeBasis: 'same-Window supplied-track reference timestamps', points } };
  assert.equal(requireProductSyncSource('native-reference', source).eligible, true);
  assert.equal(productSyncSourceVerdict('native-feedback', source).eligible, false);
  for (const key of ['qualified', 'sameRun', 'sameWindow', 'wholeExtentCovered', 'joinsWithin250ms'])
    assert.equal(productSyncSourceVerdict('native-reference', { ...source, [key]: false }).eligible, false);
  assert.equal(productSyncSourceVerdict('native-reference', container).eligible, false);
  assert.equal(productSyncSourceVerdict('native-reference', { ...source, converter: { ...source.converter, recordedAVPhaseUsed: true } }).eligible, false);
  assert.equal(productSyncSourceVerdict('native-reference', { ...source, decoded: { ...source.decoded, points: points.map(point => ({ ...point, driftMs: 300 })) } }).eligible, false);
});
