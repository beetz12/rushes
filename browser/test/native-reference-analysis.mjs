import assert from 'node:assert/strict';
import { audioCoordinates, requireDecodedAlignment } from './media-coordinates.mjs';
import { referenceSync } from './decoded-media.mjs';

// Actual PCM/optical content in supplied track reference coordinates. No output-fit offset.
export function qualifyNativeReference(snapshot, bytes) {
  const metrics = snapshot.metrics, clock = metrics.clockCapability, converter = clock?.converter;
  const witness = metrics.suppliedReference;
  assert.equal(clock?.error, undefined); assert.equal(converter?.qualified, true); assert.equal(converter.unitSlope, 1);
  assert.equal(witness?.schema, 'rushes.supplied-reference-observation/1');
  assert.equal(witness.takeId, snapshot.id);
  assert.equal(witness.pcmFormat, 'f32le'); assert.equal(witness.observedPlane, 0); assert.equal(witness.storedChannels, 1);
  assert.equal(witness.sameWindow, true); assert.equal(witness.timeOrigin, clock.timeOrigin); assert.ok(Number.isFinite(witness.timeOrigin));
  assert.equal(witness.closed, true); assert.equal(witness.actualFileBytes, bytes.length); assert.equal(witness.bytes, bytes.length);
  assert.ok(bytes.length > 0 && bytes.length <= 660 * 48000 * 4 && witness.peakPendingBytes <= 1024 ** 2);
  const [low, high] = converter.originIntervalMs;
  assert.ok(Number.isFinite(low) && Number.isFinite(high) && low <= high && high - low <= 1);
  assert.ok(Number.isFinite(converter.conservativeSameRealmConversionUncertaintyMs)
    && converter.conservativeSameRealmConversionUncertaintyMs >= high - low);
  const origin = (low + high) / 2, rows = metrics.calibrationInputEdges;
  assert.ok(rows.length >= 6);
  const converted = rows.map(row => ({ seconds: (row.timestamp / 1000 - origin) / 1000, ordinal: row.ordinal }));
  assert.ok(converted.every(row => Number.isFinite(row.seconds) && Number.isInteger(row.ordinal)
    && row.seconds >= 0 && Math.abs(row.seconds * 1000 - snapshot.wallMs) < 660000));
  const input = metrics.frames['native-input'];
  assert.ok(input.count > 0 && input.maxTimestampGapUs <= 250000);
  const optical = metrics.sourceObserverRetirement?.optical;
  assert.ok(optical && Number.isSafeInteger(optical.firstTimestamp) && Number.isSafeInteger(optical.lastTimestamp)
    && optical.lastTimestamp > optical.firstTimestamp && Number.isSafeInteger(optical.count) && optical.count >= rows.length
    && Number.isFinite(optical.maxTimestampGapUs) && optical.maxTimestampGapUs > 0 && optical.maxTimestampGapUs <= 250000,
  'Actual optical observation extent is required');
  assert.ok(rows[0].timestamp >= optical.firstTimestamp && rows.at(-1).timestamp <= optical.lastTimestamp);
  const first = (Math.max(input.firstTimestamp, optical.firstTimestamp) / 1000 - origin) / 1000;
  const last = (Math.min(input.lastTimestamp, optical.lastTimestamp) / 1000 - origin) / 1000;
  assert.ok(last > first);
  assert.ok(converted.every((edge, index) => !index || (edge.ordinal === converted[index - 1].ordinal + 1
    && edge.seconds > converted[index - 1].seconds)));
  const initial = converted.filter(edge => edge.seconds <= first).at(-1);
  assert.ok(initial, 'The scoped interval needs an actually observed initial ordinal');
  const scoped = converted.filter(edge => edge.seconds > first && edge.seconds <= last);
  assert.ok(scoped.length >= 3, 'Three actual optical transitions are required');
  const visual = [{ ...initial, seconds: first }, ...scoped, { ...scoped.at(-1), seconds: last }];
  const visualEdges = scoped.map((row, index) => ({ ...row, previousOrdinal: index ? scoped[index - 1].ordinal : initial.ordinal }));
  let samples = 0;
  const frames = witness.frames.map((frame, number) => {
    assert.equal(frame.rate, 48000); assert.ok(Number.isSafeInteger(frame.frames) && frame.frames > 0
      && Number.isFinite(frame.timestampUs) && frame.timestampUs >= 0 && frame.timestampUs <= snapshot.wallMs * 1000 + 1000);
    samples += frame.frames;
    return { number, pts: Math.round(frame.timestampUs * 48000 / 1e6), rate: 48000, samples: frame.frames };
  });
  assert.equal(samples * 4, bytes.length);
  for (let at = 0; at < bytes.length; at += 4) assert.ok(Number.isFinite(bytes.readFloatLE(at)));
  const coordinates = audioCoordinates(frames, samples);
  assert.ok(coordinates.joins.every(join => Math.abs(join.gapMs) <= 250), 'Supplied audio has a gap over250ms');
  assert.ok(coordinates.firstSeconds <= first && coordinates.endSeconds >= last, 'PCM must cover actual observed video extent');
  const decoded = referenceSync({ visual, visualEdges, bytes, coordinates,
    timeBasis: 'same-Window supplied-track reference timestamps',
    conversionUncertaintyMs: converter.conservativeSameRealmConversionUncertaintyMs + 1000 / 48000 });
  requireDecodedAlignment(decoded.points);
  return { qualified: true, sourceKind: 'measured-supplied-track-reference-timeline', sameRun: true, sameWindow: true,
    timeOrigin: witness.timeOrigin, observedOpticalIntervalSeconds: { first, last }, wholeExtentCovered: true, joinsWithin250ms: true, converter, decoded,
    limitation: 'Generated supplied-reference phase only; no physical sensor, AudioContext playout or speaker timing claim' };
}
