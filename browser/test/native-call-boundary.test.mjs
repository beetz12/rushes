// Actual installed trace wrapper with fake methods/clocks; no browser/media claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recorderCallMetadata } from './cold-trace.mjs';
const source=readFileSync(new URL('./cold-trace.mjs',import.meta.url),'utf8');
const prefix='await deadline(page.evaluate(({token,streamRecorderCalls}) => {';
const begin=source.indexOf(prefix)+prefix.length,end=source.indexOf('    }, {token,streamRecorderCalls:',begin);
assert.ok(begin>=prefix.length&&end>begin);
const install=new Function('globalThis','performance','MediaRecorder','console','token','streamRecorderCalls',source.slice(begin,end));
function controlled({nativeError,badClock=false,afterConsoleError=false}={}){
 let now=0,failClock=false;const rows=[],global={},result={owned:'return-value'};
 class Recorder{state='inactive';start(){now+=200;this.state='recording';if(nativeError)throw nativeError;return result;}pause(){}resume(){}stop(){}}
 const performance={timeOrigin:0,now(){if(failClock){failClock=false;throw new Error('controlled probe unavailable');}return now;},mark(){}};
 const console={log(text){const row=JSON.parse(text.slice('GENERATED_RECORDER_CALL '.length));if(row.edge==='before'){now+=300;if(badClock)failClock=true;}else if(afterConsoleError)throw new Error('controlled observer failure');rows.push(row);}};
 install(global,performance,Recorder,console,'controlled',true);
 return{recorder:new Recorder(),rows,global,result,advance:ms=>{now+=ms;}};
}
test('invocation boundary excludes300ms before-console work from200ms native wall interval',()=>{
 const f=controlled();assert.equal(f.recorder.start(),f.result);const call=f.global.__rushesColdTrace.calls[0];
 assert.equal(call.after-call.before,500);assert.equal(call.invokeStartMs,300);assert.equal(call.invokeEndMs,500);assert.equal(call.invokeEndMs-call.invokeStartMs,200);
 assert.equal(f.rows.length,2);assert.deepEqual(Object.keys(f.rows[0]).sort(),['edge','id','index','method','state','timeMs']);
 assert.equal(f.rows[1].invokeStartMs,300);assert.equal(f.rows[1].invokeEndMs,500);assert.deepEqual(recorderCallMetadata('GENERATED_RECORDER_CALL '+JSON.stringify(f.rows[1])),f.rows[1]);
 f.global.__rushesColdTrace.finish();
});
test('throwing native value stays primary and invocation ends before diagnostic string work',()=>{
 const nativeError=new Error('controlled native failure');let f;nativeError.toString=()=>{f.advance(100);return 'controlled native failure';};f=controlled({nativeError});
 assert.throws(()=>f.recorder.start(),error=>error===nativeError);const call=f.global.__rushesColdTrace.calls[0];
 assert.equal(call.invokeEndMs-call.invokeStartMs,200);assert.equal(call.after-call.before,600);assert.equal(call.error,'controlled native failure');f.global.__rushesColdTrace.finish();
});
test('native error identity survives refused diagnostic conversion and after-console observation',()=>{
 const nativeError={toString(){throw new Error('controlled conversion refusal');}};const f=controlled({nativeError,afterConsoleError:true});
 assert.throws(()=>f.recorder.start(),error=>error===nativeError);const call=f.global.__rushesColdTrace.calls[0];assert.equal(call.invokeEndMs-call.invokeStartMs,200);
 assert.equal(call.error,'Error detail unavailable');assert.equal(call.afterObservationFailed,true);assert.equal(f.rows.length,1);f.global.__rushesColdTrace.finish();
});
test('unavailable new clock is retained as unknown and does not change the native return',()=>{
 const f=controlled({badClock:true});assert.equal(f.recorder.start(),f.result);const row=f.rows[1];assert.equal(row.invokeStartMs,null);assert.equal(row.invokeEndMs,500);
 assert.deepEqual(recorderCallMetadata('GENERATED_RECORDER_CALL '+JSON.stringify(row)),row);f.global.__rushesColdTrace.finish();
});
test('parser preserves legacy records and rejects malformed or wrong-edge invocation bounds',()=>{
 const encode=row=>'GENERATED_RECORDER_CALL '+JSON.stringify(row),base={id:0,index:1,method:'stop',edge:'after',state:'inactive',timeMs:500};
 assert.deepEqual(recorderCallMetadata(encode(base)),base);const row={...base,invokeStartMs:300,invokeEndMs:500};assert.deepEqual(recorderCallMetadata(encode(row)),row);
 for(const change of [{edge:'before'},{invokeStartMs:-1},{invokeEndMs:501},{invokeStartMs:400,invokeEndMs:300},{invokeStartMs:'300'},{arbitrary:1}])assert.equal(recorderCallMetadata(encode({...row,...change})),undefined);
 const missing={...row};delete missing.invokeEndMs;assert.equal(recorderCallMetadata(encode(missing)),undefined);
});
