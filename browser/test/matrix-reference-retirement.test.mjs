import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {SOURCE_PCM_GUARD_MS} from './native-reference-witness.mjs';
const fixture=await readFile(new URL('./matrix-fixture.mjs',import.meta.url),'utf8');
const first=fixture.indexOf('  let observationRetirement;'),last=fixture.indexOf('  // Source-only diagnostics share the actual observation retirement above.',first);
assert.ok(first>=0&&last>first);
const body=fixture.slice(first,last);

test('actual fixture retires video before requesting a bounded PCM guard and preserves its body endpoint',async()=>{
  const retired=Promise.withResolvers(),events=[],metrics={observerErrors:[],clockCapability:{converter:{originIntervalMs:[999.9,1000.1]}},frames:{'native-input':{lastTimestamp:1500000}},sourceObserverRetirement:{optical:{lastTimestamp:1533333}}};
  let target;
  const context={metrics,observingReference:true,SOURCE_PCM_GUARD_MS,id:'owned-test-take',performance:{now:()=>500},
    retireSourceObserver:async()=>{await retired.promise;events.push('video-retired');},
    monitors:[async()=>{events.push('monitor-retired');}],
    suppliedReference:{stop:async({coverThroughPageMs})=>{target=coverThroughPageMs;events.push('pcm-stop');return{closed:true,lastSampleEndMs:730};}}};
  vm.runInNewContext(body+'\nglobalThis.retire=retireObservations;',context);
  const stopped=context.retire();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(target,undefined);retired.resolve();await stopped;
  assert.equal(target,720);assert.equal(SOURCE_PCM_GUARD_MS,220);
  assert.ok(events.indexOf('video-retired')<events.indexOf('pcm-stop'));
  assert.equal(metrics.frames['native-input'].lastTimestamp,1500000);
  assert.equal(metrics.sourceObserverRetirement.optical.lastTimestamp,1533333);
  assert.equal(metrics.suppliedReference.takeId,'owned-test-take');
  assert.equal(metrics.suppliedReference.observationGuard.bodyEndTimestampUs,1500000);
  assert.equal(metrics.suppliedReference.observationGuard.targetPageMs,720);
  assert.deepEqual(metrics.observerErrors,[]);
});
