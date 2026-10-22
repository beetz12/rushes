// Test-only decoded media coordinates. No callback latency or fitted intercept.
export function audioCoordinates(frames, sampleCount, rate = 48000) {
  let cursor = 0;
  const spans = frames.map((frame, index) => {
    if (frame.number !== index || !Number.isSafeInteger(frame.pts) || frame.rate !== rate
      || !Number.isSafeInteger(frame.samples) || frame.samples <= 0)
      throw new Error('Decoded audio frame metadata is incomplete');
    const span = { first: cursor, end: cursor + frame.samples, seconds: frame.pts / rate };
    cursor = span.end;
    return span;
  });
  if (!spans.length || cursor !== sampleCount) throw new Error('Decoded PCM/frame sample counts disagree');
  for (let index = 1; index < spans.length; index++) {
    if (spans[index].seconds <= spans[index - 1].seconds) throw new Error('Decoded audio presentation order is invalid');
  }
  const atSample = sample => {
    if (!Number.isFinite(sample) || sample < 0 || sample >= cursor) throw new Error('Audio sample is outside decoded media');
    let lower = 0, upper = spans.length - 1;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (sample < spans[middle].end) upper = middle; else lower = middle + 1;
    }
    const span = spans[lower];
    return span.seconds + (sample - span.first) / rate;
  };
  const nearestPresentation = seconds => {
    if (!Number.isFinite(seconds)) throw new Error('Audio time must be finite');
    let closest = null, distance = Infinity;
    for (const span of spans) {
      const sample = Math.max(span.first, Math.min(span.end - 1, span.first + (seconds - span.seconds) * rate));
      const delta = Math.abs(span.seconds + (sample - span.first) / rate - seconds);
      if (delta < distance) { distance = delta; closest = sample; }
    }
    return { sample: closest, distanceMs: distance * 1000 };
  };
  const nearPresentation = seconds => {
    const nearest = nearestPresentation(seconds);
    if (nearest.distanceMs > 1000 / rate) throw new Error('Requested audio time falls in a presentation gap');
    return nearest.sample;
  };
  const windowUncertaintyMs = (first, last) => {
    let accumulated = 0, low = 0, high = 0;
    for (let index = 1; index < spans.length; index++) {
      const span = spans[index];
      if (span.first <= first || span.first > last) continue;
      const prior = spans[index - 1];
      accumulated += (span.seconds - prior.seconds - (prior.end - prior.first) / rate) * 1000;
      low = Math.min(low, accumulated); high = Math.max(high, accumulated);
    }
    return high - low;
  };
  return { atSample, nearPresentation, nearestPresentation, windowUncertaintyMs, spans, rate, sampleCount,
    firstSeconds: spans[0].seconds, endSeconds: atSample(cursor - 1) + 1 / rate,
    joins: spans.slice(1).map((span, index) => ({ seconds: span.seconds,
      gapMs: (span.seconds - atSample(spans[index].end - 1) - 1 / rate) * 1000 })) };
}

export function decodedEdgeDelta(video, audio) {
  if (!Number.isInteger(video.ordinal) || video.ordinal !== audio.ordinal
    || !Number.isFinite(video.seconds) || !Number.isFinite(audio.seconds))
    throw new Error('Decoded ordinal edges must match in actual media coordinates');
  return { ordinal: video.ordinal, videoSeconds: video.seconds, audioSeconds: audio.seconds,
    driftMs: (video.seconds - audio.seconds) * 1000 };
}

export function temporalEdges(edges, firstSeconds, lastSeconds) {
  if (!Number.isFinite(firstSeconds) || !Number.isFinite(lastSeconds) || lastSeconds <= firstSeconds)
    throw new Error('Decoded presentation extent is missing');
  const candidates = edges.filter(edge => edge.ordinal === edge.previousOrdinal + 1
    && edge.seconds > firstSeconds + 0.25 && edge.seconds < lastSeconds - 0.25);
  const selected = [firstSeconds + 0.5, (firstSeconds + lastSeconds) / 2, lastSeconds - 0.5].map(target => {
    const nearest = candidates.reduce((best, edge) => !best || Math.abs(edge.seconds - target) < Math.abs(best.seconds - target) ? edge : best, null);
    // Declared500ms optical phase plus protected250ms maximum media gap.
    if (!nearest || Math.abs(nearest.seconds - target) > 0.75)
      throw new Error('Optical transitions do not cover the actual beginning/middle/end');
    return nearest;
  });
  if (new Set(selected.map(edge => edge.ordinal)).size !== 3) throw new Error('Three distinct temporal anchors are required');
  return selected;
}

export function requireDecodedAlignment(points) {
  if (points.length !== 3 || points.some(point => !Number.isFinite(point.driftMs)
    || !Number.isFinite(point.uncertaintyMs ?? 0) || (point.uncertaintyMs ?? 0) < 0
    || Math.abs(point.driftMs) + (point.uncertaintyMs ?? 0) > 100))
    throw new Error('Decoded beginning/middle/end alignment exceeds100ms or is unmeasured');
}
