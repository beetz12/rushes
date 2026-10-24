import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as mixerProofCompiler from 'esbuild';
import * as mixerProofFiles from 'node:fs/promises';
import * as mixerProofSystem from 'node:os';
import * as mixerProofPaths from 'node:path';
import * as mixerProofURLs from 'node:url';
const directory = await mixerProofFiles.mkdtemp(mixerProofPaths.join(mixerProofSystem.tmpdir(), 'rushes-window-mixer-'));
after(() => mixerProofFiles.rm(directory, {recursive:true,force:true}));
const built = await mixerProofCompiler.build({entryPoints:[mixerProofURLs.fileURLToPath(new URL('../src/capture/audio-mixer.ts',import.meta.url))],
  bundle:true,format:'esm',platform:'browser',write:false});
const moduleFile=mixerProofPaths.join(directory,'mixer.mjs');await mixerProofFiles.writeFile(moduleFile,built.outputFiles[0].contents);
const {createWindowAudioMixer,installAudioMixer}=await import(mixerProofURLs.pathToFileURL(moduleFile).href);
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(read) {
  const expires=performance.now()+1000;
  while(!read()){if(performance.now()>=expires)throw new Error('Actual port observation timed out');await turn();}
}
function input(endpoint,source,index=0,base=37000) {
  const left=new Float32Array(480).fill(source===0?.2:.6),right=new Float32Array(480).fill(source===0?.4:-.2);
  endpoint.postMessage({kind:'input',source,rate:48000,timestamp:base+index*10000,left,right},[left.buffer,right.buffer]);
  assert.equal(left.byteLength,0);assert.equal(right.byteLength,0);
}

test('actual queued port receipts retain transferred PCM and readiness waits for written',async()=>{
  const endpoint=createWindowAudioMixer(),rows=[];
  endpoint.onmessage=event=>rows.push(event.data);
  try {
    endpoint.postMessage({kind:'setup'});
    for(let i=0;i<3;i++)for(const source of[0,1])input(endpoint,source,i);
    assert.equal(rows.length,0,'Port delivery must not be synchronous');
    await until(()=>rows.some(row=>row.kind==='packet'));
    const packet=rows.find(row=>row.kind==='packet');
    assert.equal(packet.timestamp,37000);assert.equal(packet.sequence,0);
    assert.ok(packet.data.subarray(0,480).every(x=>Math.abs(x-.4)<1e-6));
    assert.ok(packet.data.subarray(480).every(x=>Math.abs(x-.1)<1e-6));
    assert.equal(rows.some(row=>row.kind==='ready'),false);
    endpoint.postMessage({kind:'written',sequence:0});await until(()=>rows.some(row=>row.kind==='ready'));
    assert.equal(rows.filter(row=>row.kind==='consumed').length,6);
    assert.equal(rows.filter(row=>row.kind==='packet').length<=2,true);
    endpoint.postMessage({kind:'stop'});await until(()=>rows.some(row=>row.kind==='stopped'));
    assert.equal(rows.filter(row=>row.kind==='stopped').length,1);
    assert.equal(rows.some(row=>row.kind==='error'),false);
  }finally{endpoint.terminate();endpoint.terminate();}
});

test('mixer instances have independent PCM, readiness and stop ownership',async()=>{
  const endpoints=[createWindowAudioMixer(),createWindowAudioMixer()],rows=[[],[]];
  try {
    endpoints.forEach((endpoint,i)=>{endpoint.onmessage=event=>rows[i].push(event.data);endpoint.postMessage({kind:'setup'});for(const source of[0,1])input(endpoint,source,0,37000+i*100000);});
    await until(()=>rows.every(list=>list.some(row=>row.kind==='packet')));
    assert.deepEqual(rows.map(list=>list.find(row=>row.kind==='packet').timestamp),[37000,137000]);
    endpoints[0].terminate();endpoints[1].postMessage({kind:'written',sequence:0});
    await until(()=>rows[1].some(row=>row.kind==='ready'));
    endpoints[1].postMessage({kind:'stop'});await until(()=>rows[1].some(row=>row.kind==='stopped'));
    assert.equal(rows[0].some(row=>row.kind==='stopped'),false,'Forced disposal cannot claim graceful Stop');
    assert.equal(rows[0].some(row=>row.kind==='ready'),false);
  }finally{endpoints.forEach(endpoint=>endpoint.terminate());}
});

test('forced core disposal detaches handlers and wakes a parked write without a stop receipt',async()=>{
  const channel=new MessageChannel(),rows=[];channel.port1.onmessage=event=>rows.push(event.data);
  const dispose=installAudioMixer(channel.port2);
  try{
    channel.port1.postMessage({kind:'setup'});for(const source of[0,1])input(channel.port1,source);
    await until(()=>rows.some(row=>row.kind==='packet'));
    const late=channel.port2.onmessage;dispose();dispose();
    assert.equal(channel.port2.onmessage,null);assert.equal(channel.port2.onmessageerror,null);
    late(new MessageEvent('message',{data:{kind:'written',sequence:0}}));
    late(new MessageEvent('message',{data:{kind:'stop'}}));
    await turn();await turn();
    assert.equal(rows.some(row=>['ready','timing','stopped','error'].includes(row.kind)),false);
  }finally{dispose();channel.port1.close();channel.port2.close();}
});

test('adapter termination releases both handlers and rejects even a saved caller callback',async()=>{
  const NativeChannel=MessageChannel;let owned,endpoint;const rows=[];
  globalThis.MessageChannel=class extends NativeChannel{constructor(){super();owned=this;}};
  try{
    endpoint=createWindowAudioMixer();endpoint.onmessage=event=>rows.push(event.data);endpoint.onerror=()=>assert.fail('Late failure callback');
    endpoint.postMessage({kind:'setup'});for(const source of[0,1])input(endpoint,source);
    await until(()=>rows.some(row=>row.kind==='packet'));
    const late=owned.port1.onmessage,lateError=owned.port1.onmessageerror,count=rows.length;
    endpoint.terminate();
    assert.equal(owned.port1.onmessage,null);assert.equal(owned.port1.onmessageerror,null);
    assert.equal(owned.port2.onmessage,null);assert.equal(owned.port2.onmessageerror,null);
    late(new MessageEvent('message',{data:{kind:'ready'}}));lateError(new MessageEvent('messageerror'));
    await turn();assert.equal(rows.length,count);
  }finally{endpoint?.terminate();globalThis.MessageChannel=NativeChannel;}
});

test('a core reply failure retires the core and reaches the owner transport error handler',async()=>{
  const NativeChannel=MessageChannel;let owned,endpoint;const failures=[],rows=[];
  globalThis.MessageChannel=class extends NativeChannel{constructor(){super();owned=this;this.port2.postMessage=()=>{throw new Error('Controlled reply serialization refusal');};}};
  try{
    endpoint=createWindowAudioMixer();endpoint.onmessage=event=>rows.push(event.data);endpoint.onerror=event=>failures.push(event.data);
    endpoint.postMessage({kind:'setup'});input(endpoint,0);
    await until(()=>failures.length>0);await turn();
    assert.deepEqual(failures,['Error: Controlled reply serialization refusal']);assert.deepEqual(rows,[]);
    assert.equal(owned.port2.onmessage,null);assert.equal(owned.port2.onmessageerror,null);
  }finally{endpoint?.terminate();globalThis.MessageChannel=NativeChannel;}
});

test('deserialization errors use the actual fatal protocol and cannot report ready',async()=>{
  const channel=new MessageChannel(),rows=[];channel.port1.onmessage=event=>rows.push(event.data);
  const dispose=installAudioMixer(channel.port2);
  try{
    channel.port2.dispatchEvent(new MessageEvent('messageerror'));
    await until(()=>rows.some(row=>row.kind==='stopped'));
    assert.deepEqual(rows.map(row=>row.kind),['error','timing','stopped']);
    assert.match(rows[0].message,/could not be deserialized/);
    assert.equal(channel.port2.onmessage,null);
  }finally{dispose();channel.port1.close();channel.port2.close();}
});

test('malformed actual input dispatch cannot escape the Window transport failure boundary',async()=>{
  for(const message of[undefined,null,{kind:'input',source:0,rate:48000,timestamp:37000}]){
    const endpoint=createWindowAudioMixer(),rows=[];endpoint.onmessage=event=>rows.push(event.data);
    try{
      endpoint.postMessage(message);await until(()=>rows.some(row=>row.kind==='stopped'));
      assert.deepEqual(rows.map(row=>row.kind),['error','timing','stopped']);
      assert.match(rows[0].message,/TypeError/);
    }finally{endpoint.terminate();}
  }
});

test('wrong written credits fail before readiness on the actual transport',async()=>{
  const endpoint=createWindowAudioMixer(),rows=[];endpoint.onmessage=event=>rows.push(event.data);
  try{
    endpoint.postMessage({kind:'setup'});for(const source of[0,1])input(endpoint,source);
    await until(()=>rows.some(row=>row.kind==='packet'));
    endpoint.postMessage({kind:'written',sequence:1});await until(()=>rows.some(row=>row.kind==='stopped'));
    assert.match(rows.find(row=>row.kind==='error').message,/Unexpected composed audio delivery receipt/);
    assert.equal(rows.some(row=>row.kind==='ready'),false);
  }finally{endpoint.terminate();}
});

test('a parked output cannot grow the actual mixer ring beyond its existing capacity',async()=>{
  const endpoint=createWindowAudioMixer(),rows=[];endpoint.onmessage=event=>rows.push(event.data);
  try{
    endpoint.postMessage({kind:'setup'});for(let i=0;i<30;i++)input(endpoint,0,i);
    await until(()=>rows.some(row=>row.kind==='stopped'));
    assert.match(rows.find(row=>row.kind==='error').message,/exceeded its250ms buffer/);
    assert.equal(rows.filter(row=>row.kind==='packet').length,1);
    assert.equal(rows.some(row=>row.kind==='ready'),false);
  }finally{endpoint.terminate();}
});
