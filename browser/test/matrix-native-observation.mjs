// Metadata validation only: this helper never creates or consumes video frames.
export function inspectHistogramPayload(histogram, expectedName) {
  const valid = histogram?.name === expectedName && Number.isSafeInteger(histogram.count)
    && histogram.count >= 0 && Number.isSafeInteger(histogram.sum) && Array.isArray(histogram.buckets)
    && histogram.buckets.every(bucket => Number.isSafeInteger(bucket.low) && Number.isSafeInteger(bucket.high)
      && bucket.high > bucket.low && Number.isSafeInteger(bucket.count) && bucket.count >= 0);
  if (!valid) return { availability: 'partial', reason: 'Histogram response lacks valid counter fields', raw: histogram ?? null };
  return { availability: 'available', delta: true, ...histogram };
}
