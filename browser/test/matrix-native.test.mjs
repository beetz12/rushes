import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectNativeTrackStats } from './matrix-fixture.mjs';
import { inspectHistogramPayload } from './matrix-native-observation.mjs';

test('native stats preserve missing metadata instead of inventing zero drops', () => {
  assert.equal(inspectNativeTrackStats({ readyState: 'live' }).availability, 'absent');
  const partial = inspectNativeTrackStats({ stats: { deliveredFrames: 10 } });
  assert.equal(partial.availability, 'partial'); assert.equal(partial.totalFrames, null);
  assert.equal(partial.reportedDroppedFrames, null);
});
test('native counters distinguish a valid zero from missing fields and derive reported drops', () => {
  const zero = inspectNativeTrackStats({ stats: { deliveredFrames: 0, discardedFrames: 0, totalFrames: 0 } });
  assert.equal(zero.availability, 'available'); assert.equal(zero.reportedDroppedFrames, 0);
  const measured = inspectNativeTrackStats({ stats: { deliveredFrames: 15, discardedFrames: 2, totalFrames: 18 } });
  assert.equal(measured.reportedDroppedFrames, 1);
});
test('native stats retain getter failures rather than silently returning an empty measurement', () => {
  const value = inspectNativeTrackStats({ get stats() { throw new Error('native getter failed'); } });
  assert.equal(value.availability, 'error'); assert.ok(value.message.includes('native getter failed'));
});
test('histogram missing or malformed data cannot become an available zero count', () => {
  assert.equal(inspectHistogramPayload(undefined, 'expected').availability, 'partial');
  assert.equal(inspectHistogramPayload({ name: 'expected', count: 0 }, 'expected').availability, 'partial');
  const value = inspectHistogramPayload({ name: 'expected', count: 0, sum: 0, buckets: [] }, 'expected');
  assert.equal(value.availability, 'available'); assert.equal(value.count, 0);
});
test('histogram interval bounds and captured counts survive validation', () => {
  const histogram = { name: 'expected', count: 2, sum: 32, buckets: [{ low: 16, high: 17, count: 2 }] };
  const value = inspectHistogramPayload(histogram, 'expected');
  assert.equal(value.availability, 'available'); assert.deepEqual(value.buckets, histogram.buckets);
});
