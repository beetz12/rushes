import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { copyOpticalRegion } from './native-optical-roi.mjs';
const workerSource = await readFile(new URL('./matrix-source.worker.mjs', import.meta.url), 'utf8');
const source = workerSource.replace("import { copyOpticalRegion } from './native-optical-roi.mjs';", '');
assert.notEqual(source, workerSource);

async function observer(timestamps = [123000], beforeCopy) {
  const events = [], submitted = [];
  let pending, released = false;
  const port = { postMessage(value) { submitted.push(value); } };
  let at = 0, closed = 0;
  const frame = timestamp => ({ timestamp, format: 'NV12', codedWidth: 1280, codedHeight: 720,
    displayWidth: 1280, displayHeight: 720, visibleRect: { x: 0, y: 0, width: 1280, height: 720 },
    allocationSize() { return 12288; }, async copyTo(bytes) {
      await beforeCopy?.(timestamp); bytes.fill(0); bytes[16 * 256 + 8] = 235; return [{ offset: 0, stride: 256 }];
    },
    close() { closed++; } });
  const reader = { async read() {
    if (at < timestamps.length) return { value: frame(timestamps[at++]), done: false };
    return new Promise(resolve => { pending = resolve; });
  }, async cancel() { pending?.({ done: true }); }, releaseLock() { released = true; } };
  const sandbox = { performance, setTimeout, clearTimeout, copyOpticalRegion,
    postMessage(value) { events.push(value); } };
  vm.runInNewContext(source, sandbox);
  const running = sandbox.onmessage({ data: { input: { getReader() { return reader; } }, audioPort: port } });
  await new Promise(resolve => setImmediate(resolve));
  return { events, submitted, running, released: () => released, closed: () => closed,
    stop: stopAtTimestampUs => sandbox.onmessage({ data: { kind: 'stop', stopAtTimestampUs } }),
    push(timestamp) { const resolve = pending; pending = undefined; resolve({ value: frame(timestamp), done: false }); },
    end() { const resolve = pending; pending = undefined; resolve({ done: true }); },
    emit(value = submitted.at(-1)) { port.onmessage({ data: { measurement: 'emission', ...value } }); } };
}
test('retirement waits for the actual last emission and forwards it before stopped', async () => {
  const value = await observer();
  const stopping = value.stop(); await value.running;
  assert.equal(value.released(), true); assert.equal(value.events.some(event => event.kind === 'stopped'), false);
  value.emit(); await stopping;
  assert.deepEqual(value.events.map(event => event.kind), ['input-anchor', 'ready', 'audio-anchor', 'stopped']);
  assert.equal(value.events.at(-1).finalEmission.sourceTimestampUs, 123000);
});
test('an already received matching emission closes without manufacturing another', async () => {
  const value = await observer(); value.emit(); await value.stop(); await value.running;
  assert.equal(value.events.filter(event => event.kind === 'audio-anchor').length, 1);
  assert.equal(value.events.at(-1).kind, 'stopped');
});
test('missing or wrong final emission fails closed within its retirement budget', async () => {
  const value = await observer(); value.emit({ ordinal: 0, sourceTimestampUs: 120000 });
  await value.stop(); await value.running;
  assert.equal(value.events.some(event => event.kind === 'stopped'), false);
  assert.match(value.events.at(-1).message, /Final source emission receipt did not arrive/);
  assert.equal(value.released(), true);
});
test('gap diagnostics remain bounded while retaining the actual maximum and closing every observed frame', async () => {
  const timestamps = Array.from({ length: 71 }, (_, index) => 123000 + index * 300000);
  const value = await observer(timestamps); value.emit(); await value.stop(); await value.running;
  const optical = value.events.at(-1).optical;
  assert.equal(optical.count, 71); assert.equal(optical.maxTimestampGapUs, 300000);
  assert.equal(optical.diagnostics.gaps.length, 64); assert.equal(optical.diagnostics.omittedGaps, 6);
  assert.equal(optical.diagnostics.gaps[0].previousTimestamp, timestamps[0]);
  assert.equal(optical.diagnostics.gaps[0].timestamp, timestamps[1]);
  assert.ok(optical.diagnostics.gaps.every(gap => gap.readWaitMs >= 0 && gap.readbackMs >= 0
    && gap.readCompletedMs >= gap.readStartedMs && gap.observationTimeOrigin === performance.timeOrigin));
  assert.equal(value.closed(), timestamps.length); assert.equal(value.released(), true);
});

test('native Stop drains queued frames through its boundary without admitting a later frame', async () => {
  const value = await observer(); value.emit();
  const stopped = value.stop(170000);
  value.push(150000); await new Promise(resolve => setImmediate(resolve));
  value.push(200000); await stopped; await value.running;
  const receipt = value.events.at(-1);
  assert.equal(receipt.kind, 'stopped'); assert.equal(receipt.optical.count, 2);
  assert.equal(receipt.optical.lastTimestamp, 150000); assert.equal(receipt.optical.maxTimestampGapUs, 27000);
  assert.equal(receipt.boundary.cutoffUs, 170000); assert.equal(receipt.boundary.crossingTimestampUs, 200000);
  assert.equal(value.closed(), 3); assert.equal(value.submitted.length, 1);
  assert.equal(value.released(), true);
});

test('EOF and already admitted later frames cannot stand in for a native Stop crossing', async () => {
  const ended = await observer(); ended.emit(); const stopping = ended.stop(170000); ended.end(); await stopping;
  assert.equal(ended.events.some(event => event.kind === 'stopped'), false);
  assert.match(ended.events.at(-1).message, /lacks a crossing/);
  const late = await observer([123000, 200000]); late.emit(); await late.stop(170000);
  assert.equal(late.events.some(event => event.kind === 'stopped'), false);
  assert.match(late.events.at(-1).message, /already exceeded/);
});

test('a stalled live source cannot silently pass the native Stop drain fence', async () => {
  const value = await observer(); value.emit(); await value.stop(170000); await value.running;
  assert.equal(value.events.some(event => event.kind === 'stopped'), false);
  assert.match(value.events.at(-1).message, /Stop boundary.*250ms/);
  assert.equal(value.closed(), 1); assert.equal(value.released(), true);
});

test('Stop arriving during native ROI copy excludes the in-flight later frame', async () => {
  const gate = Promise.withResolvers();
  const value = await observer([123000, 200000], timestamp => timestamp === 200000 ? gate.promise : undefined);
  value.emit(); const stopping = value.stop(170000); gate.resolve(); await stopping; await value.running;
  const receipt = value.events.at(-1);
  assert.equal(receipt.kind, 'stopped'); assert.equal(receipt.optical.lastTimestamp, 123000);
  assert.equal(receipt.optical.count, 1); assert.equal(receipt.boundary.crossingTimestampUs, 200000);
  assert.equal(value.closed(), 2); assert.equal(value.submitted.length, 1);
});
