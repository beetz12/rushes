import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as admissionFiles from 'node:fs';
import { sourceTaskObservationWindow } from './cold-trace.mjs';

const source = admissionFiles.readFileSync(new URL('./matrix.mjs', import.meta.url), 'utf8');
const begin = source.indexOf("const long = process.env.RUSHES_M1_LONG === '1';");
const end = source.indexOf('const root = fileURLToPath(', begin);
assert.ok(begin >= 0 && end > begin);
const actualAdmission = new Function('sourceTaskObservationWindow', 'process', `${source.slice(begin, end)}\nreturn {sourceOnly,sourceAudioTrace,nativeTraceRequested,targetMs};`).bind(undefined, sourceTaskObservationWindow);
const ordinary = { RUSHES_M1_SOURCE_MODE: 'native-reference', RUSHES_M1_NATIVE_SOURCE_ONLY: '1' };

test('ordinary source-only admission remains untraced and cannot use the full recorder trace selector', () => {
  assert.deepEqual(actualAdmission({ env: ordinary }), { sourceOnly: true, sourceAudioTrace: false, nativeTraceRequested: false, targetMs: 8000 });
  assert.throws(() => actualAdmission({ env: { ...ordinary, RUSHES_M1_NATIVE_TRACE_PROOF: '1' } }), /untraced8s/);
});
test('only an explicit isolated8s source-only diagnostic admits native audio tracing', () => {
  const traced = { ...ordinary, RUSHES_M1_SOURCE_AUDIO_TRACE_PROOF: '1' };
  assert.deepEqual(actualAdmission({ env: traced }), { sourceOnly: true, sourceAudioTrace: true, nativeTraceRequested: true, targetMs: 8000 });
  for (const overrides of [
    { RUSHES_M1_NATIVE_SOURCE_ONLY: undefined }, { RUSHES_M1_SOURCE_MODE: 'container' },
    { RUSHES_M1_LONG: '1' }, { RUSHES_M1_REFERENCE: '1' }, { RUSHES_M1_DIAGNOSTIC: '1' },
    { RUSHES_M1_NATIVE_TRACE_PROOF: '1' }, { RUSHES_M1_SOURCE_AUDIO_TRACE_PROOF: '0' },
    { RUSHES_M1_NATIVE_TRACE_PROOF: '0' },
  ]) assert.throws(() => actualAdmission({ env: { ...traced, ...overrides } }));
});
test('native capture entries are admitted only for the failed default128 source-only trace profile',()=>{
  const traced={...ordinary,RUSHES_M1_SOURCE_AUDIO_TRACE_PROOF:'1',RUSHES_M1_SOURCE_VIDEO_TRACE_PROOF:'1',RUSHES_M1_SOURCE_AUDIO_SINK:'default'};
  assert.equal(actualAdmission({env:traced}).targetMs,8000);
  for(const overrides of [{RUSHES_M1_SOURCE_AUDIO_SINK:'none'},{RUSHES_M1_SOURCE_AUDIO_TRACE_PROOF:undefined},
    {RUSHES_M1_SOURCE_VIDEO_TRACE_PROOF:'0'},{RUSHES_M1_SOURCE_AUDIO_FRAMES:'480'},{RUSHES_M1_NATIVE_SOURCE_ONLY:undefined},
    {RUSHES_M1_LONG:'1'},{RUSHES_M1_REFERENCE:'1'}])assert.throws(()=>actualAdmission({env:{...traced,...overrides}}));
});

test('whole capture task tracing requires the same isolated native capture profile',()=>{
 const traced={...ordinary,RUSHES_M1_SOURCE_AUDIO_TRACE_PROOF:'1',RUSHES_M1_SOURCE_VIDEO_TRACE_PROOF:'1',RUSHES_M1_SOURCE_AUDIO_SINK:'default',RUSHES_M1_SOURCE_TASK_TRACE_PROOF:'1'};
 assert.equal(actualAdmission({env:traced}).targetMs,8000);
 for(const overrides of [{RUSHES_M1_SOURCE_TASK_TRACE_PROOF:'0'},{RUSHES_M1_SOURCE_VIDEO_TRACE_PROOF:undefined},{RUSHES_M1_SOURCE_AUDIO_SINK:'none'},{RUSHES_M1_LONG:'1'}])assert.throws(()=>actualAdmission({env:{...traced,...overrides}}));
});

test('the actual CLI admits a partial window only in its existing isolated task profile', () => {
  const traced = { ...ordinary, RUSHES_M1_SOURCE_AUDIO_TRACE_PROOF: '1', RUSHES_M1_SOURCE_VIDEO_TRACE_PROOF: '1',
    RUSHES_M1_SOURCE_AUDIO_SINK: 'default', RUSHES_M1_SOURCE_TASK_TRACE_PROOF: '1', RUSHES_M1_SOURCE_TASK_TRACE_WINDOW_MS: '2000' };
  assert.equal(actualAdmission({ env: traced }).targetMs, 8000);
  for (const value of ['', '0', '1000', '2001', '20000'])
    assert.throws(() => actualAdmission({ env: { ...traced, RUSHES_M1_SOURCE_TASK_TRACE_WINDOW_MS: value } }), /2000ms/);
  for (const overrides of [{ RUSHES_M1_SOURCE_TASK_TRACE_PROOF: undefined }, { RUSHES_M1_SOURCE_VIDEO_TRACE_PROOF: undefined },
    { RUSHES_M1_NATIVE_SOURCE_ONLY: undefined }, { RUSHES_M1_SOURCE_AUDIO_SINK: 'none' }, { RUSHES_M1_LONG: '1' }, { RUSHES_M1_REFERENCE: '1' }])
    assert.throws(() => actualAdmission({ env: { ...traced, ...overrides } }));
});
