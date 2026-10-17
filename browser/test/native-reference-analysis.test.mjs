import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualifyNativeReference } from './native-reference-analysis.mjs';

function suppliedFixture() {
  const rate = 48000, bytes = Buffer.alloc(rate * 4 * 4), frames = [], origin = 1000000;
  for (let sample = 0; sample < rate * 4; sample++) {
    const t = sample / rate, ordinal = Math.floor(t * 2);
    bytes.writeFloatLE(.15 * (Math.sin(2 * Math.PI * (500 + ordinal * 40) * t)
      + Math.sin(2 * Math.PI * 4000 * t)), sample * 4);
  }
  for (let at = 0; at < 400; at++) frames.push({ timestampUs: 100000 + at * 10000, rate, frames: 480, channels: 1 });
  const snapshot = { id: 'generated-reference-unit', wallMs: 4200, metrics: {
    clockCapability: { timeOrigin: 1, converter: { qualified: true, unitSlope: 1,
      originIntervalMs: [origin - .1, origin + .1], conservativeSameRealmConversionUncertaintyMs: .401 } },
    calibrationInputEdges: Array.from({ length: 8 }, (_, ordinal) => ({ ordinal,
      timestamp: (origin + 100 + ordinal * 500) * 1000, globalWallMs: ordinal * 500 })),
    sourceObserverRetirement: { optical: { firstTimestamp: (origin + 100) * 1000, lastTimestamp: (origin + 4066) * 1000, maxTimestampGapUs: 33334, count: 120 } },
    frames: { 'native-input': { count: 120, firstTimestamp: (origin + 100) * 1000,
      lastTimestamp: (origin + 4066) * 1000, maxTimestampGapUs: 33334 } },
    suppliedReference: { schema: 'rushes.supplied-reference-observation/1', sameWindow: true, timeOrigin: 1,
      takeId: 'generated-reference-unit', pcmFormat: 'f32le', observedPlane: 0, storedChannels: 1, closed: true, bytes: bytes.length, actualFileBytes: bytes.length,
      peakPendingBytes: 65536, frames },
  } };
  return { snapshot, bytes };
}

test('actual PCM/optical sample reference accepts a known source and preserves37ms without callback correction', () => {
  const { snapshot, bytes } = suppliedFixture(), baseline = qualifyNativeReference(snapshot, bytes);
  assert.equal(baseline.sourceKind, 'measured-supplied-track-reference-timeline');
  assert.equal(baseline.wholeExtentCovered, true);
  const arrival = structuredClone(snapshot);
  for (const row of arrival.metrics.calibrationInputEdges) row.globalWallMs += 300;
  assert.deepEqual(qualifyNativeReference(arrival, bytes), baseline);
  // Advance only the optical transitions; preserve the observed extent for this control.
  const displaced = structuredClone(snapshot);
  for (const row of displaced.metrics.calibrationInputEdges.slice(1)) row.timestamp += 37000;
  const shifted = qualifyNativeReference(displaced, bytes);
  assert.ok(shifted.decoded.points.every((point, index) => Math.abs(point.driftMs - baseline.decoded.points[index].driftMs - 37) < 2));
});

test('pre-video PCM silence is retained while the initial ordinal is checked at the actual video interval', () => {
  const { snapshot, bytes } = suppliedFixture(), baseline = qualifyNativeReference(snapshot, bytes);
  const prefixSamples = 9600, prefixed = Buffer.concat([Buffer.alloc(prefixSamples * 4), bytes]);
  const delayed = structuredClone(snapshot); delayed.wallMs += 200;
  for (const row of delayed.metrics.calibrationInputEdges) row.timestamp += 200000;
  for (const row of [delayed.metrics.sourceObserverRetirement.optical, delayed.metrics.frames['native-input']]) {
    row.firstTimestamp += 200000; row.lastTimestamp += 200000;
  }
  const witness = delayed.metrics.suppliedReference;
  witness.bytes = witness.actualFileBytes = prefixed.length;
  witness.frames = Array.from({ length: 420 }, (_, index) => ({ timestampUs: 100000 + index * 10000,
    rate: 48000, frames: 480, channels: 1 }));
  const qualified = qualifyNativeReference(delayed, prefixed);
  assert.equal(qualified.wholeExtentCovered, true);
  assert.equal(qualified.decoded.anchor.firstAudioOrdinal, 0);
  for (let index = 0; index < 3; index++)
    assert.ok(Math.abs(qualified.decoded.points[index].driftMs - baseline.decoded.points[index].driftMs) < 2);
  const silentInsideVideo = Buffer.from(prefixed); silentInsideVideo.fill(0, 9600 * 4, 16000 * 4);
  assert.throws(() => qualifyNativeReference(delayed, silentInsideVideo), /silent or missing/);
  const waveformDelayed = Buffer.from(prefixed), displacement = 14400;
  for (let sample = prefixSamples; sample < prefixSamples + displacement; sample++)
    bytes.copy(waveformDelayed, sample * 4, (3840 + sample % 1920) * 4, (3841 + sample % 1920) * 4);
  bytes.copy(waveformDelayed, (prefixSamples + displacement) * 4, 0, bytes.length - displacement * 4);
  assert.throws(() => qualifyNativeReference(delayed, waveformDelayed), /bracket|exceeds100ms/);
});

test('missing source data, wrong realm/take, nonmonotonic clocks and between-anchor holes fail closed', () => {
  const { snapshot, bytes } = suppliedFixture();
  const mutations = [
    value => { value.metrics.suppliedReference.closed = false; },
    value => { delete value.metrics.sourceObserverRetirement; },
    value => { value.metrics.sourceObserverRetirement.optical.maxTimestampGapUs = 300000; },
    value => { value.metrics.suppliedReference.timeOrigin = 2; },
    value => { value.metrics.suppliedReference.takeId = 'another-take'; },
    value => { value.metrics.calibrationInputEdges[3].timestamp = value.metrics.calibrationInputEdges[2].timestamp; },
    value => { value.metrics.suppliedReference.frames.splice(150, 31); },
    value => { for (const frame of value.metrics.suppliedReference.frames) frame.timestampUs += 300000; },
    value => { for (const row of value.metrics.calibrationInputEdges) row.timestamp -= 1000000000; },
  ];
  for (const mutate of mutations) { const value = structuredClone(snapshot); mutate(value); assert.throws(() => qualifyNativeReference(value, bytes)); }
  assert.throws(() => qualifyNativeReference(snapshot, bytes.subarray(0, -4)));
  const invalid = Buffer.from(bytes); invalid.writeFloatLE(NaN, 4000); assert.throws(() => qualifyNativeReference(snapshot, invalid));
});

test('a300ms real waveform delay with unchanged timestamps cannot qualify', () => {
  const { snapshot, bytes } = suppliedFixture(), shifted = Buffer.alloc(bytes.length), delay = .3 * 48000;
  for (let index = 0; index < delay; index++) bytes.copy(shifted, index * 4, (3840 + index % 1920) * 4, (3841 + index % 1920) * 4);
  bytes.copy(shifted, delay * 4, 0, bytes.length - delay * 4);
  assert.throws(() => qualifyNativeReference(snapshot, shifted));
});

test('count-preserving PCM timestamp hole reaches the continuity guard', () => {
  const { snapshot, bytes } = suppliedFixture();
  for (const frame of snapshot.metrics.suppliedReference.frames.slice(150)) frame.timestampUs += 310000;
  snapshot.wallMs += 310; // Include the deliberately delayed tail in the observed test window.
  assert.throws(() => qualifyNativeReference(snapshot, bytes), /Supplied audio has a gap over250ms/);
});

test('receipt wait never extrapolates optical state to a later cadence endpoint', () => {
  const { snapshot, bytes } = suppliedFixture();
  const baseline = qualifyNativeReference(snapshot, bytes);
  snapshot.metrics.frames['native-input'].lastTimestamp += 250000;
  assert.deepEqual(qualifyNativeReference(snapshot, bytes), baseline);
  snapshot.metrics.sourceObserverRetirement.optical.lastTimestamp += 250000;
  assert.throws(() => qualifyNativeReference(snapshot, bytes), /PCM must cover actual observed video extent/);
});

test('an older cached video head still requires actual PCM even after readiness was acknowledged', () => {
  const { snapshot, bytes } = suppliedFixture();
  const earlier = 1633;
  snapshot.metrics.frames['native-input'].firstTimestamp -= earlier;
  snapshot.metrics.sourceObserverRetirement.optical.firstTimestamp -= earlier;
  snapshot.metrics.calibrationInputEdges[0].timestamp -= earlier;
  snapshot.metrics.suppliedReferenceStartup = { firstTimestampUs: 100000, acknowledgedPageMs: 101 };
  assert.throws(() => qualifyNativeReference(snapshot, bytes), /PCM must cover actual observed video extent/);
});
