import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as events from 'node:events';
import * as crypto from 'node:crypto';
import * as files from 'node:fs/promises';
import * as paths from 'node:path';
import * as system from 'node:os';
import { HostedProvider, JsonJobStore } from '../dist/index.js';
const ID='abcdefghijklmnopqrstuv', SHARE='zyxwvutsrqponmlkjihgfe', PART=10485760, credential='fixture-native-credential-'.padEnd(48,'x');
const digest=body=>crypto.createHash('sha256').update(body).digest('hex');
async function fixture(t) {
  const directory=await files.mkdtemp(paths.join(system.tmpdir(),'rushes-hosted-sdk-'));
  const state={calls:[],reservations:new Map(),parts:new Map(),puts:[],complete:false,published:false,policy:{protected:false,expiresAt:null},unauthorized:false,corruptAck:false,corruptComplete:false,badReady:false,lostAck:false,redirect:false};
  let base;
  const manifest=()=>({schema:'rushes.share/1',id:SHARE,title:state.title??'Protocol fixture',status:state.published?'ready':'processing',createdAt:'2026-10-24T00:00:00Z',durationMs:state.published?1000:state.durationMs??1000,...(state.published?{video:{file:state.asset.file,bytes:state.asset.bytes,width:320,height:180}}:{})});
  const reservation=()=>({id:ID,url:`${base}/s/${SHARE}`,state:state.published?'ready':'processing',manifest:manifest()});
  const server=http.createServer(async(req,res)=>{
    try {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks),url=new URL(req.url,base);
      const json=()=>JSON.parse(body.toString()||'{}');
      state.calls.push({path:url.pathname,method:req.method,headers:req.headers,body:req.headers['content-type']==='application/json'?json():null});
      const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
      if(req.headers.authorization!==`Native ${credential}`||state.unauthorized)return send(401,{error:{message:`private ${credential}`}});
      if(state.redirect){res.writeHead(302,{location:'https://foreign.invalid/credential-target'});return res.end();}
      if(url.pathname==='/api/native/session'&&state.holdSession){state.releaseSession=()=>{if(!res.destroyed){res.writeHead(200,{'content-type':'application/json'});res.end('{}');}};return;}
      if(url.pathname==='/api/native/session')return send(200,{user:{id:'user',tenantId:'tenant',email:'fixture@example.test',name:'Fixture'},deviceId:'device',expiresAt:'2099-01-01T00:00:00Z',canUpload:true,usage:{}});
      if(url.pathname==='/api/native/recordings'&&req.method==='POST'){const value=json();const prior=state.reservations.get(value.clientId);if(prior&&JSON.stringify(prior)!==JSON.stringify(value))return send(409,{error:{message:'Conflicting identity'}});state.reservations.set(value.clientId,value);state.title=value.title;state.durationMs=value.durationMs;state.clientId=value.clientId;if(state.reserveLostAck){state.reserveLostAck=false;req.socket.destroy();return;}return send(200,reservation());}
      if(url.pathname===`/api/native/recordings/${ID}`&&req.method==='GET')return send(200,{...reservation(),sourceKind:'native',mediaKind:'r2-mp4',...(state.complete?{video:{kind:'video',file:state.asset.file,bytes:state.asset.bytes,sha256:state.asset.sha256}}:{})});
      if(url.pathname===`/api/native/recordings/${ID}`&&req.method==='PATCH'){state.title=json().title??state.title;return send(200,reservation());}
      if(url.pathname.endsWith('/assets')&&req.method==='POST'){const value=json();if(state.asset)assert.deepEqual(value,state.asset);state.asset=value;if(state.holdAssetResponse){state.assetArrived();return;}const inventory={uploadId:'fixture-upload',partBytes:PART,parts:[...state.parts].map(([partNumber,bytes])=>({partNumber,bytes:bytes.length,sha256:digest(bytes)})),expiresAt:'2099-01-01T00:00:00Z'};return send(200,state.inventory?state.inventory(inventory):inventory);}
      const part=url.pathname.match(/\/assets\/fixture-upload\/parts\/(\d+)$/);
      if(part&&req.method==='PUT'){const number=Number(part[1]);assert.equal(req.headers['content-type'],'application/octet-stream');assert.equal(digest(body),req.headers['x-part-sha256']);assert.ok(body.length<=PART);if(state.parts.has(number))assert.deepEqual(body,state.parts.get(number));state.parts.set(number,body);state.puts.push(number);if(state.lostAck){state.lostAck=false;req.socket.destroy();return;}return send(200,{partNumber:number,bytes:body.length,sha256:state.corruptAck?'0'.repeat(64):digest(body)});}
      if(url.pathname.endsWith('/fixture-upload/complete')){const actual=Buffer.concat([...state.parts].sort(([a],[b])=>a-b).map(([,bytes])=>bytes));assert.equal(actual.length,state.asset.bytes);assert.equal(digest(actual),state.asset.sha256);state.complete=true;return send(200,{kind:'video',file:state.asset.file,bytes:state.asset.bytes,sha256:state.corruptComplete?'f'.repeat(64):state.asset.sha256});}
      if(url.pathname.endsWith('/publish')){assert.equal(state.complete,true);assert.deepEqual(json().video,{file:state.asset.file,bytes:state.asset.bytes,sha256:state.asset.sha256});state.published=!state.badReady;state.title=json().title??state.title;return send(200,{...reservation(),video:{kind:'video',file:state.asset.file,bytes:state.asset.bytes,sha256:state.asset.sha256}});}
      if(url.pathname.endsWith('/share')){if(req.method==='PATCH'){const value=json();if(Object.hasOwn(value,'password'))state.policy.protected=value.password!==null;if(Object.hasOwn(value,'expiresAt'))state.policy.expiresAt=value.expiresAt;}return send(200,state.policy);}
      if(req.method==='DELETE'){state.deleted=true;return send(200,{state:'deleting'});}
      return send(404,{error:{message:'not in emulator'}});
    }catch(error){state.serverError=error;res.writeHead(500);res.end('{}');}
  });
  server.listen(0,'127.0.0.1');await events.once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await files.rm(directory,{recursive:true,force:true});assert.equal(state.serverError,undefined);});
  const store=new JsonJobStore(paths.join(directory,'jobs'));
  return {state,directory,store,base,provider:(options={})=>new HostedProvider({serviceURL:base,credential},{store,allowLocalHTTP:true,...options}),async asset(bytes=Buffer.from('opaque protocol bytes - not a playable media claim')){const file=paths.join(directory,'video.mp4');await files.writeFile(file,bytes);return{path:file,kind:'video'};}};
}
test('native setup, explicit processing reservation, actual checksum upload and idempotent publication preserve private jobs',async t=>{
  const f=await fixture(t),p=f.provider();assert.equal(p.supportsAncillaryAssets,false);assert.equal((await p.setupCheck()).provider,'hosted');
  const share=await p.reserve({title:'Native protocol',mode:'camera',durationMs:1000});assert.equal(share.manifest.status,'processing');assert.match(f.state.clientId,/^[A-Za-z0-9_-]{22}$/);
  const input=await f.asset(),asset=await p.upload(share,input);assert.equal(asset.sha256,digest(await files.readFile(input.path)));assert.deepEqual(f.state.puts,[1]);
  const ready=await p.publish(share,{video:asset,width:999,height:999,durationMs:999999});assert.equal(ready.manifest.durationMs,1000);assert.equal(ready.manifest.video.width,320);assert.equal((await p.publish(share,{video:asset,width:320,height:180,durationMs:1000})).url,ready.url);
  assert.equal((await p.get(share.id)).manifest.status,'ready');
  const saved=await files.readFile(paths.join(f.directory,'jobs',`${ID}.json`),'utf8');assert.ok(!saved.includes(credential));assert.ok(!saved.includes('Authorization'));assert.equal((await files.stat(paths.join(f.directory,'jobs',`${ID}.json`))).mode&0o777,0o600);
});
test('lost persisted acknowledgement resumes from server byte and checksum inventory, not local claims',async t=>{
  const f=await fixture(t),share=await f.provider().reserve({title:'Resume',durationMs:1000});const bytes=Buffer.alloc(PART+17,0x6a),input=await f.asset(bytes);f.state.lostAck=true;
  await assert.rejects(()=>f.provider().upload(share,input),error=>error.code==='NETWORK_ERROR');assert.deepEqual(f.state.puts,[1]);
  const progress=[];const asset=await f.provider().upload(share,{...input,onProgress:value=>progress.push(value)});assert.deepEqual(f.state.puts,[1,2]);assert.equal(progress[0].skippedParts,1);assert.equal(asset.sha256,digest(bytes));assert.equal(f.state.complete,true);
});
test('server resume inventory mismatching actual local bytes refuses before sending further parts',async t=>{
  const f=await fixture(t),p=f.provider(),s=await p.reserve({title:'Conflict'}),input=await f.asset();f.state.parts.set(1,Buffer.from('wrong persisted bytes'));
  await assert.rejects(()=>p.upload(s,input),error=>error.code==='INVALID_RESPONSE'||error.code==='PART_MISMATCH');assert.deepEqual(f.state.puts,[]);assert.equal(f.state.complete,false);
});
for(const variant of ['corruptAck','corruptComplete','badReady'])test(`native ${variant} never becomes a locally completed ready publication`,async t=>{
  const f=await fixture(t),p=f.provider(),s=await p.reserve({title:variant}),input=await f.asset();f.state[variant]=true;
  if(variant==='badReady'){const asset=await p.upload(s,input);await assert.rejects(()=>p.publish(s,{video:asset,width:320,height:180,durationMs:1000}),error=>error.code==='INVALID_RESPONSE');}
  else await assert.rejects(()=>p.upload(s,input),error=>error.code==='INVALID_RESPONSE');
  assert.equal(f.state.published,false);
});
test('cancel before upload and callback cancellation keep acknowledged bytes resumable and never delete remotely',async t=>{
  const f=await fixture(t),p=f.provider(),s=await p.reserve({title:'Cancel'}),input=await f.asset(Buffer.alloc(PART+7,0x62)),before=new AbortController();before.abort();
  await assert.rejects(()=>p.upload(s,{...input,signal:before.signal}),error=>error.code==='CANCELLED');assert.deepEqual(f.state.puts,[]);
  const controller=new AbortController();await assert.rejects(()=>p.upload(s,{...input,signal:controller.signal,onProgress:value=>{if(value.bytes>0)controller.abort();}}),error=>error.code==='CANCELLED');assert.deepEqual(f.state.puts,[1]);assert.equal(f.state.complete,false);assert.equal(f.state.deleted,undefined);
  await p.upload(s,input);assert.deepEqual(f.state.puts,[1,2]);
});
test('unauthorized failures redact server details and do not persist credentials',async t=>{
  const f=await fixture(t),p=f.provider();f.state.unauthorized=true;await assert.rejects(()=>p.setupCheck(),error=>error.status===401&&!String(error).includes(credential));assert.equal((await files.readdir(f.directory)).includes('jobs'),false);
});
test('service endpoint and returned URL stay on the pinned origin, redirects are never followed',async t=>{
  const f=await fixture(t);for(const endpoint of ['not-a-url?credential=private','http://remote.example','https://user:secret@example.test','https://example.test/?credential=private','https://example.test/path'])assert.throws(()=>new HostedProvider({serviceURL:endpoint,credential}));
  f.state.redirect=true;await assert.rejects(()=>f.provider().setupCheck(),error=>error.code==='NETWORK_ERROR');
  const calls=[];const p=f.provider({fetch:async(url,options)=>{calls.push({url,options});return Response.json({id:ID,url:`https://foreign.invalid/s/${ID}`,state:'processing',manifest:{schema:'rushes.share/1',id:SHARE,status:'processing',createdAt:'2026-10-24',title:'Cross origin',durationMs:1}});}});
  await assert.rejects(()=>p.reserve({title:'Cross origin'}),error=>error.code==='INVALID_RESPONSE');assert.equal(calls.length,1);assert.equal(calls[0].options.redirect,'error');assert.ok(calls[0].options.signal instanceof AbortSignal);
});
test('native policy, metadata and pending delete use exact authenticated native routes',async t=>{
  const f=await fixture(t),p=f.provider(),s=await p.reserve({title:'Policy'});assert.deepEqual(await p.getPolicy(ID),{protected:false,expiresAt:null});assert.deepEqual(await p.updatePolicy(ID,{password:'fixture-password',expiresAt:'2099-01-01T00:00:00Z'}),{protected:true,expiresAt:'2099-01-01T00:00:00Z'});assert.deepEqual(await p.updatePolicy(ID,{password:null,expiresAt:null}),{protected:false,expiresAt:null});
  const asset=await p.upload(s,await f.asset());await p.publish(s,{video:asset,width:320,height:180,durationMs:1000});const next=await p.updateMetadata(s,{title:'Changed',credential:'must-not-send'});assert.equal(next.manifest.title,'Changed');assert.deepEqual(f.state.calls.filter(value=>value.path.endsWith('/publish')).at(-1).body,{video:{file:asset.file,bytes:asset.bytes,sha256:asset.sha256},title:'Changed'});
  await p.delete(next);assert.equal(f.state.deleted,true);assert.equal(await f.store.read(ID),undefined);assert.ok(f.state.calls.every(value=>value.path.startsWith('/api/native/')));
});
test('unsupported ancillary upload fails before filesystem or network access',async t=>{const f=await fixture(t),p=f.provider(),s=await p.reserve({title:'Video only'});const count=f.state.calls.length;await assert.rejects(()=>p.upload(s,{kind:'poster',path:'/missing/private.jpg'}),error=>error.code==='SHARE_FEATURE_UNSUPPORTED');assert.equal(f.state.calls.length,count);});

for(const [label,alter] of [
  ['null',()=>null],['wrong chunk bound',value=>({...value,partBytes:1})],
  ['expired',value=>({...value,expiresAt:'2000-01-01T00:00:00Z'})],
  ['duplicate part',value=>({...value,parts:[{partNumber:1,bytes:3,sha256:'0'.repeat(64)},{partNumber:1,bytes:3,sha256:'0'.repeat(64)}]})],
  ['out of range',value=>({...value,parts:[{partNumber:2,bytes:3,sha256:'0'.repeat(64)}]})],
  ['upload path injection',value=>({...value,uploadId:'../outside'})],
])test(`malformed ${label} inventory never sends or completes a part`,async t=>{const f=await fixture(t),p=f.provider(),s=await p.reserve({title:'Invalid inventory'});f.state.inventory=alter;const input=await f.asset(Buffer.from('abc'));await assert.rejects(()=>p.upload(s,input),error=>error.code==='INVALID_RESPONSE');assert.deepEqual(f.state.puts,[]);assert.equal(f.state.complete,false);});

test('oversized sparse video is refused before any upload request or full-file digest',async t=>{const f=await fixture(t),p=f.provider(),s=await p.reserve({title:'Oversize'}),input=await f.asset();await files.truncate(input.path,2*1024**3+1);const calls=f.state.calls.length;await assert.rejects(()=>p.upload(s,input),error=>error.code==='INVALID_FILE');assert.equal(f.state.calls.length,calls);});
test('cancelling a real pending HTTP request aborts without acknowledging bytes or completion', {timeout:3000}, async t=>{
  const f=await fixture(t),s=await f.provider().reserve({title:'Pending request'}),input=await f.asset(),controller=new AbortController();
  f.state.holdAssetResponse=true;const arrival=new Promise(resolve=>{f.state.assetArrived=resolve;});
  const operation=f.provider().upload(s,{...input,signal:controller.signal});await arrival;controller.abort();
  await assert.rejects(()=>operation,error=>error.code==='CANCELLED');assert.deepEqual(f.state.puts,[]);assert.equal(f.state.complete,false);
});
test('ready publication without matching verified media or valid server geometry is refused',async t=>{
  const f=await fixture(t),base=f.provider(),s=await base.reserve({title:'Malformed ready'}),asset=await base.upload(s,await f.asset());
  for(const alter of [value=>({...value,video:undefined}),value=>({...value,manifest:{...value.manifest,video:{...value.manifest.video,width:3000}}}),value=>({...value,id:SHARE}),value=>({...value,url:`${f.base}/s/${ID}`})]){
    const p=f.provider({fetch:async(url,options)=>{const response=await fetch(url,options);if(new URL(url).pathname.endsWith('/publish'))return Response.json(alter(await response.json()));return response;}});
    await assert.rejects(()=>p.publish(s,{video:asset,width:320,height:180,durationMs:1000}),error=>error.code==='INVALID_RESPONSE');
  }
});
test('serializing a provider cannot reveal its main-process credential',async t=>{const f=await fixture(t),p=f.provider();assert.ok(!JSON.stringify(p).includes(credential));});

test('lost reservation acknowledgement reuses a stable native take identity after restart without a second reservation',async t=>{
  const f=await fixture(t),input={clientId:'01JMACNATIVETAKE00000000001',title:'Stable take',mode:'camera',durationMs:1000};f.state.reserveLostAck=true;
  await assert.rejects(()=>f.provider().reserve(input),error=>error.code==='NETWORK_ERROR');assert.equal(f.state.reservations.size,1);
  const recovered=await f.provider().reserve(input);assert.equal(recovered.id,ID);assert.equal(f.state.reservations.size,1);
  assert.deepEqual(f.state.calls.filter(value=>value.path==='/api/native/recordings').map(value=>value.body),[input,input]);
  await assert.rejects(()=>f.provider().reserve({...input,title:'Different immutable claim'}),error=>error.status===409);assert.equal(f.state.reservations.size,1);
});

const boundedSession = {user:{id:'bounded-user',tenantId:'bounded-tenant',email:'bounded@example.test',name:'Bounded Fixture'},deviceId:'bounded-device',expiresAt:'2099-01-01T00:00:00Z',canUpload:false,usage:{}};
function responseStream(bytes, contentLength) {
  let delivered=0,cancelled=false;
  const stream=new ReadableStream({pull(controller){if(delivered===bytes.length){controller.close();return;}const end=Math.min(bytes.length,delivered+16384);controller.enqueue(bytes.slice(delivered,end));delivered=end;},cancel(){cancelled=true;}});
  const response=new Response(stream,{headers:{'Content-Type':'application/json',...(contentLength===undefined?{}:{'Content-Length':String(contentLength)})}});
  return {response,get delivered(){return delivered;},get cancelled(){return cancelled;}};
}
function boundedProvider(response) {return new HostedProvider({serviceURL:'https://bounded.example.test',credential},{fetch:async()=>response});}
test('bounded JSON accepts a legitimate300KB response with or without declared length',async()=>{
  const bytes=new TextEncoder().encode(' '.repeat(300000)+JSON.stringify(boundedSession));
  for(const length of [undefined,bytes.length]){const f=responseStream(bytes,length);assert.equal((await boundedProvider(f.response).setupCheck()).ok,true);assert.equal(f.delivered,bytes.length);}
});
test('bounded JSON refuses2MiB chunked content and cancels before consuming the entire body',async()=>{
  const bytes=new TextEncoder().encode(' '.repeat(2*1024**2)+JSON.stringify(boundedSession)),f=responseStream(bytes);
  await assert.rejects(()=>boundedProvider(f.response).setupCheck(),error=>error.code==='INVALID_RESPONSE');assert.equal(f.cancelled,true);assert.ok(f.delivered<bytes.length,{delivered:f.delivered,total:bytes.length});
});
test('bounded JSON rejects declared oversize before reading its small body and cancels it',async()=>{
  const bytes=new TextEncoder().encode(JSON.stringify(boundedSession)),f=responseStream(bytes,2*1024**2);
  await assert.rejects(()=>boundedProvider(f.response).setupCheck(),error=>error.code==='INVALID_RESPONSE');assert.equal(f.cancelled,true);
});
test('bounded JSON measures actual bytes even when the declared length understates2MiB content',async()=>{
  const bytes=new TextEncoder().encode(' '.repeat(2*1024**2)+JSON.stringify(boundedSession)),f=responseStream(bytes,100);
  await assert.rejects(()=>boundedProvider(f.response).setupCheck(),error=>error.code==='INVALID_RESPONSE');assert.equal(f.cancelled,true);assert.ok(f.delivered<bytes.length);
});
test('bounded JSON accepts the maximum declared chapter and summary metadata even with JSON escaping',async()=>{
  const sha256='a'.repeat(64),file=`video-${sha256.slice(0,8)}.mp4`,manifest={schema:'rushes.share/1',id:SHARE,status:'ready',createdAt:'2026-10-24T00:00:00Z',title:'\u0001'.repeat(160),summary:'\u0001'.repeat(5000),durationMs:600000,chapters:Array.from({length:500},()=>({startMs:0,title:'\u0001'.repeat(300)})),video:{file,bytes:1,width:1920,height:1080}};
  const detail={id:ID,url:`https://bounded.example.test/s/${SHARE}`,state:'ready',manifest,video:{kind:'video',file,bytes:1,sha256}},bytes=new TextEncoder().encode(JSON.stringify(detail));assert.ok(bytes.length>900000&&bytes.length<1024**2);
  const value=await boundedProvider(responseStream(bytes,bytes.length).response).get(ID);assert.equal(value.manifest.chapters.length,500);assert.equal(value.manifest.summary.length,5000);
});
test('hosted-specific chapter limits and encoded request bound refuse before network',async t=>{
  const f=await fixture(t),p=f.provider(),s=await p.reserve({title:'Metadata bounds'}),asset=await p.upload(s,await f.asset());
  for(const chapters of [Array.from({length:201},(_,i)=>({startMs:i,title:'a'})),[{startMs:0,title:'a'.repeat(201)}]]){
    const before=f.state.calls.length;await assert.rejects(()=>p.publish(s,{video:asset,width:320,height:180,durationMs:1000,chapters}),error=>error.code==='INVALID_METADATA');assert.equal(f.state.calls.length,before);
  }
  const allowed=Array.from({length:200},(_,i)=>({startMs:i,title:'a'.repeat(200)}));await p.publish(s,{video:asset,width:320,height:180,durationMs:1000,chapters:allowed});
  const before=f.state.calls.length,escaped=allowed.map(chapter=>({...chapter,title:'\u0001'.repeat(200)}));
  await assert.rejects(()=>p.publish(s,{video:asset,width:320,height:180,durationMs:1000,chapters:escaped}),error=>error.code==='INVALID_METADATA');assert.equal(f.state.calls.length,before);
});
