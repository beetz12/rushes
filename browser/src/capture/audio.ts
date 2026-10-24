import type { AudioFailureDetails, AudioTransportStatus } from '../contracts';
import type { AudioTransformAPIs, PCMFrame } from './audio-frame';
import { MIX_FRAMES, MIX_RATE, stereoPlanes } from './pcm-mixer';
import { createWindowAudioMixer } from './audio-mixer';
// Endpoints stay in this Window: Chrome changes reference origins on stream transfer.
// Only copied PCM crosses the owned message ports. Originals belong to the coordinator.
export function composedAudio(tracks: MediaStreamTrack[], failed: (message: string) => void = () => undefined): {
  track?: MediaStreamTrack; readonly diagnostics?: { [key: string]: unknown; parentFailure?: AudioFailureDetails }; status?(): AudioTransportStatus; start(): Promise<void>; quiesce(): Promise<void>; close(): void;
} {
  if (!tracks.length) return { async start() {}, async quiesce() {}, close() {} };
  if (tracks.length === 1) {
    const track = tracks[0].clone();
    return { track, async start() {}, async quiesce() {}, close() { track.stop(); } };
  }
  if (tracks.length !== 2) throw new Error('Composition accepts at most two audio inputs');
  const apis = globalThis as unknown as AudioTransformAPIs;
  if (!apis.AudioData || !apis.MediaStreamTrackProcessor || !apis.MediaStreamTrackGenerator)
    throw new Error('This Chrome version cannot preserve composed audio references');
  const owned: MediaStreamTrack[] = [], readers: ReadableStreamDefaultReader<PCMFrame>[] = [];
  const pendingFrames = [0, 0], posted = [0, 0], consumed = [0, 0];
  let messages = 0, lastMessageAt: number | undefined, lastKind: AudioFailureDetails['lastKind'] = null;
  let outputPackets = 0, outputSequence: number | null = null, writes = 0, receipts = 0, writeAt: number | undefined;
  let parentFailure: AudioFailureDetails | undefined;
  let capacityFailure: Pick<AudioFailureDetails, 'edge' | 'input' | 'waitMs'> | undefined;
  const capacityWake: Array<(() => void) | undefined> = [undefined, undefined];
  let output: InstanceType<AudioTransformAPIs['MediaStreamTrackGenerator']> | undefined, worker: ReturnType<typeof createWindowAudioMixer> | undefined;
  let writer: WritableStreamDefaultWriter<PCMFrame> | undefined;
  let closed = false, quiesced = false, writing = false, readied = false, hasFailureDiagnostics = false, diagnostics: { [key: string]: unknown; parentFailure?: AudioFailureDetails } | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let quiescedAt: number | undefined;
  let readyResolve: () => void, readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => undefined);
  let stoppedResolve: () => void, stoppedReject: (error: Error) => void;
  const stopped = new Promise<void>((resolve, reject) => { stoppedResolve = resolve; stoppedReject = reject; });
  void stopped.catch(() => undefined);
  function quiesce() {
    if (!quiesced) {
      quiescedAt = performance.now();
      quiesced = true; clearTimeout(deadline);
      // Native recorders are paused first. Retire new input while their saved
      // encoder callbacks drain; ending the output track here would stop them.
      owned.forEach(track => track.stop());
      capacityWake.forEach(wake => wake?.());
      for (const reader of readers) void reader.cancel().catch(() => undefined);
      worker?.postMessage({ kind: 'stop' });
    }
    return stopped;
  }
  function close() {
    if (closed) return; void quiesce(); closed = true;
    stoppedReject(new Error('Composed audio closed before its mixer stop acknowledgement'));
    readyReject(new Error('Composed audio was closed')); output?.stop();
    if (writer) void writer.abort().finally(() => writer?.releaseLock()).catch(() => undefined);
    if (worker) deadline = setTimeout(() => worker?.terminate(), 500);
  }
  function status(at = performance.now()): AudioTransportStatus {
    return Object.freeze({ pending: Object.freeze([pendingFrames[0], pendingFrames[1]] as const),
      posted: Object.freeze([posted[0], posted[1]] as const), consumed: Object.freeze([consumed[0], consumed[1]] as const),
      messages, lastKind, lastAgeMs: lastMessageAt === undefined ? null : Math.ceil(at - lastMessageAt),
      output: Object.freeze([outputPackets, outputSequence, writes, receipts] as const), writing,
      writeAgeMs: writeAt === undefined ? null : Math.ceil(at - writeAt), readied, quiesced, closed });
  }
  function failure(message: string) {
    if (!closed) {
      const at = performance.now();
      parentFailure ??= Object.freeze({ schema: 1, edge: capacityFailure?.edge ?? 'other', input: capacityFailure?.input ?? null,
        waitMs: capacityFailure?.waitMs ?? null, ...status(at) });
      hasFailureDiagnostics = true;
      readyReject(new Error(message));
      // A consumer may enter synchronous native Stop. Retire owned audio first.
      try { close(); } finally { failed(message); }
    }
  }
  async function waitForCapacity(source: number, frames: number, rate: number) {
    const begun = performance.now(), expires = begun + 250;
    const timeout = (edge: 'before-wait' | 'timer' | 'late-wake') => {
      capacityFailure ??= { edge, input: Object.freeze([source, frames, rate] as const), waitMs: Math.ceil(performance.now() - begun) };
      return new Error('Audio mixer capacity receipt timed out');
    };
    while (!quiesced && pendingFrames[source] + frames > rate / 4) {
      const remaining = expires - performance.now();
      if (remaining <= 0) throw timeout('before-wait');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          capacityWake[source] = resolve;
          timer = setTimeout(() => reject(timeout('timer')), remaining);
        });
        // A queued receipt cannot beat an already-expired deadline. A prior
        // Stop still retires its held packet at the time quiescence began.
        if ((quiescedAt ?? performance.now()) >= expires) throw timeout('late-wake');
      } finally { clearTimeout(timer); capacityWake[source] = undefined; }
    }
  }
  async function consume(reader: ReadableStreamDefaultReader<PCMFrame>, source: number) {
    try {
      while (!quiesced) {
        const item = await reader.read();
        if (item.done) { if (!quiesced) throw new Error('A composed audio source ended'); break; }
        const frame = item.value;
        try {
          if (quiesced) continue;
          if (![1, 2, 4, 6].includes(frame.numberOfChannels) || frame.numberOfFrames > frame.sampleRate / 4)
            throw new Error('Unsupported composed audio packet');
          if (pendingFrames[source] + frame.numberOfFrames > frame.sampleRate / 4)
            await waitForCapacity(source, frame.numberOfFrames, frame.sampleRate);
          if (quiesced) continue;
          const channels = Array.from({ length: frame.numberOfChannels }, (_, planeIndex) => {
            const data = new Float32Array(frame.numberOfFrames); frame.copyTo(data, { planeIndex, format: 'f32-planar' }); return data;
          });
          let [left, right] = stereoPlanes(channels);
          // Mono shares a plane until this boundary; transfer each buffer only once.
          if (left === right) right = right.slice();
          pendingFrames[source] += frame.numberOfFrames;
          if (pendingFrames[source] > frame.sampleRate / 4) throw new Error('Audio mixer queue exceeded250ms');
          worker!.postMessage({ kind: 'input', source, rate: frame.sampleRate, timestamp: frame.timestamp, left, right }, [left.buffer, right.buffer]); posted[source]++;
        } finally { frame.close(); }
      }
    } catch (error) { failure(`Audio composition failed: ${String(error)}`); }
    finally { reader.releaseLock(); }
  }
  async function write(sequence: number, timestamp: number, data: Float32Array) {
    let frame: PCMFrame | undefined, writeDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (writing) throw new Error('Audio output exceeded one pending packet'); writing = true; writeAt = performance.now();
      frame = new apis.AudioData({ format: 'f32-planar', sampleRate: MIX_RATE, numberOfChannels: 2,
        numberOfFrames: MIX_FRAMES, timestamp, data });
      await Promise.race([writer!.write(frame), new Promise<never>((_, reject) => {
        writeDeadline = setTimeout(() => { if (!quiesced) reject(new Error('Composed audio sink timed out')); }, 1000);
      })]);
      writes++;
      if (!quiesced) { worker!.postMessage({ kind: 'written', sequence }); receipts++; }
    } catch (error) { failure(`Audio composition failed: ${String(error)}`); }
    finally { clearTimeout(writeDeadline); frame?.close(); writing = false; writeAt = undefined; }
  }
  try {
    for (const track of tracks) {
      const clone = track.clone(); owned.push(clone);
      readers.push(new apis.MediaStreamTrackProcessor({ track: clone, maxBufferSize: 25 }).readable.getReader());
    }
    output = new apis.MediaStreamTrackGenerator({ kind: 'audio' }); writer = output.writable.getWriter();
    worker = createWindowAudioMixer();
    worker.onmessage = event => {
      messages++; lastMessageAt = performance.now();
      lastKind = ['consumed', 'packet', 'ready', 'timing', 'error', 'stopped'].includes(event.data.kind) ? event.data.kind : 'unknown';
      if (event.data.kind === 'stopped') { clearTimeout(deadline); stoppedResolve(); worker?.terminate(); }
      else if (event.data.kind === 'timing') { if (!hasFailureDiagnostics) diagnostics = event.data.diagnostics; }
      else if (closed) return;
      else if (event.data.kind === 'consumed') {
        const { source, frames } = event.data;
        if (![0, 1].includes(source) || !Number.isSafeInteger(frames) || frames <= 0 || frames > pendingFrames[source])
          failure('Invalid audio input receipt');
        else { pendingFrames[source] -= frames; consumed[source]++; capacityWake[source]?.(); }
      }
      else if (event.data.kind === 'packet') {
        outputPackets++; outputSequence = event.data.sequence;
        if (!quiesced) void write(event.data.sequence, event.data.timestamp, event.data.data);
      }
      else if (event.data.kind === 'ready') { readied = true; clearTimeout(deadline); readyResolve(); }
      else if (event.data.kind === 'error') {
        hasFailureDiagnostics = true;
        diagnostics = { ...event.data.diagnostics, parent: { closed, quiesced, writing, readied, pendingFrames: [...pendingFrames] } };
        failure(`Audio composition failed: ${event.data.message}`);
      }
    };
    worker.onerror = () => failure('Audio composition transport failed');
    deadline = setTimeout(() => failure('Composed audio did not become ready'), 10000);
    worker.postMessage({ kind: 'setup' });
    for (const [source, reader] of readers.entries()) void consume(reader, source);
    return { track: output, status, get diagnostics() { return parentFailure ? { ...diagnostics, parentFailure } : diagnostics; }, async start() { await ready; }, quiesce, close };
  } catch (error) { close(); throw error; }
}
