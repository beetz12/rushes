import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeReferenceWitness } from './native-reference-witness.mjs';

async function withObserverFailure(body, readFailure, fileFailure) {
  const originalProcessor = globalThis.MediaStreamTrackProcessor;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'storage');
  let stopped = false, closed = false, written = 0, canceled = false;
  const sink = { async write(data) { written += data.byteLength; }, async close() { closed = true; }, async abort() { closed = true; } };
  const handle = { async createWritable() { return sink; }, async getFile() {
    if (fileFailure) throw new Error('observed file read failed'); return { size: written };
  } };
  const directory = { async getDirectoryHandle() { return directory; }, async getFileHandle() { return handle; } };
  Object.defineProperty(globalThis.navigator, 'storage', { configurable: true, value: { async getDirectory() { return directory; } } });
  globalThis.MediaStreamTrackProcessor = class {
    constructor() { if (readFailure === 'setup') throw new Error('processor setup failed'); this.readable = new ReadableStream({ start(controller) {
      if (typeof readFailure === 'function') readFailure(controller, () => canceled);
      else if (readFailure) controller.error(new Error('observed reader failed')); else controller.close();
    }, cancel() { canceled = true; } }); }
  };
  try {
    await body({ track: { clone() { return { stop() { stopped = true; } }; } },
      clock: { converter: { qualified: true }, timeOrigin: performance.timeOrigin },
      state: () => ({ stopped, closed }) });
  } finally {
    globalThis.MediaStreamTrackProcessor = originalProcessor;
    if (descriptor) Object.defineProperty(globalThis.navigator, 'storage', descriptor); else delete globalThis.navigator.storage;
  }
}

test('an already failed and released reference reader still closes its track and sink', async () => {
  await withObserverFailure(async ({ track, clock, state }) => {
    const errors = [], witness = await nativeReferenceWitness(track, errors, clock);
    await new Promise(resolve => setImmediate(resolve));
    const result = await witness.stop();
    assert.deepEqual(state(), { stopped: true, closed: true });
    assert.equal(result.closed, false); assert.equal(result.actualFileBytes, 0);
    assert.ok(errors.some(error => error.message.includes('observed reader failed')));
    assert.deepEqual(result.countersBeforeCancel, { totalFrames: null, discardedFrames: null });
    assert.equal(await witness.stop(), result);
  }, true, false);
});

test('observation-file failure is retained after independent source cleanup', async () => {
  await withObserverFailure(async ({ track, clock, state }) => {
    const errors = [], witness = await nativeReferenceWitness(track, errors, clock);
    await new Promise(resolve => setImmediate(resolve));
    const result = await witness.stop();
    assert.deepEqual(state(), { stopped: true, closed: true });
    assert.equal(result.closed, false); assert.equal(result.actualFileBytes, null);
    assert.ok(errors.some(error => error.message.includes('observed file read failed')));
  }, false, true);
});

test('processor setup failure retires the already opened sink and cloned input', async () => {
  await withObserverFailure(async ({ track, clock, state }) => {
    await assert.rejects(nativeReferenceWitness(track, [], clock), /observer setup failed/);
    assert.deepEqual(state(), { stopped: true, closed: true });
  }, 'setup', false);
});

test('Stop consumes naturally queued PCM through the frozen video extent before cancel', async () => {
  const packet = timestamp => ({ sampleRate: 48000, numberOfChannels: 1, numberOfFrames: 480, timestamp,
    copyTo(target) { target.fill(.25); }, close() {} });
  await withObserverFailure(async ({ track, clock, state }) => {
    const errors = [], witness = await nativeReferenceWitness(track, errors, clock);
    const result = await witness.stop({ coverThroughPageMs: 115 });
    assert.equal(result.closed, true); assert.equal(result.frames.length, 2);
    assert.ok(result.lastSampleEndMs >= 115); assert.deepEqual(errors, []);
    assert.deepEqual(state(), { stopped: true, closed: true });
  }, (controller, canceled) => {
    controller.enqueue(packet(100000));
    setImmediate(() => { if (!canceled()) controller.enqueue(packet(110000)); });
  }, false);
});

test('missing natural PCM coverage expires and still retires its owned source and sink', async () => {
  await withObserverFailure(async ({ track, clock, state }) => {
    const errors = [], witness = await nativeReferenceWitness(track, errors, clock);
    const result = await witness.stop({ coverThroughPageMs: 115 });
    assert.equal(result.closed, false);
    assert.ok(errors.some(error => error.message.includes('PCM coverage deadline')));
    assert.deepEqual(state(), { stopped: true, closed: true });
  }, () => {}, false);
});

test('coverage uses the same sample-rounded coordinates as independent PCM analysis', async () => {
  const packet = timestamp => ({ sampleRate: 48000, numberOfChannels: 1, numberOfFrames: 480, timestamp,
    copyTo(target) { target.fill(.25); }, close() {} });
  await withObserverFailure(async ({ track, clock }) => {
    const errors = [], witness = await nativeReferenceWitness(track, errors, clock);
    const result = await witness.stop({ coverThroughPageMs: 110.503 });
    assert.equal(result.closed, true); assert.equal(result.frames.length, 2);
    assert.ok(result.lastSampleEndMs >= 110.503); assert.deepEqual(errors, []);
  }, (controller, canceled) => {
    controller.enqueue(packet(100506));
    setImmediate(() => { if (!canceled()) controller.enqueue(packet(110506)); });
  }, false);
});


test('initial readiness requires an actually consumed PCM packet and preserves its raw timestamp', async () => {
  let deliver;
  await withObserverFailure(async ({ track, clock, state }) => {
    const errors = [], witness = await nativeReferenceWitness(track, errors, clock);
    let ready = false;
    const waiting = witness.ready().then(value => { ready = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ready, false);
    deliver({ sampleRate: 48000, numberOfChannels: 1, numberOfFrames: 480, timestamp: 379500,
      copyTo(target) { target.fill(.25); }, close() {} });
    const receipt = await waiting;
    assert.equal(receipt.firstTimestampUs, 379500);
    assert.ok(receipt.setupStartedPageMs <= receipt.sinkOpenedPageMs);
    assert.ok(receipt.sinkOpenedPageMs <= receipt.readerCreatedPageMs);
    assert.ok(receipt.readerCreatedPageMs <= receipt.firstObservedPageMs);
    assert.ok(receipt.firstObservedPageMs <= receipt.acknowledgedPageMs);
    const result = await witness.stop();
    assert.equal(result.frames[0].timestampUs, 379500);
    assert.equal(result.closed, true); assert.deepEqual(errors, []);
    assert.deepEqual(state(), { stopped: true, closed: true });
  }, controller => { deliver = value => controller.enqueue(value); }, false);
});

test('initial PCM readiness has a deadline and missing samples still permit independent cleanup', async () => {
  await withObserverFailure(async ({ track, clock, state }) => {
    const witness = await nativeReferenceWitness(track, [], clock);
    await assert.rejects(witness.ready(), /Initial supplied-reference PCM deadline/);
    await witness.stop();
    assert.deepEqual(state(), { stopped: true, closed: true });
  }, () => {}, false);
});

test('a failed first PCM read cannot admit video as ready', async () => {
  await withObserverFailure(async ({ track, clock, state }) => {
    const errors = [], witness = await nativeReferenceWitness(track, errors, clock);
    await assert.rejects(witness.ready(), /Initial supplied-reference PCM is unavailable/);
    const result = await witness.stop();
    assert.equal(result.closed, false); assert.ok(errors.length);
    assert.deepEqual(state(), { stopped: true, closed: true });
  }, true, false);
});

test('post-Stop guard waits for actual queued samples instead of ending at the video boundary',async()=>{
  let deliver;
  await withObserverFailure(async({track,clock,state})=>{
    const errors=[],witness=await nativeReferenceWitness(track,errors,clock);
    const packet=timestamp=>({sampleRate:48000,numberOfChannels:1,numberOfFrames:480,timestamp,copyTo(target){target.fill(.25);},close(){}});
    deliver(packet(100000));await witness.ready();let ended=false;
    const stopping=witness.stop({coverThroughPageMs:335}).then(result=>{ended=true;return result;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(ended,false);
    for(let stamp=110000;stamp<=330000;stamp+=10000)deliver(packet(stamp));
    const result=await stopping;assert.equal(result.closed,true);assert.ok(result.lastSampleEndMs>=335);
    assert.equal(result.actualFileBytes,result.frames.length*480*4);assert.deepEqual(errors,[]);assert.deepEqual(state(),{stopped:true,closed:true});
  },controller=>{deliver=value=>controller.enqueue(value);},false);
});
