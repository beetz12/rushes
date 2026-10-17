import type { AudioTransformAPIs, PCMFrame } from './audio-frame';
import { MIX_FRAMES, MIX_RATE, stereoPlanes } from './pcm-mixer';
// Endpoints stay in this Window: Chrome changes reference origins on stream transfer.
// Only copied PCM crosses the worker boundary. Originals belong to the coordinator.
export function composedAudio(tracks: MediaStreamTrack[], failed: (message: string) => void = () => undefined): {
  track?: MediaStreamTrack; readonly diagnostics?: unknown; start(): Promise<void>; close(): void;
} {
  if (!tracks.length) return { async start() {}, close() {} };
  if (tracks.length === 1) {
    const track = tracks[0].clone();
    return { track, async start() {}, close() { track.stop(); } };
  }
  if (tracks.length !== 2) throw new Error('Composition accepts at most two audio inputs');
  const apis = globalThis as unknown as AudioTransformAPIs;
  if (!apis.AudioData || !apis.MediaStreamTrackProcessor || !apis.MediaStreamTrackGenerator)
    throw new Error('This Chrome version cannot preserve composed audio references');
  const owned: MediaStreamTrack[] = [], readers: ReadableStreamDefaultReader<PCMFrame>[] = [];
  const pendingFrames = [0, 0];
  let output: InstanceType<AudioTransformAPIs['MediaStreamTrackGenerator']> | undefined, worker: Worker | undefined;
  let writer: WritableStreamDefaultWriter<PCMFrame> | undefined;
  let closed = false, writing = false, diagnostics: unknown, deadline: ReturnType<typeof setTimeout> | undefined;
  let readyResolve: () => void, readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => undefined);
  function close() {
    if (closed) return; closed = true;
    readyReject(new Error('Composed audio was closed')); clearTimeout(deadline);
    owned.forEach(track => track.stop()); output?.stop();
    for (const reader of readers) void Promise.resolve().then(() => reader.cancel()).finally(() => reader.releaseLock()).catch(() => undefined);
    if (writer) void writer.abort().finally(() => writer?.releaseLock()).catch(() => undefined);
    if (worker) {
      worker.postMessage({ kind: 'stop' });
      deadline = setTimeout(() => worker?.terminate(), 500);
    }
  }
  function failure(message: string) { if (!closed) { readyReject(new Error(message)); try { failed(message); } finally { close(); } } }
  async function consume(reader: ReadableStreamDefaultReader<PCMFrame>, source: number) {
    try {
      while (!closed) {
        const item = await reader.read();
        if (item.done) { if (!closed) throw new Error('A composed audio source ended'); break; }
        const frame = item.value;
        try {
          if (closed) continue;
          if (![1, 2, 4, 6].includes(frame.numberOfChannels) || frame.numberOfFrames > frame.sampleRate / 4)
            throw new Error('Unsupported composed audio packet');
          const channels = Array.from({ length: frame.numberOfChannels }, (_, planeIndex) => {
            const data = new Float32Array(frame.numberOfFrames); frame.copyTo(data, { planeIndex, format: 'f32-planar' }); return data;
          });
          let [left, right] = stereoPlanes(channels);
          // Mono shares a plane until this boundary; transfer each buffer only once.
          if (left === right) right = right.slice();
          pendingFrames[source] += frame.numberOfFrames;
          if (pendingFrames[source] > frame.sampleRate / 4) throw new Error('Audio worker queue exceeded250ms');
          worker!.postMessage({ kind: 'input', source, rate: frame.sampleRate, timestamp: frame.timestamp, left, right }, [left.buffer, right.buffer]);
        } finally { frame.close(); }
      }
    } catch (error) { failure(`Audio composition failed: ${String(error)}`); }
    finally { reader.releaseLock(); }
  }
  async function write(sequence: number, timestamp: number, data: Float32Array) {
    let frame: PCMFrame | undefined, writeDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (writing) throw new Error('Audio output exceeded one pending packet'); writing = true;
      frame = new apis.AudioData({ format: 'f32-planar', sampleRate: MIX_RATE, numberOfChannels: 2,
        numberOfFrames: MIX_FRAMES, timestamp, data });
      await Promise.race([writer!.write(frame), new Promise<never>((_, reject) => {
        writeDeadline = setTimeout(() => reject(new Error('Composed audio sink timed out')), 1000);
      })]);
      if (!closed) worker!.postMessage({ kind: 'written', sequence });
    } catch (error) { failure(`Audio composition failed: ${String(error)}`); }
    finally { clearTimeout(writeDeadline); frame?.close(); writing = false; }
  }
  try {
    for (const track of tracks) {
      const clone = track.clone(); owned.push(clone);
      readers.push(new apis.MediaStreamTrackProcessor({ track: clone, maxBufferSize: 25 }).readable.getReader());
    }
    output = new apis.MediaStreamTrackGenerator({ kind: 'audio' }); writer = output.writable.getWriter();
    worker = new Worker(new URL('./audio.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = event => {
      if (event.data.kind === 'stopped') { clearTimeout(deadline); worker?.terminate(); }
      else if (event.data.kind === 'timing') diagnostics = event.data.diagnostics;
      else if (closed) return;
      else if (event.data.kind === 'consumed') pendingFrames[event.data.source] -= event.data.frames;
      else if (event.data.kind === 'packet') void write(event.data.sequence, event.data.timestamp, event.data.data);
      else if (event.data.kind === 'ready') { clearTimeout(deadline); readyResolve(); }
      else if (event.data.kind === 'error') failure(`Audio composition failed: ${event.data.message}`);
    };
    worker.onerror = () => failure('Audio composition worker failed');
    deadline = setTimeout(() => failure('Composed audio did not become ready'), 10000);
    worker.postMessage({ kind: 'setup' });
    for (const [source, reader] of readers.entries()) void consume(reader, source);
    return { track: output, get diagnostics() { return diagnostics; }, async start() { await ready; }, close };
  } catch (error) { close(); throw error; }
}
