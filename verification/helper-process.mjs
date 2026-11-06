import { test } from 'node:test';
import assert from 'node:assert/strict';
import disk from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import childProcesses from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runOwnedHelper } from '../shell/scripts/owned-helper-build.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function generatedBuild(t, mode) {
  const directory = await disk.mkdtemp(path.join(os.tmpdir(), 'rushes-owned-build-'));
  const child = path.join(directory, 'grandchild.mjs'), parent = path.join(directory, 'parent.mjs');
  const ready = path.join(directory, 'ready.json');
  await disk.writeFile(child, "process.on('SIGTERM',()=>{});process.send({ready:true});setInterval(()=>{},1000);");
  const subgroupCode="import os,signal,sys,time;os.setpgrp();signal.signal(signal.SIGTERM,signal.SIG_IGN);print(os.getsid(0),flush=True);time.sleep(60)\n# "+directory;
  await disk.writeFile(parent, `import { fork,spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.argv[2]+'.owner',JSON.stringify({parent:process.pid}));
    if(process.argv[3]==='normal')process.stdout.write('x'.repeat(200000),()=>process.exit(0));
    else if(process.argv[3]==='separate-group') {
      const child=spawn('python3',['-c',${JSON.stringify(subgroupCode)}],{stdio:['ignore','pipe','ignore']});
      child.stdout.once('data',value=>writeFileSync(process.argv[2],JSON.stringify({parent:process.pid,grandchild:child.pid,session:Number(String(value).trim())})));
      setInterval(()=>{},1000);
    }
    else {
      const child=fork(${JSON.stringify(child)},[],{stdio:['ignore','ignore','ignore','ipc']});
      child.once('message',()=>{
        writeFileSync(process.argv[2],JSON.stringify({parent:process.pid,grandchild:child.pid}));
        if(process.argv[3]==='orphan')process.exit(0);
      });
      setInterval(()=>{},1000);
    }`);
  t.after(async()=>{
    const owner=await disk.readFile(ready+'.owner','utf8').then(JSON.parse,()=>null);
    if(owner){
      const tool=fileURLToPath(new URL('../shell/scripts/helper-session.py',import.meta.url));
      childProcesses.execFileSync('python3',[tool,String(owner.parent),'--signal','KILL'],{timeout:3000});
    }
    await disk.rm(directory,{recursive:true,force:true});
  });
  return {parent,ready,arguments:[parent,ready,mode]};
}
async function readyAt(file) {
  const until=Date.now()+3000;
  while(Date.now()<until) {
    try{return JSON.parse(await disk.readFile(file,'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw error;}
    await wait(10);
  }
  throw new Error('Generated build did not publish its barrier.');
}
function absent(pid) {
  try{process.kill(pid,0);return false;}
  catch(error){if(error.code==='ESRCH')return true;throw error;}
}
test('owned helper drains normal output with bounded retention and restores listeners',{timeout:5000},async t=>{
  const fixture=await generatedBuild(t,'normal');const cancellation=new EventEmitter();cancellation.cancelled=false;
  const signals=process.listenerCount('SIGTERM');
  const result=await runOwnedHelper(process.execPath,fixture.arguments,{cancellation,timeoutMs:2000});
  assert.equal(result.actualExitCode,0);assert.equal(result.outputBytes,200000);
  assert.equal(Buffer.byteLength(result.outputTail),65536);assert.equal(absent(result.ownedPid),true);
  assert.equal(cancellation.listenerCount('cancel'),0);assert.equal(process.listenerCount('SIGTERM'),signals);
});
test('owned helper cancellation joins a TERM-resistant grandchild after the parent exits',{timeout:5000},async t=>{
  const fixture=await generatedBuild(t,'waiting');const cancellation=new EventEmitter();cancellation.cancelled=false;
  const result=runOwnedHelper(process.execPath,fixture.arguments,{cancellation,timeoutMs:3000,stopWaitMs:50,killWaitMs:2000}).then(value=>({value}),error=>({error}));
  const children=await readyAt(fixture.ready);cancellation.cancelled=true;cancellation.emit('cancel');
  const finished=await result;assert.match(finished.error.message,/cancelled/);
  assert.equal(absent(children.parent),true);assert.equal(absent(children.grandchild),true);
  assert.equal(cancellation.listenerCount('cancel'),0);
});
test('owned helper deadline kills descendants and a successful parent cannot leave an orphan',{timeout:8000},async t=>{
  for(const mode of ['waiting','orphan']) {
    const fixture=await generatedBuild(t,mode);
    const result=runOwnedHelper(process.execPath,fixture.arguments,{timeoutMs:500,stopWaitMs:50,killWaitMs:2000}).then(value=>({value}),error=>({error}));
    const children=await readyAt(fixture.ready);const finished=await result;
    assert.match(finished.error.message,mode==='waiting'?/deadline/:/descendants/);
    assert.equal(absent(children.parent),true);assert.equal(absent(children.grandchild),true);
  }
});
test('owned helper refuses an already-cancelled build before it can spawn',{timeout:5000},async()=>{
  const cancellation=new EventEmitter();cancellation.cancelled=true;
  await assert.rejects(runOwnedHelper('/never-spawned',[],{cancellation}),/before launch/);
  assert.equal(cancellation.listenerCount('cancel'),0);
});

test('owned helper also retires a descendant that creates another group in its session',{timeout:6000},async t=>{
  const fixture=await generatedBuild(t,'separate-group');
  const result=runOwnedHelper(process.execPath,fixture.arguments,{timeoutMs:500,stopWaitMs:50,killWaitMs:2000}).then(value=>({value}),error=>({error}));
  const children=await readyAt(fixture.ready);
  t.after(async()=>{
    const tool=fileURLToPath(new URL('../shell/scripts/helper-session.py',import.meta.url));
    childProcesses.execFileSync('python3',[tool,String(children.parent),'--signal','KILL'],{timeout:3000});
    const until=Date.now()+2000;
    while(!absent(children.grandchild)&&Date.now()<until)await wait(10);
    assert.equal(absent(children.grandchild),true,'Owned fixture cleanup must confirm absence');
  });
  assert.equal(children.session,children.parent,'Generated subgroup must remain in the build-owned session');
  const finished=await result;assert.ok(finished.error);
  assert.equal(absent(children.parent),true);
  assert.equal(absent(children.grandchild),true,'Promise must wait for the separate group to retire');
});

test('owned helper forwards caller SIGTERM and retires its build before that caller exits',{timeout:8000},async t=>{
  const fixture=await generatedBuild(t,'waiting');
  const directory=path.dirname(fixture.parent),workerFile=path.join(directory,'worker.mjs'),resultFile=path.join(directory,'result.json');
  const moduleURL=new URL('../shell/scripts/owned-helper-build.mjs',import.meta.url).href;
  await disk.writeFile(workerFile,`import {runOwnedHelper} from ${JSON.stringify(moduleURL)};
    import {writeFile} from 'node:fs/promises';
    try{await runOwnedHelper(process.execPath,process.argv.slice(2),{timeoutMs:4000,stopWaitMs:50,killWaitMs:2000});}
    catch(error){await writeFile(${JSON.stringify(resultFile)},JSON.stringify({message:error.message,result:error.buildResult}));}`);
  const worker=childProcesses.spawn(process.execPath,[workerFile,...fixture.arguments],{stdio:'ignore'});
  const exited=new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('close',(code,signal)=>resolve({code,signal}));});
  t.after(async()=>{
    if(worker.exitCode===null&&worker.signalCode===null)worker.kill('SIGKILL');
    const owner=await disk.readFile(fixture.ready+'.owner','utf8').then(JSON.parse,()=>null);
    if(owner){const tool=fileURLToPath(new URL('../shell/scripts/helper-session.py',import.meta.url));childProcesses.execFileSync('python3',[tool,String(owner.parent),'--signal','KILL'],{timeout:3000});}
  });
  const children=await readyAt(fixture.ready);worker.kill('SIGTERM');
  const state=await exited;assert.equal(state.code,143);assert.equal(state.signal,null);
  const receipt=JSON.parse(await disk.readFile(resultFile,'utf8'));
  assert.match(receipt.message,/SIGTERM/);assert.equal(receipt.result.retirementConfirmed,true);
  assert.deepEqual(receipt.result.lastSessionMembers,[]);
  assert.equal(absent(children.parent),true);assert.equal(absent(children.grandchild),true);
});
