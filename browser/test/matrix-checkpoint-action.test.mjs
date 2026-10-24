import { test } from 'node:test';
import * as verifyBroker from 'node:assert/strict';
import * as brokerEvents from 'node:events';
import * as brokerFiles from 'node:fs/promises';
import * as brokerPaths from 'node:path';
import * as brokerProcesses from 'node:child_process';
import { tmpdir } from 'node:os';
import { superviseCheckpoints, requestCheckpoint, uploadInWorker, withoutCredentials, matrixChildEnvironment, parseArtifactOutput,
  supervisorSnapshot,waitForOwnedReady,matrixOutcomeBeforeDeadline,retirementPredicateReason } from './matrix-checkpoint-action.mjs';
const artifact = { id: 123, size: 42, digest: 'a'.repeat(64) };
const assert = verifyBroker.default, EventEmitter = brokerEvents.EventEmitter;
class Child extends EventEmitter { connected = true; replies = []; send(reply) { this.replies.push(reply); this.emit('reply', reply); } }
async function proof(context) {
  const root = await brokerFiles.mkdtemp(brokerPaths.join(tmpdir(),'rushes-checkpoint-'));
  context.after(() => brokerFiles.rm(root,{recursive:true,force:true}));
  await brokerFiles.writeFile(brokerPaths.join(root,'metrics.json'), JSON.stringify({scope:'generated fixture'}));
  await brokerFiles.writeFile(brokerPaths.join(root,'owned-browser-pid.json'), JSON.stringify({pid:123,profile:brokerPaths.join(root,'isolated-profile')}));
  await brokerFiles.writeFile(brokerPaths.join(root,'chrome-stderr.log'),'generated Chrome stderr');
  await brokerFiles.writeFile(brokerPaths.join(root,'.env'),'never upload this generated sentinel');
  return root;
}
const request = (sequence=1,stage='normal-before-recovery') => ({kind:'rushes-checkpoint-request',sequence,stage,deadlineWallMs:Date.now()+60000});
test('finalized immutable receipt gates acknowledgement and only generated allowlisted files upload', async context => {
  const root=await proof(context), child=new Child(), held=Promise.withResolvers();let observed;
  const broker=superviseCheckpoints(child,{proof:root,prefix:'owned-fixture',upload:async(...args)=>{observed=args;return held.promise;}});
  child.emit('message',request());
  while(!observed) await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(child.replies,[]);
  assert.deepEqual(observed[1].map(path=>brokerPaths.basename(path)).sort(),['checkpoint.json','chrome-stderr.log','metrics.json','owned-browser-pid.json']);
  assert.deepEqual(observed[3],{retentionDays:1,compressionLevel:1});
  held.resolve(artifact);const result=await broker.finish();
  assert.equal(result.errors.length,0);assert.equal(child.replies[0].ok,true);assert.equal(child.replies[0].stage,'normal-before-recovery');
  assert.equal(JSON.parse(await brokerFiles.readFile(brokerPaths.join(root,'checkpoint-receipt-1.json'),'utf8')).artifact.id,123);
});
test('missing finalization, upload refusal and expired completion never produce success or retry',async context=>{
  for(const mode of ['empty','reject','late']){
    const root=await proof(context),child=new Child();let calls=0;
    const broker=superviseCheckpoints(child,{proof:root,prefix:`failure-${mode}`,uploadBudgetMs:mode==='late'?10:45000,
      upload:async()=>{calls++;if(mode==='reject')throw new Error('simulated signed URL must not be copied');if(mode==='late')await new Promise(resolve=>setTimeout(resolve,40));return mode==='empty'?{}:artifact;}});
    child.emit('message',request());const result=await broker.finish();
    assert.equal(result.receipts.length,0);assert.ok(result.errors.length);assert.equal(child.replies[0].ok,false);assert.ok(calls <= 1);
    assert.equal(JSON.stringify(result).includes('signed URL'),false);
  }
});
test('stage reordering, duplicate sequence and reused artifact identity fail closed',async context=>{
  for(const mode of ['reorder','duplicate','reuse']){
    const root=await proof(context),child=new Child();let calls=0;
    const broker=superviseCheckpoints(child,{proof:root,prefix:`order-${mode}`,upload:async()=>{calls++;return artifact;}});
    if(mode==='reorder')child.emit('message',request(1,'final-before-close'));
    else{
      child.emit('message',request());
      await new Promise(resolve=>child.once('reply',resolve));
      child.emit('message',request(mode==='duplicate'?1:2,'final-before-close'));
    }
    const result=await broker.finish();assert.ok(result.errors.length);assert.equal(child.replies.at(-1).ok,false);
    assert.equal(calls,mode==='reorder'?0:mode==='duplicate'?1:2);
  }
});
test('generated checkpoint refuses symlinks and missing normal-recording ownership before upload',async context=>{
  for(const mode of ['link','owner']){
    const root=await proof(context),child=new Child();let calls=0,selected=root;
    if(mode==='link'){
      selected=brokerPaths.join(root,'linked-proof');
      await brokerFiles.symlink(root,selected,'junction');
    }else await brokerFiles.unlink(brokerPaths.join(root,'owned-browser-pid.json'));
    const broker=superviseCheckpoints(child,{proof:selected,prefix:`paths-${mode}`,upload:async()=>{calls++;return artifact;}});
    child.emit('message',request());const result=await broker.finish();assert.ok(result.errors.length);assert.equal(calls,0);
  }
});
test('client rejects a receipt for a different phase and removes its listeners',async()=>{
  const channel=new EventEmitter();channel.send=value=>queueMicrotask(()=>channel.emit('message',{kind:'rushes-checkpoint-result',sequence:value.sequence,stage:'final-before-close',ok:true,artifact}));
  await assert.rejects(requestCheckpoint(channel,1,'normal-before-recovery'),/not confirmed/);
  assert.equal(channel.listenerCount('message'),0);assert.equal(channel.listenerCount('disconnect'),0);
});
test('pinned upload worker is terminated and positively reaped when its bounded request stalls',async context=>{
  const root=await proof(context),script=brokerPaths.join(root,'idle-upload.cjs');
  await brokerFiles.writeFile(script,"process.on('message',()=>{}); setInterval(()=>{},1000);\n");
  let owned;
  await assert.rejects(uploadInWorker({},{signal:new AbortController().signal,expires:performance.now()+80},()=>{
    owned=brokerProcesses.fork(script,[],{execPath:process.execPath,stdio:['ignore','ignore','ignore','ipc']});return owned;
  }),/deadline/);
  assert.ok(owned.exitCode!==null||owned.signalCode!==null);
});
test('a worker error cannot stand in for its later close acknowledgement',async()=>{
  const worker = new EventEmitter(); Object.assign(worker,{exitCode:null,signalCode:null,pid:123});
  let closed=false;worker.kill=()=>{setTimeout(()=>{closed=true;worker.signalCode='SIGKILL';worker.emit('close',null,'SIGKILL');},25);};
  await assert.rejects(uploadInWorker({},{signal:new AbortController().signal,expires:performance.now()+1000},()=>{
    setImmediate(()=>worker.emit('error',new Error('generated worker failure')));return worker;
  }),/process error/);
  assert.equal(closed,true);
});
test('artifact output requires a unique finalized identity and handles the actual CRLF file protocol',()=>{
  const line=(name,value)=>`${name}<<ghadelimiter_fixture\r\n${value}\r\nghadelimiter_fixture\r\n`;
  const valid=line('artifact-id','123')+line('artifact-digest','a'.repeat(64))+line('artifact-url','https://github.com/generated');
  assert.deepEqual(parseArtifactOutput(valid),{id:123,digest:'a'.repeat(64),size:null});
  for(const invalid of [valid+line('artifact-id','124'),line('artifact-id','123'),valid.replace('ghadelimiter_fixture\r\n123','different\r\n123'),valid.replace('123','0')])
    assert.throws(()=>parseArtifactOutput(invalid));
});
test('Windows module-path casing is restored exactly once from the observed parent',()=>{
  const env=matrixChildEnvironment({PSModulePath:'wrong',PsModulePath:'also-wrong',RUSHES_MATRIX_PS_MODULE_PATH:'observed',ACTIONS_RUNTIME_TOKEN:'never'});
  assert.deepEqual(Object.keys(env).filter(key=>key.toLowerCase()==='psmodulepath'),['PSModulePath']);
  assert.equal(env.PSModulePath,'observed');assert.equal(env.ACTIONS_RUNTIME_TOKEN,undefined);
  assert.throws(()=>matrixChildEnvironment({}),/observed/);
});
test('runtime credential keys stay out of the matrix child environment',()=>{
  assert.deepEqual(withoutCredentials({PATH:'fixture-path',SYSTEMROOT:'fixture-root',RUSHES_M1_PROOF:'fixture-proof',
    ACTIONS_RUNTIME_TOKEN:'fixture-value',GH_TOKEN:'fixture-value',CLOUD_SECRET:'fixture-value',STRIPE_API_KEY:'fixture-value',AWS_ACCESS_KEY_ID:'fixture-value',INPUT_NODE:'fixture-value'}),
  {PATH:'fixture-path',SYSTEMROOT:'fixture-root',RUSHES_M1_PROOF:'fixture-proof'});
});
test('owned child does not import media until the parent persists ownership and releases it',async context=>{
  const root=await proof(context),bootstrap=brokerPaths.join(root,'matrix-checkpoint-child.mjs'),marker=brokerPaths.join(root,'entered.json');
  await brokerFiles.copyFile(new URL('./matrix-checkpoint-child.mjs',import.meta.url),bootstrap);
  await brokerFiles.writeFile(brokerPaths.join(root,'matrix.mjs'),`import * as fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'owned generated stub entered');\n`);
  const child=brokerProcesses.fork(bootstrap,[],{execPath:process.execPath,env:withoutCredentials(process.env),stdio:['ignore','ignore','ignore','ipc']});
  const ended=new Promise(resolve=>child.once('close',code=>resolve(code)));
  context.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended;});
  await waitForOwnedReady(child,ended,performance.now()+2000);
  await assert.rejects(brokerFiles.stat(marker),{code:'ENOENT'});
  child.send({kind:'begin-owned-matrix'});assert.equal(await ended,0);
  assert.equal(await brokerFiles.readFile(marker,'utf8'),'owned generated stub entered');
});
test('startup receipt freezes only supervisor facts before any child or media exists',async context=>{
  const root=await proof(context);
  await brokerFiles.writeFile(brokerPaths.join(root,'supervisor-owner.json'),JSON.stringify({supervisorPid:123,state:'before-child-start'}));
  await brokerFiles.writeFile(brokerPaths.join(root,'uploader-tool.json'),JSON.stringify({expectedProgram:'generated fixture'}));
  let calls=0;
  const receipt=await supervisorSnapshot(root,'supervisor-startup',{prefix:'startup-fixture',upload:async(name,files)=>{
    calls++;assert.deepEqual(files.map(file=>brokerPaths.basename(file)).sort(),['checkpoint.json','supervisor-owner.json','uploader-tool.json']);return artifact;
  }});
  assert.equal(calls,1);assert.equal(receipt.stage,'supervisor-startup');assert.match(receipt.scope,/never satisfies/);
});
test('deadline snapshot retains explicit missing and invalid evidence without qualifying it',async context=>{
  const root=await proof(context);
  for(const name of ['supervisor-owner.json','uploader-tool.json','supervisor-deadline.json'])await brokerFiles.writeFile(brokerPaths.join(root,name),'{}');
  await brokerFiles.writeFile(brokerPaths.join(root,'metrics.json'),'{unfinished');await brokerFiles.unlink(brokerPaths.join(root,'owned-browser-pid.json'));
  await supervisorSnapshot(root,'supervisor-deadline',{prefix:'deadline-fixture',upload:async(name,files,frozen)=>{
    assert.equal(files.some(file=>brokerPaths.basename(file)==='.env'),false);
    const metadata=JSON.parse(await brokerFiles.readFile(brokerPaths.join(frozen,'checkpoint.json'),'utf8'));
    assert.match(metadata.scope,/no child normal/);assert.equal(metadata.identities.find(row=>row.name==='owned-browser-pid.json').unavailable,true);
    assert.match(metadata.identities.find(row=>row.name==='metrics.json').jsonValidity,/invalid/);return artifact;
  }});
});
test('readiness requires the owned positive message and rejects premature child closure',async()=>{
  const child=new Child(),closed=Promise.withResolvers();let released=false;
  const ready=waitForOwnedReady(child,closed.promise,performance.now()+1000).then(()=>{released=true;});
  child.emit('message',{kind:'other-message'});await new Promise(resolve=>setImmediate(resolve));assert.equal(released,false);
  child.emit('message',{kind:'awaiting-owned-matrix'});await ready;assert.equal(released,true);assert.equal(child.listenerCount('message'),0);
  const failed=new Child();await assert.rejects(waitForOwnedReady(failed,Promise.resolve({actualExit:1}),performance.now()+1000),/closed before readiness/);
  assert.equal(failed.listenerCount('message'),0);
});
test('a supervisor deadline finalizes diagnostics before forced cleanup and stays fatal after an actual zero exit',async()=>{
  const events=[],closed=Promise.withResolvers();
  const result=await matrixOutcomeBeforeDeadline(closed.promise,{expires:performance.now()-1,
    beforeTerminate:async()=>{events.push('snapshot-finalized');return {artifact};},
    terminate:async()=>{events.push('terminate');const outcome={actualExit:0,signal:null,closeObserved:true};closed.resolve(outcome);return outcome;}});
  assert.deepEqual(events,['snapshot-finalized','terminate']);assert.equal(result.supervisorDeadlineExceeded,true);assert.equal(result.outcome.actualExit,0);
});
test('failed deadline upload still attempts owned cleanup without inventing a clean child exit',async()=>{
  let snapshots=0,terminations=0;
  const result=await matrixOutcomeBeforeDeadline(new Promise(()=>{}),{expires:performance.now()-1,
    beforeTerminate:async()=>{snapshots++;throw new Error('generated signed URL must remain private');},
    terminate:async()=>{terminations++;throw new Error('generated unconfirmed cleanup');}});
  assert.equal(snapshots,1);assert.equal(terminations,1);assert.equal(result.supervisorDeadlineExceeded,true);assert.equal(result.outcome,undefined);
  assert.equal(result.diagnosticError,'Error');assert.equal(result.terminationError,'Error');assert.equal(JSON.stringify(result).includes('signed URL'),false);
});
test('a natural child close within budget requires no supervisor termination',async()=>{
  const result=await matrixOutcomeBeforeDeadline(Promise.resolve({actualExit:1,signal:null,closeObserved:true}),{expires:performance.now()+1000,
    beforeTerminate:()=>{throw new Error('unexpected snapshot');},terminate:()=>{throw new Error('unexpected termination');}});
  assert.equal(result.supervisorDeadlineExceeded,false);assert.equal(result.outcome.actualExit,1);
});

// These are the actual hard-coded predicates in verification/browser-retirement.mjs.
test('independent retirement retains only the enumerated actual assertion reason', () => {
  for (const [message, reason] of [
    ['Process inventory positive control is missing', 'inventory-positive-control-missing'],
    ['Owned browser process is still present', 'owned-browser-process-present'],
    ['A Chrome command line could not be inspected', 'chrome-command-uninspectable'],
    ['Owned browser profile is still in use', 'owned-profile-in-use'],
  ]) for (const newline of ['\n', '\r\n'])
    assert.equal(retirementPredicateReason(`node:internal/assert/utils:272${newline}AssertionError [ERR_ASSERTION]: ${message}${newline}    at requireRetired`), reason);
});
test('unclassified retirement stderr remains unknown without copying private process text', () => {
  for (const stderr of [undefined, '', 'Error: taskkill failed',
    'assert.ok(condition, "Owned browser process is still present");',
    'prefix AssertionError [ERR_ASSERTION]: Owned browser profile is still in use',
    'AssertionError [ERR_ASSERTION]: unfamiliar predicate',
    ...['toString', '__proto__', 'constructor'].map(value => `AssertionError [ERR_ASSERTION]: ${value}`),
    'x'.repeat(8192) + '\nAssertionError [ERR_ASSERTION]: Owned browser process is still present'])
    assert.equal(retirementPredicateReason(stderr), 'unclassified');
  const reason = retirementPredicateReason('AssertionError [ERR_ASSERTION]: Owned browser profile is still in use\nprivate --user-data-dir=/secret-owned-profile');
  assert.equal(reason, 'owned-profile-in-use'); assert.ok(!JSON.stringify({ reason }).includes('secret-owned-profile'));
});
