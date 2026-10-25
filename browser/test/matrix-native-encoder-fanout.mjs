// Explicit generated-source fanout diagnostic: one, two or three raw video-only native
// VP8 encoders over clones of the same source. No product compositor, mixer or store.
// The group shares one 10s Start expiry and one 15s finalize expiry, never 10s per encoder.
import { createNativeEncoderControl } from './matrix-native-encoder-control.mjs';

export const FANOUT_SCHEMA = 'rushes.native-encoder-fanout/1';
const START_WINDOW_MS = 10_000, FINALIZE_WINDOW_MS = 15_000;

export async function createNativeEncoderFanout(source, count, dependencies = {}) {
  if (![1, 2, 3].includes(count)) throw new Error('Native encoder fanout must be1, 2 or3');
  const now = dependencies.now ?? (() => performance.now());
  let startExpiresAtMs = null, stopExpiresAtMs = null, starting, stopping, groupFailure = null;
  const shared = { ...dependencies, startExpiresAtMs: () => startExpiresAtMs, stopExpiresAtMs: () => stopExpiresAtMs };
  const encoders = [];
  try { for (let index = 0; index < count; index++) encoders.push(createNativeEncoderControl(source, shared)); }
  catch (error) {
    // Release clones already owned by earlier encoders; none has issued a native Start.
    const released = await Promise.allSettled(encoders.map(encoder => encoder.stop()));
    if (encoders.some(encoder => !encoder.snapshot().cloneEnded))
      throw new AggregateError([error, ...released.flatMap(row => row.reason ? [row.reason] : [])], 'Fanout construction and clone release failed');
    throw error;
  }
  return {
    count,
    start() {
      if (starting || stopping) throw new Error('Native encoder fanout has already been used');
      // One common expiry, fixed before the first native Start call is issued.
      startExpiresAtMs = now() + START_WINDOW_MS;
      const started = [];
      for (const encoder of encoders) {
        try { started.push(encoder.start()); }
        catch (error) { started.push(Promise.reject(error)); }
      }
      starting = Promise.all(started); void starting.catch(() => undefined); return starting;
    },
    pause() { for (const encoder of encoders) encoder.pause(); },
    resume() { for (const encoder of encoders) encoder.resume(); },
    stop() {
      return stopping ??= (async () => {
        stopExpiresAtMs = now() + FINALIZE_WINDOW_MS;
        const settled = await Promise.allSettled(encoders.map(encoder => encoder.stop()));
        if (now() > stopExpiresAtMs) groupFailure = 'Native encoder fanout finalize exceeded its common15000ms';
        const failures = settled.flatMap(row => row.status === 'rejected' ? [row.reason] : []);
        if (groupFailure) failures.push(new Error(groupFailure));
        if (failures.length) throw failures[0];
      })();
    },
    blob(index) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error('Unknown fanout encoder');
      return encoders[index].blob();
    },
    snapshot() {
      return { schema: FANOUT_SCHEMA, scope: 'Raw native VP8 fanout source diagnostic; no product recording acceptance',
        count, startWindowMs: START_WINDOW_MS, finalizeWindowMs: FINALIZE_WINDOW_MS, startExpiresAtMs, stopExpiresAtMs,
        groupFailure, encoders: encoders.map(encoder => encoder.snapshot()) };
    },
  };
}
