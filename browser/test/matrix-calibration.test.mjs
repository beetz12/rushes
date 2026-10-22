import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArrivalOrdinalTone, qualifyOrdinalStimulus, requireQualifiedOrdinalStimulus } from './matrix-calibration.mjs';

const input = Array.from({ length: 5 }, (_, ordinal) => ({ ordinal, timestamp: 90000000000 + ordinal * 500000 }));
function simulate(arrivals) {
  const tone = new ArrivalOrdinalTone(), emitted = [], output = new Float32Array(128);
  for (const { ordinal, frame, process = true } of arrivals) {
    tone.receive({ ordinal, sourceTimestampUs: input[ordinal].timestamp }, frame);
    if (process) tone.render(output, frame, 48000, marker => emitted.push(marker));
  }
  return emitted;
}
test('regular actual sample-block emission qualifies independently of absolute clock epoch', () => {
  const markers = simulate(input.map((_, ordinal) => ({ ordinal, frame: 8000 + ordinal * 24000 })));
  const qualification = qualifyOrdinalStimulus(input, markers);
  assert.equal(qualification.qualified, true); assert.equal(qualification.phases.length, 4);
  assert.ok(qualification.scope.includes('no common epoch'));
});
test('delayed/burst source delivery yields malformed emission and cannot yield sync PASS even if selected drift points are zero', () => {
  const delays = [0, 48000, 48256, 72256, 96256];
  const markers = simulate(input.map((_, ordinal) => ({ ordinal, frame: delays[ordinal] })));
  assert.equal(qualifyOrdinalStimulus(input, markers).qualified, false);
  let pointGateReached = false;
  assert.throws(() => {
    requireQualifiedOrdinalStimulus(input, markers);
    pointGateReached = [0, 0, 0].every(drift => Math.abs(drift) <= 100);
  }, /CALIBRATION_STIMULUS_INVALID/);
  assert.equal(pointGateReached, false);
});
test('multiple arrivals in one render block do not fabricate missing ordinal emissions', () => {
  const markers = simulate([{ ordinal: 0, frame: 0 }, { ordinal: 1, frame: 24000, process: false },
    { ordinal: 2, frame: 24000 }, { ordinal: 3, frame: 48000 }, { ordinal: 4, frame: 72000 }]);
  assert.deepEqual(markers.map(marker => marker.ordinal), [0, 2, 3, 4]);
  assert.equal(qualifyOrdinalStimulus(input, markers).qualified, false);
});
test('the known234.7ms phase3 negative control is rejected without skipping the first decoded edge', () => {
  const markers = simulate(input.map((_, ordinal) => ({ ordinal, frame: ordinal < 4 ? ordinal * 24000 : 83264 })));
  assert.equal(markers[4].audioFrame - markers[3].audioFrame, 11264);
  assert.equal(qualifyOrdinalStimulus(input, markers).qualified, false);
});
test('legacy arrival acknowledgments and missing actual emission metadata never qualify', () => {
  assert.equal(qualifyOrdinalStimulus(input, input.map((edge, index) => ({ ordinal: edge.ordinal, audioFrame: index * 24000 }))).qualified, false);
  assert.equal(qualifyOrdinalStimulus(undefined, undefined).qualified, false);
});
test('initial unobserved full-fixture tone stays silent; emission timestamp belongs to process rather than receipt', () => {
  const tone = new ArrivalOrdinalTone(), output = new Float32Array(128).fill(1), emitted = [];
  tone.render(output, 0, 48000, marker => emitted.push(marker)); assert.ok(output.every(value => value === 0));
  const receipt = tone.receive({ ordinal: 0, sourceTimestampUs: input[0].timestamp }, 1000);
  tone.render(output, 1024, 48000, marker => emitted.push(marker));
  assert.equal(receipt.receivedAudioFrame, 1000); assert.equal(emitted[0].audioFrame, 1024);
  assert.equal(emitted[0].measurement, 'emission'); assert.equal(emitted.length, 1);
});
test('missing or invalid block length prevents sync PASS despite zero candidate drifts', () => {
  const valid = simulate(input.map((_, ordinal) => ({ ordinal, frame: ordinal * 24000 })));
  assert.equal(qualifyOrdinalStimulus(input, valid).qualified, true);
  for (const blockLength of [undefined, 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const markers = structuredClone(valid);
    if (blockLength === undefined) delete markers[2].blockLength; else markers[2].blockLength = blockLength;
    let pointGateReached = false;
    assert.throws(() => {
      requireQualifiedOrdinalStimulus(input, markers);
      pointGateReached = [0, 0, 0].every(drift => Math.abs(drift) <= 100);
    }, /CALIBRATION_STIMULUS_INVALID/);
    assert.equal(pointGateReached, false);
  }
});
test('empty render block neither changes emitted state nor reports a nonexistent emission', () => {
  const tone = new ArrivalOrdinalTone(), emitted = [];
  tone.receive({ ordinal: 0, sourceTimestampUs: input[0].timestamp }, 0);
  tone.render(new Float32Array(0), 0, 48000, marker => emitted.push(marker));
  assert.equal(tone.emitted, null); assert.deepEqual(emitted, []);
  tone.render(new Float32Array(128), 128, 48000, marker => emitted.push(marker));
  assert.equal(tone.emitted, 0); assert.equal(emitted.length, 1);
  assert.equal(emitted[0].audioFrame, 128); assert.equal(emitted[0].blockLength, 128);
});
