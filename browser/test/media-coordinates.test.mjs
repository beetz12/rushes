import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioCoordinates, decodedEdgeDelta, requireDecodedAlignment, temporalEdges } from './media-coordinates.mjs';

test('actual first PTS and every frame PTS survive PCM flattening, including a presentation gap', () => {
  const map = audioCoordinates([{ number: 0, pts: 2400, rate: 48000, samples: 480 },
    { number: 1, pts: 12480, rate: 48000, samples: 480 }], 960);
  assert.equal(map.atSample(0), 0.05); assert.equal(map.atSample(480), 0.26);
  assert.ok(Math.abs(map.nearPresentation(0.265) - 720) < 1e-9);
  assert.throws(() => map.nearPresentation(0.15), /presentation gap/);
  assert.ok(map.nearestPresentation(0.15).distanceMs > 90);
  assert.equal(Math.round(map.joins[0].gapMs), 200);
  assert.equal(Math.round(map.windowUncertaintyMs(400, 550)), 200);
  assert.equal(map.windowUncertaintyMs(0, 400), 0);
});
test('frozen optical content cannot pass on three early surviving transitions', () => {
  const edges = [0.5, 1, 1.5, 2, 2.5].map((seconds, index) => ({ seconds, ordinal: index + 1, previousOrdinal: index }));
  assert.throws(() => temporalEdges(edges, 0, 8), /actual beginning\/middle\/end/);
  assert.throws(() => temporalEdges(edges, 0, 180), /actual beginning\/middle\/end/);
  const full = Array.from({ length: 15 }, (_, index) => ({ seconds: (index + 1) / 2, ordinal: index + 1, previousOrdinal: index }));
  assert.deepEqual(temporalEdges(full, 0, 8).map(edge => edge.seconds), [0.5, 4, 7.5]);
});
test('missing, unordered, malformed or differently sized PCM cannot supply coordinates', () => {
  const frame = { number: 0, pts: 0, rate: 48000, samples: 480 };
  for (const frames of [[], [{ ...frame, rate: 44100 }], [{ ...frame, samples: 0 }],
    [{ ...frame, pts: NaN }], [frame, { ...frame, number: 1 }]])
    assert.throws(() => audioCoordinates(frames, 480));
  assert.throws(() => audioCoordinates([frame], 479), /sample counts/);
});
test('delayed start-event dispatch cannot change decoded alignment', () => {
  const video = { seconds: 2, ordinal: 4, startOffsetMs: 8 };
  const audio = { seconds: 2.02, ordinal: 4, startOffsetMs: 40 };
  const before = decodedEdgeDelta(video, audio);
  const after = decodedEdgeDelta({ ...video, startOffsetMs: 308 }, audio);
  assert.deepEqual(after, before);
  requireDecodedAlignment([before, before, before]);
});
test('a constant300ms media displacement fails even when relative drift is zero and callbacks would cancel it', () => {
  const points = [1, 3, 5].map(seconds => decodedEdgeDelta(
    { seconds: seconds + 0.3, ordinal: seconds * 2, startOffsetMs: 0 },
    { seconds, ordinal: seconds * 2, startOffsetMs: 300 }));
  assert.ok(points.every(point => Math.abs(point.driftMs - 300) < 1e-9));
  assert.throws(() => requireDecodedAlignment(points), /exceeds100ms/);
  assert.throws(() => decodedEdgeDelta({ seconds: 1, ordinal: 1 }, { seconds: 1, ordinal: 2 }), /must match/);
  assert.throws(() => requireDecodedAlignment([]), /unmeasured/);
  assert.throws(() => requireDecodedAlignment(points.map(point => ({ ...point, driftMs: 95, uncertaintyMs: 6 }))), /exceeds100ms/);
});
