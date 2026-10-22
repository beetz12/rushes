// Generated test input observation only. No product import, permissions or export correction.
// Existing200ms search after an edge plus the20ms half-window.
export const SOURCE_PCM_GUARD_MS = 220;
const within = async (operation, ms, label) => {
  let timer; try { return await Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline`)), ms);
  })]); } finally { clearTimeout(timer); }
};
export async function nativeReferenceWitness(track, observerErrors, clock) {
  const timeOrigin = performance.timeOrigin, setupStartedPageMs = performance.now();
  if (clock.error || !clock.converter?.qualified || clock.timeOrigin !== timeOrigin)
    throw new Error('Same-Window native reference clock is unqualified');
  const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('source-reference', { create: true });
  const name = `${crypto.randomUUID()}.f32le`, handle = await directory.getFileHandle(name, { create: true });
  const sink = await handle.createWritable();
  const sinkOpenedPageMs = performance.now();
  let clone, processor, reader;
  try {
    clone = track.clone(); processor = new MediaStreamTrackProcessor({ track: clone, maxBufferSize: 100 });
    reader = processor.readable.getReader();
  } catch (error) {
    const failures = [error];
    try { clone?.stop(); } catch (cleanup) { failures.push(cleanup); }
    try { await within(typeof sink.abort === 'function' ? sink.abort() : sink.close(), 2000, 'Reference setup retirement'); }
    catch (cleanup) { failures.push(cleanup); }
    throw new AggregateError(failures, 'Supplied-reference observer setup failed');
  }
  const readerCreatedPageMs = performance.now(), frames = [];
  let firstObservedPageMs;
  let settled = false, stopped = false, bytes = 0, pending = 0, peakPending = 0, writeError, failed = false;
  let lastSampleEndMs = -Infinity; const coverageListeners = new Set();
  let batch = [], batchBytes = 0, tail = Promise.resolve();
  const reportError = error => { failed = true; observerErrors.push({ name: 'supplied-reference-audio', message: String(error), wallMs: performance.now() }); };
  const flush = () => {
    if (!batchBytes) return;
    const data = new Uint8Array(batchBytes); let cursor = 0;
    for (const item of batch) { data.set(item, cursor); cursor += item.length; }
    batch = []; batchBytes = 0; pending += data.length; peakPending = Math.max(peakPending, pending);
    if (pending > 1024 ** 2) throw new Error('Supplied reference observation writer exceeded1MiB queue');
    tail = tail.then(async () => {
      try { if (!writeError) await sink.write(data); }
      catch (error) { writeError ??= error; reportError(error); }
      finally { pending -= data.length; }
    });
  };
  const task = (async () => {
    try {
      while (!stopped) {
        const item = await reader.read(); if (item.done) break;
        const data = item.value;
        try {
          if (writeError) throw writeError;
          if (data.sampleRate !== 48000 || ![1, 2].includes(data.numberOfChannels)
            || !Number.isSafeInteger(data.numberOfFrames) || data.numberOfFrames <= 0 || !Number.isFinite(data.timestamp))
            throw new Error('Unsupported supplied reference PCM metadata');
          const pcm = new Float32Array(data.numberOfFrames); data.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
          bytes += pcm.byteLength;
          if (bytes > 660 * 48000 * 4 || frames.length >= 66000) throw new Error('Supplied reference observation budget exceeded');
          firstObservedPageMs ??= performance.now();
          frames.push({ timestampUs: data.timestamp, rate: data.sampleRate, frames: data.numberOfFrames, channels: data.numberOfChannels });
          lastSampleEndMs = (Math.round(data.timestamp * data.sampleRate / 1e6) + data.numberOfFrames) * 1000 / data.sampleRate;
          for (const notify of coverageListeners) notify();
          batch.push(new Uint8Array(pcm.buffer)); batchBytes += pcm.byteLength;
          if (batchBytes >= 65536) flush();
        } finally { data.close(); }
      }
    } catch (error) { reportError(error); }
    finally { settled = true; for (const notify of coverageListeners) notify(); reader.releaseLock(); }
  })();
  let result;
  return {
    startupState() { return { readerCreatedPageMs, sinkOpenedPageMs, firstObservedPageMs,
      framesReceived: frames.length, bytes, pending, settled, stopped, failed,
      firstTimestampUs: frames[0]?.timestampUs, lastTimestampUs: frames.at(-1)?.timestampUs }; },
    async ready() {
      let notify;
      try {
        await within(new Promise(resolve => {
          notify = () => { if (frames.length || settled) resolve(); };
          coverageListeners.add(notify); notify();
        }), 1000, 'Initial supplied-reference PCM');
        if (!frames.length || failed || settled) throw new Error('Initial supplied-reference PCM is unavailable');
        return { setupStartedPageMs, sinkOpenedPageMs, readerCreatedPageMs, firstObservedPageMs,
          firstTimestampUs: frames[0].timestampUs, acknowledgedPageMs: performance.now() };
      } finally { if (notify) coverageListeners.delete(notify); }
    },
    async stop({ coverThroughPageMs } = {}) {
      if (result) return result;
      const coverageStarted = performance.now();
      if (coverThroughPageMs !== undefined) {
        let notify;
        try {
          if (!Number.isFinite(coverThroughPageMs)) throw new Error('Invalid supplied-reference coverage target');
          await within(new Promise(resolve => {
            notify = () => { if (lastSampleEndMs >= coverThroughPageMs || settled) resolve(); };
            coverageListeners.add(notify); notify();
          }), 250, 'Supplied-reference PCM coverage');
          if (lastSampleEndMs < coverThroughPageMs) throw new Error('Source ended before actual video extent was covered');
          if (performance.now() - coverageStarted > 250) throw new Error('Supplied-reference coverage exceeded its measured250ms budget');
        } catch (error) { reportError(error); }
        finally { if (notify) coverageListeners.delete(notify); }
      }
      const coverageWaitMs = performance.now() - coverageStarted;
      stopped = true;
      const counters = Object.fromEntries(['totalFrames', 'discardedFrames'].map(key => [key,
        Number.isSafeInteger(processor[key]) ? processor[key] : null]));
      // A failed observer may already have released its lock. Cleanup still proceeds.
      try { if (!settled) await within(reader.cancel(), 2000, 'Reference reader cancellation'); }
      catch (error) { reportError(error); }
      finally { clone.stop(); }
      try { await within(task, 2000, 'Reference reader retirement'); flush(); await within(tail, 5000, 'Reference writer drain'); }
      catch (error) { reportError(error); }
      try { await within(sink.close(), 5000, 'Reference writer close'); }
      catch (error) { reportError(error); }
      let file;
      try { file = await within(handle.getFile(), 2000, 'Reference observation read'); }
      catch (error) { reportError(error); }
      result = { schema: 'rushes.supplied-reference-observation/1', timeOrigin, sameWindow: true,
        sourceTimestampMeaning: 'Chrome supplied rendering-processing reference plus FIFO sample offset; no physical playout or sensor claim',
        pcmFormat: 'f32le', observedPlane: 0, storedChannels: 1,
        coverThroughPageMs: coverThroughPageMs ?? null, lastSampleEndMs, coverageWaitMs, coverageCoordinate: 'rounded48000Hz supplied sample PTS',
        startup: { setupStartedPageMs, sinkOpenedPageMs, readerCreatedPageMs, firstObservedPageMs, firstTimestampUs: frames[0]?.timestampUs ?? null },
        frames, bytes, actualFileBytes: file?.size ?? null, peakPendingBytes: peakPending, countersBeforeCancel: counters,
        observationFile: name, closed: !failed && !writeError && file?.size === bytes };
      return result;
    },
    async file() { if (!result) throw new Error('Reference observation is not closed'); return within(handle.getFile(), 2000, 'Reference observation download'); },
  };
}
