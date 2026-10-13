import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureContexts, diagnosticWithin } from './fixture-contexts.mjs';
function context() { const value=new EventEmitter();value.closed=false;value.close=async()=>{value.closed=true;value.emit('close');};return value; }
test('a fixture setup exception cannot lose ownership before returning the context',async()=>{
  const owned=fixtureContexts();let value;
  assert.throws(()=>{value=owned.own(context());throw new Error('generated navigation failure');});
  assert.equal(owned.size,1);await owned.drain(async()=>({reason:'retained setup context'}));assert.equal(value.closed,true);assert.equal(owned.size,0);
});
test('a diagnostic failure still closes every retained context; successful explicit close is not diagnosed',async()=>{
  const owned=fixtureContexts(),first=owned.own(context()),second=owned.own(context()),success=owned.own(context());
  await success.close();let visits=0;const results=await owned.drain(()=>{visits++;throw new Error('generated evidence fault');});
  assert.equal(visits,2);assert.ok(results.every(result=>result.status==='rejected'));assert.equal(first.closed,true);assert.equal(second.closed,true);assert.equal(owned.size,0);
});
test('one close failure cannot prevent the other context from closing or be reported as cleanup success',async()=>{
  const owned=fixtureContexts(),first=owned.own(context()),second=owned.own(context());first.close=()=>{throw new Error('generated close fault');};
  await assert.rejects(owned.drain(async()=>({})),AggregateError);assert.equal(second.closed,true);assert.equal(owned.size,1);
  first.close=async()=>{first.closed=true;first.emit('close');};await owned.drain(async()=>({}));assert.equal(owned.size,0);
});
test('bounded stalled diagnostics release their timer and cannot keep cleanup from running',async()=>{
  const owned=fixtureContexts(),value=owned.own(context());const results=await owned.drain(()=>diagnosticWithin(()=>new Promise(()=>{}),20));
  assert.equal(results[0].status,'rejected');assert.match(results[0].reason.message,/deadline/);assert.equal(value.closed,true);assert.equal(owned.size,0);
});
