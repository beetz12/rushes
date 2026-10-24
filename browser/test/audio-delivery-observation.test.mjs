import { generatedAudioWorkerObserver } from './generated-audio-worker.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeliveryObserver, readDeliveryRow, deliveryClockBracket } from './audio-delivery-observation.mjs';
import { prepareMatrix } from './matrix-fixture.mjs';
function pair() {
  let tick = 1; const observer = createDeliveryObserver('generated-take', () => [1000, tick++]);
  const message = { kind: 'input', source: 0, left: new Float32Array(480), right: new Float32Array(480) };
  const token = observer.prepare(message); structuredClone(message, { transfer: [message.left.buffer, message.right.buffer] }); observer.sent(token);
  const response = { kind: 'consumed', source: 0, frames: 480, generatedDelivery: { version: 1, takeId: 'generated-take', kind: 'consumed', ordinal: 1, entered: [2000, 2], posted: [2000, 3] } };
  return { observer, response, message };
}
test('successful input send metadata survives actual transfer detaching the PCM buffers', () => {
  const f = pair(); assert.equal(f.message.left.length, 0);
  const row = f.observer.receive(f.response); assert.equal(row.matched, true); assert.equal(row.frames, 480); assert.equal(row.ordinal, 1); assert.equal(f.observer.state.invalid, 0);
  assert.deepEqual(deliveryClockBracket(row), { minimumOffsetMs: -1001, maximumOffsetMs: -1000 });
});
test('wrong take, role, extra metadata and malformed clocks cannot become latency evidence', () => {
  for (const change of [{ takeId: 'other' }, { kind: 'ready' }, { payload: [1, 2] }, { posted: [NaN, 1] }]) {
    const f = pair(); Object.assign(f.response.generatedDelivery, change);
    assert.equal(f.observer.receive(f.response), undefined); assert.equal(f.observer.state.invalid, 1);
  }
});
test('unmatched FIFO acknowledgement remains explicitly unpaired rather than fabricating a send time', () => {
  const f = pair(); f.response.generatedDelivery.ordinal = 2;
  const row = f.observer.receive(f.response); assert.equal(row.matched, false); assert.equal(row.sentBefore, null); assert.equal(deliveryClockBracket(row), undefined); assert.equal(f.observer.state.sequenceErrors, 1);
});
test('rejected observer clocks are counted without throwing into the actual message sender', () => {
  const observer = createDeliveryObserver('generated-take', () => { throw new Error('Controlled clock refusal'); });
  const token = observer.prepare({ kind: 'input', source: 0, left: new Float32Array(480) }); assert.doesNotThrow(() => observer.sent(token)); assert.equal(observer.state.invalid, 2);
});
test('timing observation is rejected before any media in ordinary or witness-free preparations', async () => {
  for (const options of [{ audioTimingObservation: true }, { audioTimingObservation: true, startupObservation: false, sourceMode: 'container' },
    { audioTimingObservation: true, startupObservation: true, sourceMode: 'native-reference', referenceWitness: false }])
    await assert.rejects(prepareMatrix(options), /delivery timing/);
});

test('ordinary Worker URL stays exact while the supervised wrapper needs an actual metadata receipt', () => {
  class Endpoint extends EventTarget { constructor(...args) { super(); this.arguments = args; } postMessage() {} }
  const url = 'http://generated.invalid/src/capture/audio.worker.ts?worker_file&type=module', options = { type: 'module' };
  for (const audioTiming of [false, true]) {
    const metrics = { observerErrors: [] }, owner = generatedAudioWorkerObserver({ NativeWorker: Endpoint, metrics, baseURL: 'http://generated.invalid/',
      getTakeId: () => 'generated-take', getFailureAt: () => undefined, startup() {}, audioTiming });
    const worker = new owner.Worker(url, options); assert.equal(worker.arguments[1], options);
    if (!audioTiming) { assert.equal(worker.arguments[0], url); assert.equal(metrics.audioDeliveryIdentity, undefined); assert.equal(Object.hasOwn(owner.Worker.prototype, 'postMessage'), false); }
    else {
      assert.ok(worker.arguments[0].pathname.endsWith('/observed-audio.worker.mjs'));
      assert.equal(worker.arguments[0].searchParams.get('takeId'), 'generated-take'); assert.equal(metrics.audioDeliveryIdentity.metadataObserved, false);
      worker.dispatchEvent(new MessageEvent('message', { data: { kind: 'ready', generatedDelivery: { version: 1, takeId: 'generated-take', kind: 'ready', ordinal: null, entered: null, posted: [2000, 2] } } }));
      assert.equal(metrics.audioDeliveryIdentity.metadataObserved, true);
    }
  }
});
test('diagnostic records and pending send history are bounded and old receipts stay explicitly unpaired', () => {
  let tick = 1; const observer = createDeliveryObserver('generated-take', () => [1000, tick++]);
  for (let index = 0; index < 130; index++) observer.sent(observer.prepare({ kind: 'input', source: 0, left: new Float32Array(480) }));
  for (let ordinal = 1; ordinal <= 130; ordinal++) observer.receive({ kind: 'consumed', source: 0, frames: 480, generatedDelivery: { version: 1, takeId: 'generated-take', kind: 'consumed', ordinal, entered: [2000, ordinal], posted: [2000, ordinal + .1] } });
  assert.equal(observer.state.rows.length, 128); assert.equal(observer.state.dropped, 2); assert.equal(observer.state.unpaired, 66); assert.equal(observer.state.invalid, 0);
});

test('a refused native send retains its original error and cannot create a matched timing receipt', () => {
  const refused = new Error('Controlled native post refusal');
  class Endpoint extends EventTarget { postMessage() { throw refused; } }
  const metrics = { observerErrors: [] }, observer = generatedAudioWorkerObserver({ NativeWorker: Endpoint, metrics,
    baseURL: 'http://generated.invalid/', getTakeId: () => 'generated-take', getFailureAt: () => undefined, startup() {}, audioTiming: true });
  const worker = new observer.Worker('http://generated.invalid/src/capture/audio.worker.ts', { type: 'module' });
  assert.throws(() => worker.postMessage({ kind: 'input', source: 0, left: new Float32Array(480) }), error => error === refused);
  worker.dispatchEvent(new MessageEvent('message', { data: { kind: 'consumed', source: 0, frames: 480,
    generatedDelivery: { version: 1, takeId: 'generated-take', kind: 'consumed', ordinal: 1, entered: [2000, 1], posted: [2000, 2] } } }));
  assert.equal(metrics.audioDelivery.rows[0].matched, false); assert.equal(metrics.audioDelivery.unpaired, 1);
});

test('a foreign or credentialed same-path URL reaches the native constructor unchanged and preserves refusal', () => {
  const refused = new Error('Controlled native Worker URL refusal');
  class Endpoint extends EventTarget { constructor(url) { super(); assert.ok(String(url).includes('foreign.invalid') || String(url).includes('user:pass@')); throw refused; } }
  for (const url of ['https://foreign.invalid/src/capture/audio.worker.ts', 'http://user:pass@generated.invalid/src/capture/audio.worker.ts']) {
    const metrics = { observerErrors: [] }, observer = generatedAudioWorkerObserver({ NativeWorker: Endpoint, metrics,
      baseURL: 'http://generated.invalid/', getTakeId: () => 'generated-take', getFailureAt: () => undefined, startup() {}, audioTiming: true });
    assert.throws(() => new observer.Worker(url, { type: 'module' }), error => error === refused);
    assert.equal(metrics.audioWorkerIdentity, undefined); assert.equal(metrics.audioDeliveryIdentity, undefined);
  }
});
