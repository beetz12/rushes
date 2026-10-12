import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({entryPoints: [new URL('../src/upload.ts',import.meta.url).pathname],bundle:true,format:'esm',platform:'node',write:false});
const { uploadDraft, blobDigest, createLiveBackup } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
const apiBundle = await build({entryPoints: [new URL('../src/api.ts',import.meta.url).pathname],bundle:true,format:'esm',platform:'node',write:false});
const { RushesAPI } = await import(`data:text/javascript;base64,${Buffer.from(apiBundle.outputFiles[0].contents).toString('base64')}`);
globalThis.location = {origin:'http://127.0.0.1:4317'};
const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
async function fixture(options = {}) {
  const recording = new Blob([new Uint8Array([21,31,41,51,61,71,81,91,101])],{type:'video/webm'});
  const chunk = {track:'composed',sequence:0,bytes:recording.size,sha256:await blobDigest(recording),mimeType:recording.type,checkpointMs:1000};
  let manifest = {schema:'rushes.browser-recording/1',id:'local-1',title:'Protocol proof',createdAt:new Date().toISOString(),mode:'screen',state:'complete',durationMs:1000,epochMs:0,tracks:[{kind:'composed',mimeType:recording.type,startOffsetMs:0,chunks:[chunk],bytes:recording.size}],pauses:[],events:[],bubble:{x:1080,y:510,size:150},lastCheckpointMs:1000,persistent:true,backupFolder:false};
  const saved = []; const requests = []; let accepted = []; let offset = 0; let received = []; let patchCount = 0;
  const store = {load:async()=>structuredClone(manifest),save:async value=>{manifest=structuredClone(value);saved.push(structuredClone(value));},readChunk:async()=>recording,trackBlob:async()=>recording};
  async function transport(url,init={}) {
    const path = new URL(url,location.origin).pathname; const method = init.method ?? 'GET'; requests.push({path,method,headers:init.headers,credentials:init.credentials});
    if (path === '/api/recordings') return json({id:'remote-1',state:'draft'});
    if (path.endsWith('/chunks') && options.offline) throw new TypeError('Offline synthetic network');
    if (path.endsWith('/chunks')) return json({chunks:options.conflict ? [{...chunk,sha256:'a'.repeat(64)}] : accepted});
    if (path.endsWith('/chunks/grant')) return json({url:'/api/raw/0',token:'test-capability',expiresAt:new Date(Date.now()+60000).toISOString(),acknowledged:accepted.length>0});
    if (path === '/api/raw/0') { assert.equal(init.headers.Authorization,'Upload test-capability'); accepted=[chunk]; return json({acknowledged:true}); }
    if (path.endsWith('/finalize')) return json({state:'uploading',upload:{uid:'provider-1',url:'https://upload.example.test/fixture',expiresAt:new Date(Date.now()+60000).toISOString()}});
    if (path.endsWith('/process')) return json({id:'remote-1',state:'processing'});
    if (method === 'HEAD') {
      if (options.pause && !options.pause.done) { options.pause.controller.abort(new DOMException('Paused','AbortError')); options.pause.done=true; init.signal.throwIfAborted(); }
      return new Response(null,{status:200,headers:{'Upload-Offset':String(offset),'Upload-Length':String(recording.size)}});
    }
    if (method === 'PATCH') {
      assert.equal(init.credentials,'omit'); assert.equal(init.headers['X-CSRF-Token'],undefined); assert.equal(Number(init.headers['Upload-Offset']),offset);
      patchCount++; const sent = new Uint8Array(await init.body.arrayBuffer());
      if (options.disconnect && patchCount === 1) { received.push(...sent.subarray(0,4)); offset+=4; throw new TypeError('Network disconnected after partial commit'); }
      received.push(...sent); offset+=sent.length;
      return new Response(null,{status:204,headers:{'Upload-Offset':String(options.badOffset ? offset-1 : offset)}});
    }
    throw new Error(`Unexpected route ${method} ${path}`);
  }
  const api = new RushesAPI(transport); api.setSession({user:{id:'u'},csrfToken:'csrf-proof'});
  return {api,store,transport,recording,saved,requests,options,get manifest(){return manifest;},get received(){return received;}};
}
test('incremental file checksum matches SHA256 at padding and read boundaries',async()=>{
  for (const size of [0,1,55,56,63,64,65,1024**2-1,1024**2+65]) {
    const bytes = Uint8Array.from({length:size},(_,i)=>i*31%256);
    const expected = Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
    assert.equal(await blobDigest(new Blob([bytes])),expected,`length ${size}`);
  }
});
test('partial tus receipt resumes from HEAD and journals id before bytes',async()=>{
  const f=await fixture({disconnect:true}); const progress=[];
  const result=await uploadDraft({...f,id:'local-1',signal:new AbortController().signal,onProgress:value=>progress.push(value)});
  assert.equal(result.state,'processing'); assert.deepEqual(f.received,[21,31,41,51,61,71,81,91,101]);
  assert.equal(f.saved[0].cloudRecordingId,'remote-1'); assert.equal(f.manifest.upload.offset,9);
  assert.equal(f.requests.filter(item=>item.method==='HEAD').length,2);
  assert.ok(f.requests.filter(item=>item.path.startsWith('/api/')&&item.method==='POST').every(item=>item.headers['X-CSRF-Token']==='csrf-proof'));
  assert.equal(progress.at(-1).phase,'processing');
});
test('pause keeps raw acknowledgements and resumes the same cloud id',async()=>{
  const controller=new AbortController(); const f=await fixture({pause:{controller,done:false}});
  await assert.rejects(uploadDraft({...f,id:'local-1',signal:controller.signal,onProgress:()=>{}}),/Paused/);
  assert.equal(f.manifest.cloudRecordingId,'remote-1');
  await uploadDraft({...f,id:'local-1',signal:new AbortController().signal,onProgress:()=>{}});
  assert.equal(f.requests.filter(item=>item.path==='/api/raw/0').length,1);
  assert.equal(f.requests.filter(item=>item.path==='/api/recordings'&&item.method==='POST').length,1);
  assert.deepEqual(f.received,[21,31,41,51,61,71,81,91,101]);
});
test('conflicting acknowledged chunk prevents overwrite and preserves local bytes',async()=>{
  const f=await fixture({conflict:true});
  await assert.rejects(uploadDraft({...f,id:'local-1',signal:new AbortController().signal,onProgress:()=>{}}),/different bytes/);
  assert.equal(f.requests.some(item=>item.method==='PUT'),false); assert.equal((await f.store.trackBlob()).size,9);
});
test('invalid provider acknowledgement never reports processing',async()=>{
  const f=await fixture({badOffset:true});
  await assert.rejects(uploadDraft({...f,id:'local-1',signal:new AbortController().signal,onProgress:()=>{}}),/acknowledge the sent bytes/);
  assert.equal(f.requests.some(item=>item.path.endsWith('/process')),false); assert.equal(f.manifest.upload.offset,0);
});
test('API rejects missing CSRF and displays structured service errors',async()=>{
  const api=new RushesAPI(async()=>json({error:{code:'QUOTA_EXCEEDED',message:'Delete videos or wait for renewal.'}},409));
  await assert.rejects(api.checkout(),/Sign in again/);
  api.setSession({user:{id:'u'},csrfToken:'csrf'});
  await assert.rejects(api.checkout(),value=>value.code==='QUOTA_EXCEEDED'&&value.status===409);
});

async function until(check) { for (let step=0;step<400;step++) { if(check())return;await new Promise(resolve=>setTimeout(resolve,5)); } throw new Error('Protocol condition did not settle.'); }
test('live checkpoint lane coalesces many signals and acknowledges each raw chunk once',async()=>{
  const f=await fixture();await f.store.save({...f.manifest,state:'recording',cloudRecordingId:'remote-1'});let done=0;
  const lane=createLiveBackup({...f,id:'local-1',onProgress:()=>{done++;},onError:message=>{throw new Error(message);}});
  for(let checkpoint=0;checkpoint<100;checkpoint++)lane.enqueue();await until(()=>done>0);await lane.flush();await lane.cancel();
  assert.equal(f.requests.filter(item=>item.path==='/api/raw/0').length,1);assert.ok(f.requests.filter(item=>item.path.endsWith('/chunks')).length<=3);assert.equal(f.requests.some(item=>item.path.endsWith('/finalize')),false);assert.equal(f.manifest.state,'recording');
});
test('live offline failure pauses only backup and retry preserves recorded bytes',async()=>{
  const f=await fixture({offline:true});await f.store.save({...f.manifest,state:'recording',cloudRecordingId:'remote-1'});const errors=[];let done=0;
  const lane=createLiveBackup({...f,id:'local-1',onProgress:()=>{done++;},onError:message=>errors.push(message)});lane.enqueue();await until(()=>errors.length===1);
  for(let checkpoint=0;checkpoint<100;checkpoint++)lane.enqueue();assert.equal(f.manifest.state,'recording');assert.equal((await f.store.trackBlob()).size,9);assert.equal(f.requests.filter(item=>item.path.endsWith('/chunks')).length,1);
  f.options.offline=false;lane.retry();await until(()=>done>0);await lane.cancel();assert.equal(f.requests.filter(item=>item.path==='/api/raw/0').length,1);assert.equal(f.manifest.cloudRecordingId,'remote-1');
});
