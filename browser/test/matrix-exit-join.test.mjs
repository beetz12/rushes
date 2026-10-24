// Actual owned cleanup body with controlled command and ChildProcess event boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cleanupFiles from 'node:fs';
import { EventEmitter } from 'node:events';
const source=cleanupFiles.readFileSync(new URL('./matrix.mjs',import.meta.url),'utf8');
const begin=source.indexOf('async function killAbruptly() {'),end=source.indexOf('\nasync function rss()',begin);
assert.ok(begin>=0&&end>begin);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const actual=new AsyncFunction('process','run','bounded','evidence','child',`let processHandle=child,browser={};${source.slice(begin,end)};return {run:killAbruptly,handles:()=>({processHandle,browser})};`);
async function control(options={}) {
  const {platform='win32',commandFails=false,exitError,exited=false,noChild=false}=options;
  const commandError=Object.hasOwn(options,'commandError')?options.commandError:new Error('Owned kill refused');
  const child=noChild?undefined:Object.assign(new EventEmitter(),{pid:271,exitCode:exited?0:null,signalCode:null});
  const commands=[],joins=[],evidence={actions:[]};
  const command=(...args)=>{commands.push(args);if(!exitError)setImmediate(()=>{child.exitCode=0;child.emit('exit',0,null);});if(commandFails)throw commandError;};
  const target=await actual({platform,kill:command},async(...args)=>command(...args),async(operation,ms,label)=>{joins.push({ms,label});if(exitError)throw exitError;return operation;},evidence,child);
  return {...target,child,commands,joins,evidence,commandError};
}
test('failed owned Windows kill still joins the later real child exit and preserves command error',async()=>{
  const f=await control({commandFails:true});await assert.rejects(f.run(),error=>error===f.commandError);assert.equal(f.joins.length,1);assert.equal(f.joins[0].ms,5000);assert.equal(f.child.exitCode,0);assert.deepEqual(f.evidence.actions,[]);assert.equal(f.handles().processHandle,f.child);
});
test('owned command and exit refusal retain both errors in original order',async()=>{
  const exitError=new Error('Owned child did not exit');const f=await control({commandFails:true,exitError});await assert.rejects(f.run(),error=>error instanceof AggregateError&&error.errors.length===2&&error.errors[0]===f.commandError&&error.errors[1]===exitError);assert.equal(f.joins.length,1);assert.deepEqual(f.evidence.actions,[]);
});
test('a successful owned kill cannot become success before child exit acknowledgement',async()=>{
  const exitError=new Error('No owned exit acknowledgement');const f=await control({exitError});await assert.rejects(f.run(),error=>error===exitError);assert.equal(f.joins.length,1);assert.equal(f.joins[0].ms,5000);assert.deepEqual(f.evidence.actions,[]);assert.equal(f.handles().processHandle,f.child);
});
test('successful owned kill plus child exit retains original success marker and retires only its handles',async()=>{
  const f=await control();await f.run();assert.equal(f.commands.length,1);assert.deepEqual(f.commands[0],['taskkill',['/PID','271','/T','/F'],{timeout:5000}]);assert.equal(f.joins.length,1);assert.equal(f.evidence.actions.length,1);assert.equal(f.evidence.actions[0].kind,'abrupt-process-kill');assert.equal(f.handles().processHandle,undefined);assert.equal(f.handles().browser,undefined);
});
test('non-Windows owned process-group kill refusal also joins exit without masking failure',async()=>{
  const f=await control({platform:'darwin',commandFails:true});await assert.rejects(f.run(),error=>error===f.commandError);assert.deepEqual(f.commands,[[-271,'SIGKILL']]);assert.equal(f.joins.length,1);assert.equal(f.child.exitCode,0);assert.deepEqual(f.evidence.actions,[]);
});
test('falsy kill rejections remain failures after actual child exit',async()=>{
  for(const commandError of [undefined,null,false]){
    const f=await control({commandFails:true,commandError});let rejected=false;
    try{await f.run();}catch(error){rejected=true;assert.equal(error,f.commandError);}
    assert.equal(rejected,true);assert.equal(f.joins.length,1);assert.deepEqual(f.evidence.actions,[]);
  }
});
test('absent and already exited owned children issue no command and invent no kill marker',async()=>{
  for(const options of [{noChild:true},{exited:true}]){const f=await control(options);await f.run();assert.deepEqual(f.commands,[]);assert.deepEqual(f.joins,[]);assert.deepEqual(f.evidence.actions,[]);}
});
