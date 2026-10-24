import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as compositionBuild from 'esbuild';
import * as compositionVM from 'node:vm';
import * as compositionURLs from 'node:url';
const compiled = await compositionBuild.build({ entryPoints: [compositionURLs.fileURLToPath(new URL('../src/capture/composition.worker.ts', import.meta.url))], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false });
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; }
function harness(mode, { writeFailure, drawFailure = false, snapshotFailure = false, immediate = false } = {}) {
  const messages = [], inputs = [], outputs = [], writes = [], gates = [], surfaces = [];
  let currentNow = 10;
  class Input {
    closed = 0; delivered = false;
    constructor(id, stamp, width = 640, height = 360) { this.id = id; this.stamp = stamp; this.w = width; this.h = height; inputs.push(this); }
    get timestamp() { assert.equal(this.closed, 0); return this.stamp; }
    get displayWidth() { assert.equal(this.closed, 0); return this.w; }
    get displayHeight() { assert.equal(this.closed, 0); return this.h; }
    close() { assert.equal(this.closed, 0, 'Input closed twice'); this.closed++; }
  }
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; this.ops = []; this.calls = []; surfaces.push(this); }
    getContext() { const canvas = this; return { fillStyle: '', fillRect(...values) { canvas.calls.push({ kind: 'fill', values }); canvas.ops = [{ fill: this.fillStyle, values }]; },
      drawImage(source, ...values) {
        if (source instanceof Input) { assert.equal(source.closed, 0, 'Draw consumed a closed input'); if (drawFailure) throw new Error('Controlled draw refusal'); }
        canvas.calls.push({ kind: 'draw', source, values });
        canvas.ops.push({ source: source.id ?? 'owned-raster', pixels: source.ops ? structuredClone(source.ops) : source.id, values });
      }, save() {}, beginPath() {}, arc(...values) { canvas.ops.push({ arc: values }); }, clip() {}, restore() {} }; }
  }
  class Output {
    closed = 0;
    constructor(canvas, options) { if (snapshotFailure) throw new Error('Controlled snapshot refusal'); this.timestamp = options.timestamp; this.pixels = structuredClone(canvas.ops); outputs.push(this); }
    close() { assert.equal(this.closed, 0, 'Output closed twice'); this.closed++; }
  }
  function source() {
    let waiting; const queued = [];
    const reader = { read() { if (queued.length) { const item = queued.shift(); if (item.value) item.value.delivered = true; return Promise.resolve(item); } return new Promise(resolve => { waiting = resolve; }); },
      push(value) { if (waiting) { const done = waiting; waiting = undefined; value.delivered = true; done({ value, done: false }); } else queued.push({ value, done: false }); },
      cancel() { for (const item of queued.splice(0)) item.value?.close(); if (waiting) { const done = waiting; waiting = undefined; done({ done: true }); } return Promise.resolve(); }, releaseLock() {} };
    return { reader, getReader: () => reader };
  }
  const screen = mode === 'camera' ? undefined : source(), camera = mode === 'screen' ? undefined : source();
  const writer = { write(frame) { writes.push({ frame, inputs: inputs.filter(value => value.delivered).map(value => ({ id: value.id, closed: value.closed })) }); if (writeFailure) return Promise.reject(writeFailure); if (immediate) return Promise.resolve(); const gate = deferred(); gates.push(gate); return gate.promise; }, close() { return Promise.resolve(); } };
  const sandbox = { OffscreenCanvas: Canvas, VideoFrame: Output, performance: { now: () => currentNow }, postMessage: value => messages.push(value) };
  compositionVM.runInNewContext(compiled.outputFiles[0].text, sandbox);
  sandbox.onmessage({ data: { kind: 'setup', screen, camera, output: { getWriter: () => writer }, width: 1280, height: 720, fps: 30, maxSeconds: 600, bubble: { x: 980, y: 500, size: 180 } } });
  return { screen, camera, messages, inputs, outputs, writes, gates, surfaces,
    input: (...args) => new Input(...args), send: data => sandbox.onmessage({ data }), now: value => { currentNow = value; },
    async close() { sandbox.onmessage({ data: { kind: 'stop' } }); gates.forEach(value => value.resolve()); await turn(); await turn(); } };
}
for (const mode of ['camera', 'screen']) test(`${mode} input closes before a blocked output write; ready waits for actual write acknowledgement`, async () => {
  const f = harness(mode), raw = f.input('driver', 123456789);
  try {
    (f.camera ?? f.screen).reader.push(raw); await turn();
    assert.equal(f.writes.length, 1); assert.equal(raw.closed, 1); assert.equal(f.writes[0].inputs[0].closed, 1);
    assert.equal(f.outputs[0].timestamp, 123456789); assert.equal(f.outputs[0].closed, 0); assert.equal(f.messages.some(value => value.kind === 'ready'), false);
    f.gates[0].resolve(); await turn(); assert.equal(f.outputs[0].closed, 1); assert.equal(f.messages.filter(value => value.kind === 'ready').length, 1);
  } finally { await f.close(); }
});
test('mixed screen background remains owned and both inputs close before output backpressure', async () => {
  const f = harness('mixed'), screen = f.input('screen-one', 1000000), camera = f.input('camera-one', 1000000);
  try {
    f.screen.reader.push(screen); await turn(); assert.equal(screen.closed, 1);
    f.camera.reader.push(camera); await turn(); assert.equal(camera.closed, 1); assert.equal(f.writes.length, 1);
    const snapshot = structuredClone(f.outputs[0].pixels), next = f.input('portrait-screen', 1033334, 360, 640);
    f.screen.reader.push(next); f.send({ kind: 'bubble', value: { x: 100, y: 100, size: 180 } }); await turn();
    assert.equal(next.closed, 1); assert.deepEqual(f.outputs[0].pixels, snapshot, 'Later cache or bubble mutation changed an owned output');
    f.gates[0].resolve(); await turn(); f.camera.reader.push(f.input('camera-two', 1033334)); await turn();
    const cached = f.outputs[1].pixels.find(value => value.source === 'owned-raster');
    const portrait = f.outputs[1].pixels.find(value => value.source === 'portrait-screen') ?? cached?.pixels.find(value => value.source === 'portrait-screen');
    assert.ok(portrait); assert.equal(f.outputs[1].pixels[0].fill, '#101820');
    assert.deepEqual(portrait.values, [437.5, 0, 405, 720]);
    const patchCopy = f.surfaces[1].ops.at(-1).values;
    if (patchCopy.length === 8) { assert.equal(patchCopy[2], patchCopy[6]); assert.equal(patchCopy[3], patchCopy[7]); }
    else assert.deepEqual(cached.values, [0, 0]);
    assert.deepEqual(f.outputs[1].pixels.filter(value => value.arc).at(-1)?.arc, [190, 190, 90, 0, Math.PI * 2]);
  } finally { await f.close(); }
});
test('pre-screen and cadence-rejected camera frames close without fabricated output', async () => {
  const f = harness('mixed', { immediate: true });
  try {
    const early = f.input('early-camera', 900000); f.camera.reader.push(early); await turn(); assert.equal(early.closed, 1); assert.equal(f.writes.length, 0);
    f.screen.reader.push(f.input('screen', 1000000)); await turn(); f.camera.reader.push(f.input('camera', 1000000)); await turn();
    const rejected = f.input('same-bucket', 1000001); f.camera.reader.push(rejected); await turn(); assert.equal(rejected.closed, 1); assert.equal(f.writes.length, 1);
  } finally { await f.close(); }
});
test('a read already resolved when Stop arrives closes its frame without emitting output', async () => {
  const f = harness('camera', { immediate: true }), raw = f.input('late', 1000000);
  try { f.camera.reader.push(raw); f.send({ kind: 'stop' }); await turn(); assert.equal(raw.closed, 1); assert.equal(f.writes.length, 0); }
  finally { await f.close(); }
});
for (const failure of ['draw', 'snapshot', 'write']) test(`${failure} refusal preserves the error and closes each input or owned output exactly once`, async () => {
  const f = harness('camera', { immediate: true, drawFailure: failure === 'draw', snapshotFailure: failure === 'snapshot', writeFailure: failure === 'write' ? new Error('Controlled write refusal') : undefined });
  const raw = f.input('driver', 1000000);
  try { f.camera.reader.push(raw); await turn(); await turn(); assert.equal(raw.closed, 1); assert.ok(f.messages.some(value => value.kind === 'error' && value.message.includes(`Controlled ${failure} refusal`))); assert.ok(f.outputs.every(value => value.closed === 1)); }
  finally { await f.close(); }
});

test('mixed camera updates avoid full-output repaint and full-cache copy while a static screen stays live', async () => {
  const f = harness('mixed', { immediate: true });
  try {
    f.screen.reader.push(f.input('static-screen', 1000000)); await turn();
    for (let index = 0; index < 4; index++) { f.camera.reader.push(f.input('live-camera-' + index, 1000000 + index * 33334)); await turn(); }
    assert.equal(f.outputs.length, 4); assert.ok(f.inputs.every(frame => frame.closed === 1));
    const fullFills = f.surfaces[0].calls.filter(call => call.kind === 'fill' && call.values.join(',') === '0,0,1280,720');
    assert.equal(fullFills.length, 1, 'Only a new screen paints the full background');
    const fullCopies = f.surfaces[0].calls.filter(call => call.kind === 'draw' && call.source?.width === 1280 && call.source?.height === 720 && call.values.join(',') === '0,0');
    assert.equal(fullCopies.length, 0, 'An accepted mixed camera frame must not copy a full cached raster');
  } finally { await f.close(); }
});
test('fractional clipped and moving bubble patches stay bounded and copy pixels without scaling', async () => {
  const f = harness('mixed', { immediate: true });
  try {
    f.screen.reader.push(f.input('screen', 1000000)); await turn();
    for (const [index, value] of [{ x: -30.25, y: -20.5, size: 180.75 }, { x: 1210.5, y: 680.25, size: 200.5 }, { x: 90.5, y: 80.25, size: 100.25 }].entries()) {
      f.send({ kind: 'bubble', value }); f.camera.reader.push(f.input('camera-' + index, 1000000 + index * 33334)); await turn();
    }
    const captures = f.surfaces[1].calls.filter(call => call.kind === 'draw'); assert.equal(captures.length, 3);
    for (const { values: box } of captures) {
      assert.ok(Number.isInteger(box[0]) && Number.isInteger(box[1]) && box[0] >= 0 && box[1] >= 0);
      assert.ok(box[0] + box[2] <= 1280 && box[1] + box[3] <= 720);
      assert.equal(box[2], box[6]); assert.equal(box[3], box[7]);
    }
  } finally { await f.close(); }
});
