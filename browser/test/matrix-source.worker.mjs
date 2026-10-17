// Test-only native-frame observer: no interval or animation source clock.
// Sixteen preencoded optical bits identify each phase. The same ordinal reaches the
// AudioWorklet through a transferred port, avoiding Window background callbacks.
import { copyOpticalRegion } from './native-optical-roi.mjs';
let retire;
onmessage = async event => {
  if (event.data.kind === 'stop') { await retire?.(event.data.stopAtTimestampUs); return; }
  const { input, audioPort } = event.data;
  const reader = input.getReader();
  let previousOrdinal = -1, frames = 0, stopping = false, finalInput, finalEmission, firstTimestamp, lastTimestamp, maxTimestampGapUs = 0;
  const gaps = [];
  let omittedGaps = 0, maxReadWaitMs = 0, maxReadbackMs = 0, maxCopyMs = 0, maxNativeLeaseMs = 0, previousReadCompletedMs;
  let notifyEmission;
  let stopAtTimestampUs, crossingTimestampUs;
  const emissions = new Promise(resolve => { notifyEmission = resolve; });
  let observedDone;
  const observed = new Promise(resolve => { observedDone = resolve; });
  retire = async cutoff => {
    if (stopping) return; stopping = true;
    try {
      if (cutoff !== undefined) {
        if (!Number.isSafeInteger(cutoff)) throw new Error('Invalid optical Stop boundary');
        if (lastTimestamp > cutoff) throw new Error('Optical observation already exceeded its Stop boundary');
        stopAtTimestampUs = cutoff;
        const begun = performance.now();
        let deadline;
        try { await Promise.race([observed, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Optical Stop boundary was not drained within250ms')), 250);
        })]); } finally { clearTimeout(deadline); }
        if (!Number.isSafeInteger(crossingTimestampUs) || crossingTimestampUs <= cutoff || crossingTimestampUs - cutoff > 250000
          || performance.now() - begun > 250)
          throw new Error('Optical Stop boundary lacks a crossing within250ms');
      } else { await reader.cancel(); await observed; }
      if (!finalInput) throw new Error('Source observer stopped without an input anchor');
      if (finalEmission?.ordinal !== finalInput.ordinal || finalEmission?.sourceTimestampUs !== finalInput.timestamp) {
        let deadline;
        try { await Promise.race([emissions, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Final source emission receipt did not arrive')), 250);
        })]); } finally { clearTimeout(deadline); }
      }
      if (finalEmission?.ordinal !== finalInput.ordinal || finalEmission?.sourceTimestampUs !== finalInput.timestamp)
        throw new Error('Final source emission receipt does not match its input');
      postMessage({ kind: 'stopped', finalInput, finalEmission, boundary: { cutoffUs: cutoff ?? null, crossingTimestampUs: crossingTimestampUs ?? null },
        optical: { firstTimestamp, lastTimestamp, maxTimestampGapUs, count: frames,
        diagnostics: { method: 'native-yuv-roi-copy', gaps, omittedGaps, maxReadWaitMs, maxReadbackMs, maxCopyMs, maxNativeLeaseMs } } });
    } catch (error) {
      postMessage({ kind: 'observer-error', message: String(error), frames });
      await reader.cancel().catch(() => undefined); await observed;
    }
  };
  audioPort.onmessage = reply => {
    if (reply.data.measurement === 'error') postMessage({ kind: 'observer-error', message: reply.data.message });
    else {
      postMessage({ ...reply.data, kind: reply.data.measurement === 'emission' ? 'audio-anchor' : 'audio-arrival' });
      if (reply.data.measurement === 'emission') {
        finalEmission = reply.data;
        if (stopping && finalInput?.ordinal === finalEmission.ordinal && finalInput?.timestamp === finalEmission.sourceTimestampUs) notifyEmission();
      }
    }
  };
  try {
    for (;;) {
      const readStartedMs = performance.now();
      const item = await reader.read(); if (item.done) break;
      const readCompletedMs = performance.now(), readWaitMs = readCompletedMs - readStartedMs;
      maxReadWaitMs = Math.max(maxReadWaitMs, readWaitMs);
      const frame = item.value;
      let handedOff = false;
      try {
        const timestamp = frame.timestamp;
        if (!Number.isSafeInteger(timestamp) || (lastTimestamp !== undefined && timestamp <= lastTimestamp))
          throw new Error('Nonmonotonic optical source reference');
        // A later native frame proves that queued pre-Stop observations drained.
        // Never feed its ordinal to the tone source or extend the optical extent.
        if (stopAtTimestampUs !== undefined && timestamp > stopAtTimestampUs) { crossingTimestampUs = timestamp; break; }
        handedOff = true;
        const observation = await copyOpticalRegion(frame), { ordinal } = observation;
        // Stop can arrive while the native copy is pending. Recheck admission
        // after that await; the copied pixels must not extend the stopped input.
        if (stopAtTimestampUs !== undefined && timestamp > stopAtTimestampUs) { crossingTimestampUs = timestamp; break; }
        const readbackMs = observation.observationMs;
        maxReadbackMs = Math.max(maxReadbackMs, readbackMs);
        maxCopyMs = Math.max(maxCopyMs, observation.copyMs);
        maxNativeLeaseMs = Math.max(maxNativeLeaseMs, observation.closedAtMs - readCompletedMs);
        firstTimestamp ??= timestamp;
        if (lastTimestamp !== undefined) {
          const gapUs = timestamp - lastTimestamp;
          maxTimestampGapUs = Math.max(maxTimestampGapUs, gapUs);
          if (gapUs > 100000) {
            if (gaps.length < 64) gaps.push({ previousTimestamp: lastTimestamp, timestamp, gapUs,
              readStartedMs, readCompletedMs, previousReadCompletedMs, readWaitMs, readbackMs,
              copyMs: observation.copyMs, nativeLeaseMs: observation.closedAtMs - readCompletedMs,
              observationTimeOrigin: performance.timeOrigin });
            else omittedGaps++;
          }
        }
        lastTimestamp = timestamp;
        previousReadCompletedMs = readCompletedMs;
        if (ordinal !== previousOrdinal) {
          previousOrdinal = ordinal; audioPort.postMessage({ ordinal, sourceTimestampUs: timestamp });
          finalInput = { ordinal, timestamp };
          postMessage({ kind: 'input-anchor', ordinal, timestamp,
            globalWallMs: performance.timeOrigin + performance.now() });
        }
        frames++;
        if (frames === 1) postMessage({ kind: 'ready' });
      } finally { if (!handedOff) frame.close(); }
    }
  } catch (error) { postMessage({ kind: 'observer-error', message: String(error), frames,
    globalWallMs: performance.timeOrigin + performance.now() }); }
  finally {
    try { await reader.cancel(); }
    catch (error) { postMessage({ kind: 'observer-error', message: String(error), frames }); }
    reader.releaseLock(); observedDone();
  }
};
