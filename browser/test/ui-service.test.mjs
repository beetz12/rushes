import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {fixture,bytes,sha,ready,uploaded} from '../../browser-worker/test/fixtures.mjs';
const compile=async name=>{const output=await build({entryPoints:[fileURLToPath(new URL(`../src/${name}`,import.meta.url))],bundle:true,platform:'node',format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].contents).toString('base64')}`);};
const {RushesAPI}=await compile('api.ts');const {backupDraft,uploadDraft}=await compile('upload.ts');
function connection(f,user='alpha',options={}) {
  globalThis.location={origin:f.env.PUBLIC_BASE_URL};const requests=[];
  const transport=async (input,init={})=>{
    const url=new URL(input,location.origin);const headers=new Headers(init.headers);requests.push({path:url.pathname,method:init.method??'GET',hasCSRF:headers.has('X-CSRF-Token'),credentials:init.credentials});
    if(url.origin!==location.origin){if(options.readyOnProviderHead){options.readyOnProviderHead=false;const video=f.providers.videos.get(options.uid);video.readyToStream=true;video.duration=10;video.status.state='ready';const confirmed=await f.request(`/api/recordings/${options.recordingId}/process`,f.auth(user,'POST',{}));assert.equal(confirmed.status,200);return new Response(null,{status:403});}assert.equal(init.credentials,'omit');assert.equal(headers.has('X-CSRF-Token'),false);return new Response(null,{status:200,headers:{'Upload-Offset':String(bytes.length),'Upload-Length':String(bytes.length)}});}
    headers.set('Cookie',f.users[user].cookie);headers.set('Origin',location.origin);
    if(options.expireFirstPut&&init.method==='PUT'){options.expireFirstPut=false;f.advance(options.grantExpiry - f.now() + 1);}
    const response=await f.worker.fetch(new Request(url,{...init,headers}),f.env);
    if(options.loseProcess&&url.pathname.endsWith('/process')){options.loseProcess=false;assert.equal(response.status,200);throw new TypeError('Synthetic lost process response after server commit');}
    if(url.pathname.endsWith('/chunks/grant')&&response.ok)options.grantExpiry=Date.parse((await response.clone().json()).expiresAt);requests.at(-1).status=response.status;return response;
  };
  return {api:new RushesAPI(transport),transport,requests};
}
function local(input) {
  let manifest=structuredClone(input.manifest);const original=new Blob([bytes],{type:input.composed.mimeType});
  return {store:{load:async()=>structuredClone(manifest),save:async value=>{manifest=structuredClone(value);},readChunk:async()=>original,trackBlob:async()=>original},get manifest(){return manifest;},original};
}
test('client binary PUT satisfies actual Worker CSRF, expiry retry and verified R2 acknowledgement',async()=>{
  const f=await fixture();try{const c=connection(f,'alpha',{expireFirstPut:true});await c.api.session();const created=await c.api.create({clientId:'ui-real-seam',title:'Actual seam',mode:'screen'});const original=new Blob([bytes],{type:'video/webm;codecs=vp8,opus'});const chunk={track:'composed',sequence:0,bytes:bytes.length,sha256:sha(bytes),mimeType:original.type,checkpointMs:1000};
    const {checkpointMs:_checkpoint,...grantInput}=chunk;const grant=await c.api.grant(created.id,grantInput);const denied=await f.request(new URL(grant.url).pathname,{method:'PUT',headers:{Cookie:f.users.alpha.cookie,Origin:location.origin,Authorization:`Upload ${grant.token}`,'Content-Type':original.type},body:bytes});assert.equal(denied.status,403);assert.equal((await denied.json()).error.code,'CSRF');assert.equal(f.raw.objects.size,0);
    await backupDraft({api:c.api,store:{load:async()=>({cloudRecordingId:created.id,tracks:[{kind:'composed',chunks:[chunk]}]}),readChunk:async()=>original},id:'ui-real-seam',signal:new AbortController().signal,onProgress:()=>{}});assert.equal(f.raw.objects.size,1);assert.deepEqual([...f.raw.objects.values()][0].bytes,bytes);const puts=c.requests.filter(item=>item.method==='PUT');assert.ok(puts.every(item=>item.hasCSRF));assert.deepEqual(puts.map(item=>item.status),[401,200]);
  }finally{f.close();}
});
test('ready re-entry returns verified matching detail and leaves local bytes and cloud id unchanged',async()=>{
  const f=await fixture();try{const u=await ready(f);const c=connection(f);await c.api.session();const saved=local(u.input);const before=JSON.stringify(saved.manifest);const result=await uploadDraft({api:c.api,store:saved.store,id:saved.manifest.id,signal:new AbortController().signal,onProgress:()=>{},transport:c.transport});assert.equal(result.state,'ready');assert.equal(result.id,u.recording.id);assert.equal(JSON.stringify(saved.manifest),before);assert.equal(c.requests.some(item=>item.path.endsWith('/finalize')),false);assert.equal(f.raw.objects.size,1);
    await saved.store.save({...saved.manifest,id:'different-local-draft'});await assert.rejects(uploadDraft({api:c.api,store:saved.store,id:'different-local-draft',signal:new AbortController().signal,onProgress:()=>{},transport:c.transport}),error=>error.code==='CLOUD_RECORDING_MISMATCH');
  }finally{f.close();}
});
test('lost process response reconciles actual committed ready state on retry without repeating transition',async()=>{
  const f=await fixture();try{const u=await uploaded(f);const video=f.providers.videos.get(u.grant.uid);video.readyToStream=true;video.duration=10;video.status.state='ready';const c=connection(f,'alpha',{loseProcess:true});await c.api.session();const saved=local(u.input);
    await assert.rejects(uploadDraft({api:c.api,store:saved.store,id:saved.manifest.id,signal:new AbortController().signal,onProgress:()=>{},transport:c.transport}),error=>error.code==='NETWORK');assert.equal((await c.api.recording(u.recording.id)).state,'ready');const result=await uploadDraft({api:c.api,store:saved.store,id:saved.manifest.id,signal:new AbortController().signal,onProgress:()=>{},transport:c.transport});assert.equal(result.state,'ready');assert.equal(c.requests.filter(item=>item.path.endsWith('/process')).length,1);assert.equal(saved.manifest.cloudRecordingId,u.recording.id);assert.deepEqual(new Uint8Array(await saved.original.arrayBuffer()),bytes);
  }finally{f.close();}
});
test('failed, deleted and other-owner controls cannot become a false ready upload',async()=>{
  const f=await fixture();try{const u=await ready(f);const saved=local(u.input);const other=connection(f,'beta');await other.api.session();await assert.rejects(uploadDraft({api:other.api,store:saved.store,id:saved.manifest.id,signal:new AbortController().signal,onProgress:()=>{},transport:other.transport}),error=>error.status===404);
    const own=connection(f);await own.api.session();f.db.db.prepare("UPDATE recordings SET state='failed',error='Fixture processing failure' WHERE id=?").run(u.recording.id);const video=f.providers.videos.get(u.grant.uid);video.readyToStream=false;video.status={state:'error'};let outcome;try{outcome=await uploadDraft({api:own.api,store:saved.store,id:saved.manifest.id,signal:new AbortController().signal,onProgress:()=>{},transport:own.transport});}catch(error){outcome={state:error.code};}assert.notEqual(outcome.state,'ready');await own.api.remove(u.recording.id);await assert.rejects(uploadDraft({api:own.api,store:saved.store,id:saved.manifest.id,signal:new AbortController().signal,onProgress:()=>{},transport:own.transport}));assert.equal(saved.manifest.cloudRecordingId,u.recording.id);assert.deepEqual(new Uint8Array(await saved.original.arrayBuffer()),bytes);
  }finally{f.close();}
});

test('ready transition during an expired-provider retry still requires authenticated matching read-back',async()=>{
  const f=await fixture();try{const u=await uploaded(f);const c=connection(f,'alpha',{readyOnProviderHead:true,uid:u.grant.uid,recordingId:u.recording.id});await c.api.session();const saved=local(u.input);const result=await uploadDraft({api:c.api,store:saved.store,id:saved.manifest.id,signal:new AbortController().signal,onProgress:()=>{},transport:c.transport});assert.equal(result.state,'ready');assert.equal(result.id,u.recording.id);assert.equal(c.requests.filter(item=>item.path.endsWith('/finalize')).length,2);assert.equal(saved.manifest.cloudRecordingId,u.recording.id);
  }finally{f.close();}
});
