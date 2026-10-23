// Optional generated cold-case metadata. Never changes the media source or its clocks.
import * as files from 'node:fs/promises';
import * as paths from 'node:path';
import { randomUUID } from 'node:crypto';

const deadline = async (operation, milliseconds, label) => {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
  })]); } finally { clearTimeout(timer); }
};

export function checkPrescribedTraceMarks(events, observations) {
  if (observations.length !== 7) throw new Error('Expected seven prescribed clock marks');
  let origin, owner;
  for (const observation of observations) {
    const rows = events.filter(event => event.name === observation.name);
    if (rows.length !== 1) throw new Error('Missing or duplicate prescribed clock mark');
    const row = rows[0], startUs = observation.coordinateMs * 1000;
    if (!Number.isSafeInteger(row.ts) || !Number.isSafeInteger(startUs)
      || row.args?.data?.startTime !== observation.coordinateMs
      || !Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.tid))
      throw new Error('Invalid prescribed clock mark metadata');
    const selectedOrigin = row.ts - startUs;
    if (origin === undefined) { origin = selectedOrigin; owner = { pid: row.pid, tid: row.tid }; }
    if (origin !== selectedOrigin || row.pid !== owner.pid || row.tid !== owner.tid)
      throw new Error('Prescribed trace coordinates changed origin, units or owner');
  }
  return { fixedUnits: 'microseconds', unitSlope: 1, traceOriginUs: origin, owner,
    callTimes: observations.map(observation => ({ name: observation.name,
      nativeCallTimeUs: events.find(event => event.name === observation.name).args?.data?.callTime })),
    scope: 'Prescribed coordinate/export identity only; no supplied-media origin or A/V fit' };
}

export function requireNativeClockTrace(report, capability) {
  const converter = capability?.converter, coordinate = report?.clock;
  if (!converter?.qualified || !coordinate || !Array.isArray(report.errors) || report.errors.length
    || !Number.isSafeInteger(coordinate.traceOriginUs) || report.traceReceipt?.dataLossOccurred !== false)
    throw new Error('Native clock trace was not qualified');
  const originMs = coordinate.traceOriginUs / 1000;
  if (!Array.isArray(converter.originIntervalMs) || converter.originIntervalMs.length !== 2
    || !converter.originIntervalMs.every(Number.isFinite) || converter.originIntervalMs[0] > converter.originIntervalMs[1] || originMs < converter.originIntervalMs[0]
    || originMs > converter.originIntervalMs[1]) throw new Error('Native converter and trace origins disagree');
  const observations = report.javascript?.observations;
  if (observations?.length !== 7 || coordinate.callTimes?.length !== 7) throw new Error('Native clock trace needs seven held-out call brackets');
  // performance.now() subtracts two independently coarsened native scalars
  // (Performance::MonotonicTimeToDOMHighResTimeStamp). Charge both resolutions;
  // this is a coordinate-proof bound, never extra recorded A/V tolerance.
  const allowance = 2 * capability.privacyResolutionMs + converter.numericConversionAllowanceMs;
  if (!Number.isFinite(allowance) || allowance < 0 || allowance > 1) throw new Error('Native clock privacy budget is invalid');
  for (const observation of observations) {
    const call = coordinate.callTimes.filter(row => row.name === observation.name);
    if (call.length !== 1 || !Number.isSafeInteger(call[0].nativeCallTimeUs)
      || !Number.isFinite(observation.calledBeforePageMs) || !Number.isFinite(observation.calledAfterPageMs)
      || observation.calledAfterPageMs < observation.calledBeforePageMs)
      throw new Error('Native clock call bracket is missing or malformed');
    const relative = call[0].nativeCallTimeUs / 1000 - originMs;
    if (relative < observation.calledBeforePageMs - allowance || relative > observation.calledAfterPageMs + allowance)
      throw new Error('Native trace callTime is outside its independent page bracket');
  }
  return { qualified: true, scope: 'Native scalar coordinate conversion only; no media phase correction', originMs };
}

export function recorderCallMetadata(text) {
  const prefix='GENERATED_RECORDER_CALL ';
  if(typeof text!=='string'||text.length>1024||!text.startsWith(prefix))return;
  let row;try{row=JSON.parse(text.slice(prefix.length));}catch{return;}
  if(!row||Object.keys(row).sort().join(',')!=='edge,id,index,method,state,timeMs'
    ||!Number.isSafeInteger(row.id)||row.id<0||!Number.isSafeInteger(row.index)||row.index<0
    ||!['start','pause','resume','stop'].includes(row.method)||!['before','after'].includes(row.edge)
    ||!['inactive','recording','paused'].includes(row.state)||!Number.isFinite(row.timeMs)||row.timeMs<0)return;
  return row;
}

export function sourceTaskObservationWindow(value, taskDiagnostics) {
  if (value === undefined) return 0;
  if (value !== '2000' || taskDiagnostics !== true)
    throw new Error('A2000ms trace window requires the isolated source task diagnostic');
  return 2000;
}

export async function beginColdTrace(browser, page, directory, limits = {}) {
  if (limits.audioDiagnostics !== undefined && typeof limits.audioDiagnostics !== 'boolean') throw new Error('Audio trace option must be boolean');
  if (limits.canvasDiagnostics !== undefined && typeof limits.canvasDiagnostics !== 'boolean') throw new Error('Canvas trace option must be boolean');
  if (limits.videoCaptureDiagnostics !== undefined && typeof limits.videoCaptureDiagnostics !== 'boolean') throw new Error('Video capture trace option must be boolean');
  for(const name of ['captureTaskDiagnostics','streamRecorderCalls'])if(limits[name]!==undefined&&typeof limits[name]!=='boolean')throw new Error('Trace observation options must be boolean');
  const finalizationMs = limits.finalizationMs ?? 15000, metadataMs = limits.metadataMs ?? 2000;
  if (!Number.isSafeInteger(finalizationMs) || finalizationMs < 1 || finalizationMs > 15000
    || !Number.isSafeInteger(metadataMs) || metadataMs < 1 || metadataMs > Math.min(2000, finalizationMs))
    throw new Error('Diagnostic test limits may only shorten the production budgets');
  await deadline(files.mkdir(directory, { mode: 0o700 }), 5000, 'Cold trace directory');
  const session = await deadline(browser.newBrowserCDPSession(), 5000, 'Cold trace session'), token = `rushes-cold-${randomUUID()}`;
  const report = { scope: 'Optional generated cold timing diagnostic; existing recording assertions remain authoritative',
    token, chrome: browser.version(), errors: [], traceReceipt: null };
  let started = false, finishing;
  const finish = (context, { readAfter } = {}) => {
    if (finishing) return finishing;
    if (readAfter !== undefined && (!limits.captureTaskDiagnostics || typeof readAfter?.then !== 'function'))
      throw new Error('Deferred trace reads require a source task retirement promise');
    finishing = (async () => {
      let stream, handle, onComplete;
      const begun = performance.now(), expires = begun + finalizationMs;
      const step = (operation, label, cap = finalizationMs) => deadline(operation,
        Math.max(1, Math.min(cap, expires - performance.now())), label);
      report.context = context;
      try {
        report.javascript = await step(page.evaluate(() => globalThis.__rushesColdTrace?.finish()), 'Cold call observation retirement', metadataMs);
        if (!report.javascript) report.errors.push('Cold call observation was unavailable');
      } catch (error) { report.errors.push(String(error.stack || error)); }
      try {
        if (started) {
          const completed = new Promise(resolve => {
            onComplete = receipt => { report.traceReceipt = receipt; stream = receipt.stream; resolve(receipt); };
            session.once('Tracing.tracingComplete', onComplete);
          });
          try { await step(session.send('Tracing.end'), 'Cold trace end'); }
          catch (error) { report.errors.push(`Trace end acknowledgement: ${error}`); }
          report.traceReceipt = await step(completed, 'Cold trace receipt');
          stream = report.traceReceipt.stream;
          if (!stream) throw new Error('Cold trace did not provide an evidence stream');
          // Collection is already closed. The original aggregate budget also
          // covers waiting for the live source to retire before heavy IO.
          if (readAfter) await step(readAfter, 'Cold trace source retirement');
          if (performance.now() >= expires) throw new Error('Cold trace exceeded its read/time budget');
          const file = paths.join(directory, 'trace.json'); handle = await step(files.open(file, 'wx'), 'Cold trace file'); let bytes = 0, reads = 0;
          for (;;) {
            if (++reads > 2048 || performance.now() >= expires) throw new Error('Cold trace exceeded its read/time budget');
            const packet = await step(session.send('IO.read', { handle: stream, size: 1048576 }), 'Cold trace read');
            const data = packet.base64Encoded ? Buffer.from(packet.data, 'base64') : Buffer.from(packet.data);
            bytes += data.length; if (bytes > 128 * 1024 ** 2) throw new Error('Cold trace exceeded128MiB');
            await step(handle.writeFile(data), 'Cold trace write'); if (packet.eof) break;
          }
          await step(handle.close(), 'Cold trace file close'); handle = undefined; report.traceBytes = bytes;
          if (report.traceReceipt.dataLossOccurred !== false) throw new Error('Cold trace loss was present or unmeasured');
          const events = JSON.parse(await step(files.readFile(file, 'utf8'), 'Cold trace parse input')).traceEvents;
          if (report.javascript) report.clock = checkPrescribedTraceMarks(events, report.javascript.observations);
          report.recorderMarks = events.filter(event => event.name?.startsWith(`${token}/recorder-`));
        }
      } catch (error) { report.errors.push(String(error.stack || error)); }
      finally {
        try { if (handle) await step(handle.close(), 'Cold trace file retirement'); } catch (error) { report.errors.push(`File close: ${error}`); }
        try { if (stream) await step(session.send('IO.close', { handle: stream }), 'Cold trace stream close'); }
        catch (error) { report.errors.push(String(error)); }
        if (onComplete) session.off('Tracing.tracingComplete', onComplete);
        try { await step(session.detach(), 'Cold trace detach'); }
        catch (error) { report.errors.push(String(error)); }
        report.finalizationMs = performance.now() - begun;
        if (report.finalizationMs > finalizationMs) report.errors.push('Cold trace aggregate retirement budget expired');
        await deadline(files.writeFile(paths.join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' }), 2000, 'Cold trace error receipt');
      }
      if (report.errors.length) throw new Error(`Cold trace diagnostic failed: ${report.errors.join('; ')}`);
      return report;
    })();
    return finishing;
  };
  try {
    // The owned browser has no other tracing client. Attempt retirement even if
    // the start reply is lost after the browser accepted it.
    started = true;
    report.categories = ['media', 'blink.user_timing'];
    if (limits.canvasDiagnostics) report.categories.push('blink');
    if (limits.audioDiagnostics) report.categories.push('mediastream', 'disabled-by-default-audio', 'webaudio',
      'disabled-by-default-webaudio.audionode', 'disabled-by-default-mediastream');
    if (limits.videoCaptureDiagnostics) report.categories.push('disabled-by-default-video_and_image_capture');
    if (limits.captureTaskDiagnostics) report.categories.push('toplevel',
      'disabled-by-default-sequence_manager', 'disabled-by-default-sequence_manager.debug');
    await deadline(session.send('Tracing.start', { transferMode: 'ReturnAsStream', streamFormat: 'json',
      traceConfig: { recordMode: 'recordContinuously', traceBufferSizeInKb: 32768,
        includedCategories: report.categories, enableArgumentFilter: false } }), 5000, 'Cold trace start');
    await deadline(page.evaluate(({token,streamRecorderCalls}) => {
      const calls = [], observations = [], originals = new Map(), ids = new WeakMap();
      let nextId = 0, streamedCallRows=0, droppedCallRows=0;
      const streamCall=(row,edge,timeMs,state)=>{
        if(!streamRecorderCalls)return;
        if(streamedCallRows>=128){droppedCallRows++;return;}
        streamedCallRows++;console.log('GENERATED_RECORDER_CALL '+JSON.stringify({id:row.id,index:row.index,method:row.method,edge,timeMs,state}));
      };
      const prescribed = (batch, coordinates) => coordinates.forEach((coordinateMs, index) => {
        const name = `${token}/clock-${batch}-${index}`;
        const calledBeforePageMs = performance.now();
        performance.mark(name, { startTime: coordinateMs });
        observations.push({ name, coordinateMs, calledBeforePageMs, calledAfterPageMs: performance.now() });
      });
      globalThis.__rushesColdTrace = { token, calls, observations, timeOrigin: performance.timeOrigin,
        finish() {
          try { prescribed('later', [1.25, 1002.75, 3003.5]); prescribed('held-out', [5004.125]); }
          finally { for (const [method, original] of originals) MediaRecorder.prototype[method] = original; }
          return { token, calls, observations, timeOrigin: performance.timeOrigin,streamedCallRows,droppedCallRows };
        } };
      prescribed('first', [1.25, 1002.75, 3003.5]);
      for (const method of ['start', 'pause', 'resume', 'stop']) {
        const original = MediaRecorder.prototype[method]; originals.set(method, original);
        MediaRecorder.prototype[method] = function(...args) {
          if (!ids.has(this)) ids.set(this, nextId++);
          const id = ids.get(this), index = calls.length;
          const row = { id, index, method, before: performance.now(), beforeState: this.state };
          calls.push(row); performance.mark(`${token}/recorder-${id}/${index}-${method}-before`, { startTime: row.before });
          streamCall(row,'before',row.before,row.beforeState);
          try { return Reflect.apply(original, this, args); }
          catch (error) { row.error = String(error); throw error; }
          finally {
            row.after = performance.now(); row.afterState = this.state;
            streamCall(row,'after',row.after,row.afterState);
            performance.mark(`${token}/recorder-${id}/${index}-${method}-after`, { startTime: row.after });
          }
        };
      }
    }, {token,streamRecorderCalls:limits.streamRecorderCalls===true}), 5000, 'Cold call observation setup');
  } catch (error) {
    report.errors.push(`Setup: ${error.stack || error}`);
    try { await finish({ result: 'Cold trace setup failed before recording' }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Cold trace setup failed; evidence retained'); }
    throw error;
  }
  return { finish };
}
