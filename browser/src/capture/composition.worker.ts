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
let latestScreen: VideoFrame | undefined;
const readers: ReadableStreamDefaultReader<VideoFrame>[] = [];
let writer: WritableStreamDefaultWriter<VideoFrame>;
let frameCount = 0;
let lastReport = 0;
const send = (kind: string, message?: string) => endpoint.postMessage({ kind, message, frameCount });
function drawFit(context: OffscreenCanvasRenderingContext2D, frame: VideoFrame, x: number, y: number, width: number, height: number, cover = false) {
  const scale = (cover ? Math.max : Math.min)(width / frame.displayWidth, height / frame.displayHeight);
  const drawnWidth = frame.displayWidth * scale, drawnHeight = frame.displayHeight * scale;
  context.drawImage(frame, x + (width - drawnWidth) / 2, y + (height - drawnHeight) / 2, drawnWidth, drawnHeight);
}
async function compose(setup: Setup) {
  const canvas = new OffscreenCanvas(setup.width, setup.height);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('The browser could not initialize composition.');
  writer = setup.output.getWriter();
  const admit = createFrameCadence(setup.fps);
  const render = async (driver: VideoFrame) => {
    if (!admit(driver.timestamp)) return;
    const now = performance.now();
    if (begun && !pausedAt && now - begun - pausedTime >= setup.maxSeconds * 1000) { send('limit'); begun = 0; }
    context.fillStyle = '#101820'; context.fillRect(0, 0, setup.width, setup.height);
    if (setup.screen && latestScreen) drawFit(context, latestScreen, 0, 0, setup.width, setup.height);
    else if (!setup.screen) drawFit(context, driver, 0, 0, setup.width, setup.height);
    if (setup.screen && setup.camera) {
      const size = placement.size;
      const x = placement.x, y = placement.y;
      context.save(); context.beginPath(); context.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2); context.clip();
      drawFit(context, driver, x, y, size, size, true); context.restore();
    }
    const frame = new VideoFrame(canvas, { timestamp: driver.timestamp });
    try { await writer.write(frame); } finally { frame.close(); }
    frameCount++;
    if (now - lastReport > 1000) { send('progress'); lastReport = now; }
  };
  async function consume(stream: ReadableStream<VideoFrame>, isScreen: boolean, driving: boolean) {
    const reader = stream.getReader(); readers.push(reader);
    try {
      while (!ending) {
        const item = await reader.read();
        if (item.done) { if (!ending) send('source-ended'); break; }
        const frame = item.value;
        if (isScreen) {
          latestScreen?.close(); latestScreen = frame;
          if (driving) await render(frame);
        } else {
          try { if (!setup.screen || latestScreen) await render(frame); } finally { frame.close(); }
        }
      }
    } finally { reader.releaseLock(); }
  }
  send('ready');
  const jobs: Promise<void>[] = [];
  if (setup.screen) jobs.push(consume(setup.screen, true, !setup.camera));
  if (setup.camera) jobs.push(consume(setup.camera, false, true));
  try { await Promise.all(jobs); }
  finally {
    latestScreen?.close(); latestScreen = undefined;
    await writer.close().catch(() => undefined); send('stopped');
  }
}
endpoint.onmessage = event => {
  const message = event.data;
  if (message.kind === 'setup') { placement = message.bubble; void compose(message).catch(error => send('error', String(error))); }
  else if (message.kind === 'bubble') placement = message.value;
  else if (message.kind === 'start') { begun = performance.now(); pausedTime = 0; pausedAt = 0; }
  else if (message.kind === 'pause' && !pausedAt) pausedAt = performance.now();
  else if (message.kind === 'resume' && pausedAt) { pausedTime += performance.now() - pausedAt; pausedAt = 0; }
  else if (message.kind === 'stop') { ending = true; for (const reader of readers) void reader.cancel().catch(() => undefined); }
};
