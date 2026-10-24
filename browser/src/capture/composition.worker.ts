import type { BubblePlacement } from '../contracts';
import { createFrameCadence } from './cadence';

type Setup = { kind: 'setup'; screen?: ReadableStream<VideoFrame>; camera?: ReadableStream<VideoFrame>;
  output: WritableStream<VideoFrame>; width: number; height: number; fps: number; maxSeconds: number; bubble: BubblePlacement };
type Control = { kind: 'bubble'; value: BubblePlacement } | { kind: 'stop' | 'start' | 'pause' | 'resume' };
const endpoint = globalThis as unknown as { onmessage: ((event: MessageEvent<Setup | Control>) => void) | null;
  postMessage(value: unknown): void };
let placement: BubblePlacement;
let ending = false;
let begun = 0;
let pausedAt = 0;
let pausedTime = 0;
const readers: ReadableStreamDefaultReader<VideoFrame>[] = [];
let writer: WritableStreamDefaultWriter<VideoFrame>;
let frameCount = 0;
let lastReport = 0;
// Fixed-size local wall observations. No media clock or native-consumer ACK.
const spanNames = ['read-screen', 'read-camera', 'cache', 'raster', 'construct', 'write-call', 'write-wait', 'lease-screen', 'lease-camera'] as const;
const spanPhases = ['preroll', 'start-control', 'paused', 'ending', 'mixed'] as const;
type SpanName = typeof spanNames[number];
type SpanPhase = typeof spanPhases[number];
type Span = { name: SpanName; phase: SpanPhase; epoch: number; at: number };
let spanPhase: SpanPhase = 'preroll', spanEpoch = 0, invalidSpans = 0;
const spanRows = Object.fromEntries(spanPhases.map(phase => [phase,
  Object.fromEntries(spanNames.map(name => [name, { count: 0, totalMs: 0, maxMs: 0 }]))])) as Record<SpanPhase, Record<SpanName, { count: number; totalMs: number; maxMs: number }>>;
const pendingSpans: Partial<Record<SpanName, Span>> = {};
const sourceCounts = { screen: 0, camera: 0, admitted: 0, rejected: 0, notReady: 0 };
const enterSpan = (name: SpanName): Span => {
  const span = { name, phase: spanPhase, epoch: spanEpoch, at: performance.now() }; pendingSpans[name] = span; return span;
};
const leaveSpan = (span: Span) => {
  const elapsed = performance.now() - span.at;
  if (pendingSpans[span.name] === span) delete pendingSpans[span.name]; else invalidSpans++;
  if (!Number.isFinite(elapsed) || elapsed < 0) { invalidSpans++; return; }
  const row = spanRows[span.epoch === spanEpoch && span.phase === spanPhase ? span.phase : 'mixed'][span.name];
  row.count++; row.totalMs += elapsed; row.maxMs = Math.max(row.maxMs, elapsed);
};
const spanSnapshot = () => {
  const at = performance.now();
  return { schema: 'rushes.composition-local-spans/1', phase: spanPhase, epoch: spanEpoch, invalid: invalidSpans,
    counts: { ...sourceCounts }, rows: spanRows,
    pending: spanNames.flatMap(name => {
      const span = pendingSpans[name]; if (!span) return [];
      const age = at - span.at; return [{ name, phase: span.phase, epoch: span.epoch, ageMs: Number.isFinite(age) && age >= 0 ? age : null }];
    }), scope: 'Worker-local wall intervals; start-control is not native-ready; write-wait is not encoder ACK' };
};
const send = (kind: string, message?: string) => endpoint.postMessage({ kind, message, frameCount,
  ...(['ready', 'progress', 'error', 'stopped'].includes(kind) ? { compositionSpans: spanSnapshot() } : {}) });
function drawFit(context: OffscreenCanvasRenderingContext2D, frame: VideoFrame, x: number, y: number, width: number, height: number, cover = false) {
  const scale = (cover ? Math.max : Math.min)(width / frame.displayWidth, height / frame.displayHeight);
  const drawnWidth = frame.displayWidth * scale, drawnHeight = frame.displayHeight * scale;
  context.drawImage(frame, x + (width - drawnWidth) / 2, y + (height - drawnHeight) / 2, drawnWidth, drawnHeight);
}
async function compose(setup: Setup) {
  const canvas = new OffscreenCanvas(setup.width, setup.height);
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!context) throw new Error('The browser could not initialize composition.');
  const mixed = !!(setup.screen && setup.camera);
  const backgroundPatch = mixed ? new OffscreenCanvas(1, 1) : undefined;
  const patchDrawing = backgroundPatch?.getContext('2d', { alpha: false, willReadFrequently: true });
  if (backgroundPatch && !patchDrawing) throw new Error('The browser could not initialize screen composition.');
  type PixelBox = { x: number; y: number; width: number; height: number };
  let savedBox: PixelBox | undefined, screenReady = false;
  const bubblePixels = (): PixelBox => {
    const leftEdge = Math.max(0, Math.floor(placement.x) - 1), upperEdge = Math.max(0, Math.floor(placement.y) - 1);
    const rightEdge = Math.min(setup.width, Math.ceil(placement.x + placement.size) + 1);
    const lowerEdge = Math.min(setup.height, Math.ceil(placement.y + placement.size) + 1);
    return { x: leftEdge, y: upperEdge, width: Math.max(0, rightEdge - leftEdge), height: Math.max(0, lowerEdge - upperEdge) };
  };
  const resizePatch = (box: PixelBox) => {
    if (backgroundPatch!.width !== box.width) backgroundPatch!.width = box.width;
    if (backgroundPatch!.height !== box.height) backgroundPatch!.height = box.height;
  };
  const restorePatch = () => {
    if (savedBox) context.drawImage(backgroundPatch!, savedBox.x, savedBox.y);
    savedBox = undefined;
  };
  const capturePatch = (box: PixelBox) => {
    if (!box.width || !box.height) return;
    resizePatch(box);
    patchDrawing!.drawImage(canvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
    savedBox = box;
  };
  writer = setup.output.getWriter();
  const admit = createFrameCadence(setup.fps);
  const snapshot = (driver: VideoFrame) => {
    const timestamp = driver.timestamp;
    if (!admit(timestamp)) { sourceCounts.rejected++; return; }
    sourceCounts.admitted++;
    const now = performance.now();
    if (begun && !pausedAt && now - begun - pausedTime >= setup.maxSeconds * 1000) { send('limit'); begun = 0; }
    const raster = enterSpan('raster');
    try {
    if (mixed) {
      const box = bubblePixels();
      restorePatch(); capturePatch(box);
    } else {
      context.fillStyle = '#101820'; context.fillRect(0, 0, setup.width, setup.height);
      drawFit(context, driver, 0, 0, setup.width, setup.height);
    }
    if (mixed) {
      const size = placement.size;
      const x = placement.x, y = placement.y;
      context.save(); context.beginPath(); context.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2); context.clip();
      drawFit(context, driver, x, y, size, size, true); context.restore();
    }
    } finally { leaveSpan(raster); }
    const constructing = enterSpan('construct');
    try { return { frame: new VideoFrame(canvas, { timestamp }), now }; }
    finally { leaveSpan(constructing); }
  };
  const write = async (frame: VideoFrame, now: number) => {
    try {
      const calling = enterSpan('write-call'); let completion: Promise<void>;
      try { completion = writer.write(frame); } finally { leaveSpan(calling); }
      const waiting = enterSpan('write-wait');
      try { await completion; } finally { leaveSpan(waiting); }
    } finally { frame.close(); }
    frameCount++;
    if (frameCount === 1) send('ready');
    if (now - lastReport > 1000) { send('progress'); lastReport = now; }
  };
  async function consume(stream: ReadableStream<VideoFrame>, isScreen: boolean, driving: boolean) {
    const reader = stream.getReader(); readers.push(reader);
    try {
      while (!ending) {
        const reading = enterSpan(isScreen ? 'read-screen' : 'read-camera');
        let item: ReadableStreamReadResult<VideoFrame>;
        try { item = await reader.read(); } finally { leaveSpan(reading); }
        if (item.done) { if (!ending) send('source-ended'); break; }
        const frame = item.value; sourceCounts[isScreen ? 'screen' : 'camera']++;
        const leased = enterSpan(isScreen ? 'lease-screen' : 'lease-camera');
        let output: ReturnType<typeof snapshot>;
        try {
          if (ending) continue;
          if (isScreen && !driving) {
            const caching = enterSpan('cache');
            try {
              context!.fillStyle = '#101820'; context!.fillRect(0, 0, setup.width, setup.height);
              drawFit(context!, frame, 0, 0, setup.width, setup.height); screenReady = true;
              savedBox = undefined;
            } finally { leaveSpan(caching); }
          } else if (!mixed || screenReady) output = snapshot(frame);
          else sourceCounts.notReady++;
        } finally { try { frame.close(); } finally { leaveSpan(leased); } }
        // The output owns its canvas snapshot; source leases end before backpressure.
        if (output) await write(output.frame, output.now);
      }
    } finally { reader.releaseLock(); }
  }
  const jobs: Promise<void>[] = [];
  if (setup.screen) jobs.push(consume(setup.screen, true, !setup.camera));
  if (setup.camera) jobs.push(consume(setup.camera, false, true));
  try { await Promise.all(jobs); }
  finally {
    await writer.close().catch(() => undefined); send('stopped');
  }
}

endpoint.onmessage = event => {
  const message = event.data;
  if (message.kind === 'setup') { spanEpoch++; placement = message.bubble; void compose(message).catch(error => send('error', String(error))); }
  else if (message.kind === 'bubble') placement = message.value;
  else if (message.kind === 'start') { spanEpoch++; spanPhase = 'start-control'; begun = performance.now(); pausedTime = 0; pausedAt = 0; }
  else if (message.kind === 'pause' && !pausedAt) { spanEpoch++; spanPhase = 'paused'; pausedAt = performance.now(); }
  else if (message.kind === 'resume' && pausedAt) { spanEpoch++; spanPhase = 'start-control'; pausedTime += performance.now() - pausedAt; pausedAt = 0; }
  else if (message.kind === 'stop') { spanEpoch++; spanPhase = 'ending'; ending = true; for (const reader of readers) void reader.cancel().catch(() => undefined); }
};
