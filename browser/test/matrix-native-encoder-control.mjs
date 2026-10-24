// Explicit generated-source diagnostic only. No product compositor or draft store.
const MIME = 'video/webm;codecs=vp8', VIDEO_BITS = 4_000_000, MAX_BYTES = 32 * 1024 ** 2;
export function createNativeEncoderControl(source, dependencies = {}) {
  const Recorder = dependencies.Recorder ?? globalThis.MediaRecorder;
  const Stream = dependencies.Stream ?? globalThis.MediaStream;
  const now = dependencies.now ?? (() => performance.now());
  const schedule = dependencies.schedule ?? setTimeout, unschedule = dependencies.unschedule ?? clearTimeout;
  if (source?.kind !== 'video' || source.readyState !== 'live') throw new Error('Raw control requires a live native video source');
  if (!Recorder?.isTypeSupported(MIME)) throw new Error('Raw native VP8 control is unsupported');
  const track = source.clone(); let recorder;
  try { recorder = new Recorder(new Stream([track]), { mimeType: MIME, videoBitsPerSecond: VIDEO_BITS }); }
  catch (error) { track.stop(); throw error; }
  const chunks = [], rows = [], failures = [];
  let bytes = 0, droppedRows = 0, startCalls = 0, startReturns = 0, startEvents = 0;
  let stopCalls = 0, stopReturns = 0, stopEvents = 0, emptyChunks = 0;
  let starting, retiring, startTimer, stopTimer, firstStartMs = null, startRequestedMs = null, stopRequestedMs = null;
  let startResolve, startReject, stopResolve;
  const stopped = new Promise(resolve => { stopResolve = resolve; });
  function observe(kind, detail = {}) {
    if (rows.length < 64) rows.push({ kind, atMs: now(), state: recorder.state, ...detail });
    else { droppedRows++; fail('Raw encoder observation overflow'); }
  }
  function fail(message) { if (!failures.includes(message)) failures.push(message); startReject?.(new Error(message)); }
  recorder.addEventListener('start', () => {
    startEvents++; observe('start-event');
    // Chromium can synthesize a first start event from Stop's empty WriteData.
    if (retiring || recorder.state !== 'recording' || failures.length) return;
    if (startRequestedMs === null || now() - startRequestedMs >= 10_000) { fail('Raw native VP8 start acknowledgement arrived after its deadline'); return; }
    firstStartMs = now(); unschedule(startTimer); startResolve?.();
  });
  recorder.addEventListener('stop', () => { stopEvents++; observe('stop-event'); stopResolve(); });
  recorder.addEventListener('pause', () => observe('pause-event'));
  recorder.addEventListener('resume', () => observe('resume-event'));
  recorder.addEventListener('error', () => { observe('error-event'); fail('Raw native VP8 encoder error'); });
  recorder.addEventListener('dataavailable', event => {
    const size = event.data.size;
    if (!Number.isSafeInteger(size) || size < 0) { fail('Invalid raw encoded chunk size'); return; }
    observe('data-event', { bytes: size });
    if (!size) { emptyChunks++; return; }
    if (bytes + size > MAX_BYTES || chunks.length >= 32) { fail('Raw encoder control exceeded its memory bound'); return; }
    chunks.push(event.data); bytes += size;
  });
  return {
    start() {
      if (starting || retiring) throw new Error('Raw encoder control has already been used');
      starting = new Promise((resolve, reject) => {
        startResolve = resolve; startReject = reject; startRequestedMs = now();
        startTimer = schedule(() => fail('Raw native VP8 encoder did not start within10000ms'), 10_000);
        observe('start-call'); startCalls++;
        try { recorder.start(2000); startReturns++; observe('start-return'); }
        catch (error) { unschedule(startTimer); fail('Raw native VP8 start call failed'); reject(error); }
      });
      void starting.catch(() => undefined); return starting;
    },
    pause() {
      if (firstStartMs === null || retiring || recorder.state !== 'recording') throw new Error('Raw encoder is not recording');
      observe('pause-call'); recorder.pause(); observe('pause-return');
    },
    resume() {
      if (firstStartMs === null || retiring || recorder.state !== 'paused') throw new Error('Raw encoder is not paused');
      observe('resume-call'); recorder.resume(); observe('resume-return');
    },
    stop() {
      if (retiring) return retiring;
      // Claim retirement before a synchronous native Stop or late start callback.
      retiring = Promise.resolve().then(async () => {
        unschedule(startTimer); stopRequestedMs = now();
        const expires = stopRequestedMs + 15_000;
        if (firstStartMs === null) fail('Raw encoder stopped without a live start acknowledgement');
        try {
          if (!startCalls) throw new Error('Raw encoder stopped before its start call');
          if (recorder.state !== 'inactive') {
            observe('stop-call'); stopCalls++;
            try { recorder.stop(); stopReturns++; observe('stop-return'); }
            catch (error) { fail('Raw native VP8 stop call failed'); throw error; }
          }
          await Promise.race([stopped, new Promise((_, reject) => {
            stopTimer = schedule(() => { fail('Raw native VP8 stop acknowledgement timed out'); reject(new Error(failures.at(-1))); }, Math.max(1, expires - now()));
          })]);
        } finally { unschedule(stopTimer); track.stop(); observe('clone-ended', { ended: track.readyState === 'ended' }); }
        if (now() > expires) fail('Raw native VP8 retirement exceeded15000ms');
        if (!stopEvents || track.readyState !== 'ended' || droppedRows || failures.length)
          throw new Error(failures[0] ?? 'Raw encoder retirement was not confirmed');
      });
      void retiring.catch(() => undefined); return retiring;
    },
    blob() { return new Blob(chunks, { type: recorder.mimeType || MIME }); },
    snapshot() {
      return { scope: 'Raw native VP8 source diagnostic; no product recording acceptance',
        mimeType: recorder.mimeType || MIME, requestedBitsPerSecond: VIDEO_BITS, timesliceMs: 2000,
        startCalls, startReturns, startEvents, startRequestedMs, firstStartMs, stopCalls, stopReturns, stopEvents, stopRequestedMs,
        bytes, chunks: chunks.length, emptyChunks, rows: structuredClone(rows), droppedRows, failures: [...failures],
        cloneEnded: track.readyState === 'ended', originalLive: source.readyState === 'live' };
    },
  };
}
