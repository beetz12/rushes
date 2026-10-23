import * as nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { checkPrescribedTraceMarks } from './cold-trace.mjs';
import { beginColdTrace,recorderCallMetadata,sourceTaskObservationWindow } from './cold-trace.mjs';
import * as files from 'node:fs/promises';
import * as paths from 'node:path';
import * as operatingSystem from 'node:os';
import { EventEmitter } from 'node:events';

const observation = () => [1.25, 1002.75, 3003.5, 1.25, 1002.75, 3003.5, 5004.125]
  .map((coordinateMs, index) => ({ name: `prescribed-${index}`, coordinateMs }));
const exported = input => input.map(row => ({ name: row.name, ts: 90000000 + row.coordinateMs * 1000,
  pid: 101, tid: 202, args: { data: { startTime: row.coordinateMs, callTime: 123 } } }));
nodeTest.test('prescribed trace coordinates retain a fixed origin despite different call times and event order', () => {
  const input = observation(), rows = exported(input).reverse();
  rows.forEach((row, index) => { row.args.data.callTime += index * 987654; });
  assert.equal(checkPrescribedTraceMarks(rows, input).traceOriginUs, 90000000);
});
nodeTest.test('missing, duplicated, wrong-unit, shifted or cross-owner trace coordinates fail closed', () => {
  const input = observation(), rows = exported(input);
  assert.throws(() => checkPrescribedTraceMarks(rows.slice(1), input), /Missing/);
  assert.throws(() => checkPrescribedTraceMarks([...rows, rows[0]], input), /duplicate/);
  for (const mutate of [row => { row.ts *= 1000; }, row => { row.ts += 37000; }, row => { row.pid++; },
    row => { row.args.data.startTime += 1; }]) {
    const changed = structuredClone(rows); mutate(changed.at(-1));
    assert.throws(() => checkPrescribedTraceMarks(changed, input), /Invalid|changed origin/);
  }
});

async function retirementFixture(testContext, failSetup, stallRetirement = false, rejectEnd = false) {
  const temporary = await files.mkdtemp(paths.join(operatingSystem.tmpdir(), 'rushes-cold-trace-'));
  testContext.after(() => files.rm(temporary, { recursive: true }));
  const directory = paths.join(temporary, 'evidence'), calls = [], requests = [];
  class Session extends EventEmitter {
    async send(method, parameters) {
      calls.push(method);
      requests.push({ method, parameters });
      if (method === 'Tracing.end') {
        queueMicrotask(() => this.emit('Tracing.tracingComplete', { stream: 'owned-stream', dataLossOccurred: false }));
        if (rejectEnd) throw new Error('end acknowledgement lost');
      }
      if (method === 'IO.read') return { data: JSON.stringify({ traceEvents: [] }), eof: true };
      return {};
    }
    async detach() { calls.push('detach'); }
  }
  const session = new Session(); let evaluations = 0;
  const page = { evaluate: async () => {
    evaluations++;
    if (evaluations === 1 && !failSetup) return;
    if (stallRetirement) return new Promise(() => {});
    throw new Error(evaluations === 1 ? 'partial setup rejected' : 'metadata retirement rejected');
  } };
  return { directory, calls, requests, browser: { version: () => 'diagnostic-unit-fixture', newBrowserCDPSession: async () => session }, page };
}

nodeTest.test('metadata retirement failure still ends the trace, retains raw bytes and closes its stream', async context => {
  const f = await retirementFixture(context, false);
  const trace = await beginColdTrace(f.browser, f.page, f.directory);
  await assert.rejects(trace.finish({ generated: true }), /metadata retirement rejected/);
  assert.deepEqual(f.calls, ['Tracing.start', 'Tracing.end', 'IO.read', 'IO.close', 'detach']);
  assert.deepEqual(JSON.parse(await files.readFile(paths.join(f.directory, 'trace.json'), 'utf8')), { traceEvents: [] });
  const report = JSON.parse(await files.readFile(paths.join(f.directory, 'report.json'), 'utf8'));
  assert.equal(report.traceReceipt.dataLossOccurred, false); assert.ok(report.errors.some(error => error.includes('metadata retirement rejected')));
});
nodeTest.test('native capture diagnostics add only the explicitly requested native category',async context=>{
  for(const videoCaptureDiagnostics of [false,true]){
    const f=await retirementFixture(context,false);
    const trace=await beginColdTrace(f.browser,f.page,f.directory,{audioDiagnostics:true,videoCaptureDiagnostics});
    const categories=f.requests.find(row=>row.method==='Tracing.start').parameters.traceConfig.includedCategories;
    assert.deepEqual(categories,['media','blink.user_timing','mediastream','disabled-by-default-audio','webaudio',
      'disabled-by-default-webaudio.audionode','disabled-by-default-mediastream',...(videoCaptureDiagnostics?['disabled-by-default-video_and_image_capture']:[])]);
    await assert.rejects(trace.finish({generated:true}),/metadata retirement rejected/);
  }
});

nodeTest.test('audio diagnostics request native callback and graph categories only when explicitly enabled', async context => {
  const f = await retirementFixture(context, false);
  const trace = await beginColdTrace(f.browser, f.page, f.directory, { audioDiagnostics: true });
  await assert.rejects(trace.finish({ generated: true }), /metadata retirement rejected/);
  const categories = f.requests.find(row => row.method === 'Tracing.start').parameters.traceConfig.includedCategories;
  for (const category of ['disabled-by-default-audio', 'webaudio', 'mediastream', 'disabled-by-default-webaudio.audionode', 'disabled-by-default-mediastream'])
    assert.ok(categories.includes(category));
  await assert.rejects(beginColdTrace(f.browser, f.page, f.directory, { audioDiagnostics: 'true' }), /must be boolean/);
});

nodeTest.test('partial setup failure preserves both errors and independently retires the native trace', async context => {
  const f = await retirementFixture(context, true);
  await assert.rejects(beginColdTrace(f.browser, f.page, f.directory), /setup failed/);
  assert.deepEqual(f.calls, ['Tracing.start', 'Tracing.end', 'IO.read', 'IO.close', 'detach']);
  const report = JSON.parse(await files.readFile(paths.join(f.directory, 'report.json'), 'utf8'));
  assert.ok(report.errors.some(error => error.includes('partial setup rejected')));
  assert.ok(report.errors.some(error => error.includes('metadata retirement rejected')));
});

nodeTest.test('unanswered metadata has a smaller budget and cannot prevent native trace retirement', { timeout: 2000 }, async context => {
  const f = await retirementFixture(context, false, true);
  const trace = await beginColdTrace(f.browser, f.page, f.directory, { finalizationMs: 500, metadataMs: 30 });
  await assert.rejects(trace.finish({ generated: true }), /observation retirement timed out/);
  assert.deepEqual(f.calls, ['Tracing.start', 'Tracing.end', 'IO.read', 'IO.close', 'detach']);
});

nodeTest.test('a delivered trace stream is retained and closed when its end acknowledgement rejects', async context => {
  const f = await retirementFixture(context, false, false, true);
  const trace = await beginColdTrace(f.browser, f.page, f.directory);
  await assert.rejects(trace.finish({ generated: true }), /end acknowledgement lost/);
  assert.deepEqual(f.calls, ['Tracing.start', 'Tracing.end', 'IO.read', 'IO.close', 'detach']);
  const report = JSON.parse(await files.readFile(paths.join(f.directory, 'report.json'), 'utf8'));
  assert.equal(report.traceReceipt.stream, 'owned-stream');
  assert.ok(report.errors.some(error => error.includes('end acknowledgement lost')));
});

nodeTest.test('capture task observation adds only task selection categories to the selected native categories',async context=>{
 const f=await retirementFixture(context,false);const trace=await beginColdTrace(f.browser,f.page,f.directory,{audioDiagnostics:true,videoCaptureDiagnostics:true,captureTaskDiagnostics:true});
 const categories=f.requests.find(row=>row.method==='Tracing.start').parameters.traceConfig.includedCategories;
 assert.deepEqual(categories,['media','blink.user_timing','mediastream','disabled-by-default-audio','webaudio','disabled-by-default-webaudio.audionode','disabled-by-default-mediastream','disabled-by-default-video_and_image_capture','toplevel','disabled-by-default-sequence_manager','disabled-by-default-sequence_manager.debug']);
 await assert.rejects(trace.finish({generated:true}),/metadata retirement rejected/);
});
nodeTest.test('streamed recorder call metadata rejects payload fields and malformed or unbounded input',()=>{
 const row={id:0,index:1,method:'start',edge:'before',state:'inactive',timeMs:12};const encode=value=>'GENERATED_RECORDER_CALL '+JSON.stringify(value);
 assert.deepEqual(recorderCallMetadata(encode(row)),row);
 for(const value of [{...row,samples:[1,2]},{...row,id:-1},{...row,timeMs:'12'},{...row,method:'other'},{...row,edge:'unknown'}])assert.equal(recorderCallMetadata(encode(value)),undefined);
 for(const text of ['x','GENERATED_RECORDER_CALL [',encode({...row,state:'x'.repeat(2000)})])assert.equal(recorderCallMetadata(text),undefined);
});

nodeTest.test('only the explicit source task diagnostic admits the fixed two-second observation window', () => {
  assert.equal(sourceTaskObservationWindow(undefined, false), 0);
  assert.equal(sourceTaskObservationWindow(undefined, true), 0);
  assert.equal(sourceTaskObservationWindow('2000', true), 2000);
  for (const value of ['', '0', '2001', '20000', 2000, true, null])
    assert.throws(() => sourceTaskObservationWindow(value, true), /isolated source task diagnostic/);
  for (const enabled of [false, undefined, 'true'])
    assert.throws(() => sourceTaskObservationWindow('2000', enabled), /isolated source task diagnostic/);
});

nodeTest.test('collection closes once while trace IO waits for actual source retirement', async context => {
  const f = await retirementFixture(context, false);
  const trace = await beginColdTrace(f.browser, f.page, f.directory, { captureTaskDiagnostics: true });
  let release;
  const readAfter = new Promise(resolve => { release = resolve; });
  const finishing = trace.finish({ stage: 'partial-window' }, { readAfter });
  const rejected = assert.rejects(finishing, /metadata retirement rejected/);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, ['Tracing.start', 'Tracing.end']);
  await assert.rejects(files.access(paths.join(f.directory, 'trace.json')), /ENOENT/);
  assert.equal(trace.finish({ stage: 'later-source-retired' }), finishing);
  release(); await rejected;
  assert.deepEqual(f.calls, ['Tracing.start', 'Tracing.end', 'IO.read', 'IO.close', 'detach']);
});

nodeTest.test('source deferral consumes the original aggregate budget and cannot restart it', async context => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance'); let now = 0;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
  try {
    const f = await retirementFixture(context, false);
    const trace = await beginColdTrace(f.browser, f.page, f.directory,
      { captureTaskDiagnostics: true, finalizationMs: 500, metadataMs: 30 });
    let release; const readAfter = new Promise(resolve => { release = resolve; });
    const finishing = trace.finish({ stage: 'partial-window' }, { readAfter });
    const rejected = assert.rejects(finishing, /read\/time budget/);
    await new Promise(resolve => setImmediate(resolve));
    now = 501; release(); await rejected;
    const report = JSON.parse(await files.readFile(paths.join(f.directory, 'report.json'), 'utf8'));
    assert.equal(report.finalizationMs, 501);
    assert.ok(report.errors.some(error => error.includes('aggregate retirement budget expired')));
    assert.deepEqual(f.calls, ['Tracing.start', 'Tracing.end', 'IO.close', 'detach']);
    await assert.rejects(files.access(paths.join(f.directory, 'trace.json')), /ENOENT/);
  } finally { Object.defineProperty(globalThis, 'performance', descriptor); }
});

nodeTest.test('ordinary traces and malformed gates cannot defer reads', async context => {
  for (const limits of [{}, { captureTaskDiagnostics: true }]) {
    const f = await retirementFixture(context, false), trace = await beginColdTrace(f.browser, f.page, f.directory, limits);
    assert.throws(() => trace.finish({}, { readAfter: limits.captureTaskDiagnostics ? {} : Promise.resolve() }), /retirement promise/);
    await assert.rejects(trace.finish({ stage: 'retire-after-invalid-call' }), /metadata retirement rejected/);
    assert.deepEqual(f.calls, ['Tracing.start', 'Tracing.end', 'IO.read', 'IO.close', 'detach']);
  }
});
