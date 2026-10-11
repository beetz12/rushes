import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createHash,randomBytes } from 'node:crypto';
import worker from '../dist/worker.js';
export class FakeD1 {
 constructor(sql){this.db=new DatabaseSync(':memory:');this.db.exec(sql);}
 prepare(sql){const stmt=this.db.prepare(sql);let values=[];return {bind(...args){values=args;return this;},async first(column){const r=stmt.get(...values);return r?(column?r[column]:r):null;},async all(){return{results:stmt.all(...values)};},async run(){const r=stmt.run(...values);return{success:true,meta:{changes:Number(r.changes)}};}};}
 async batch(statements){this.db.exec('BEGIN');try{const r=await Promise.all(statements.map(s=>s.run()));this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 close(){this.db.close();}
}
export class FakeR2 {
 objects=new Map();sessions=new Map();aborts=0;uploadedParts=[];
 object(key,data,metadata={},range){const bytes=Buffer.from(data);const etag=createHash('md5').update(bytes).digest('hex');const body=range?bytes.subarray(range.offset,range.offset+range.length):bytes;return{key,size:bytes.length,etag,httpEtag:`"${etag}"`,httpMetadata:metadata,range,body:new ReadableStream({start(c){c.enqueue(new Uint8Array(body));c.close();}}),writeHttpMetadata(h){if(metadata.contentType)h.set('Content-Type',metadata.contentType);if(metadata.cacheControl)h.set('Cache-Control',metadata.cacheControl);}};}
 async put(key,value,options){const data=typeof value==='string'?Buffer.from(value):value instanceof Uint8Array?Buffer.from(value):Buffer.from(await new Response(value).arrayBuffer());this.objects.set(key,{data,metadata:options?.httpMetadata??{}});return this.object(key,data,options?.httpMetadata);}
 async get(key,options){const v=this.objects.get(key);return v?this.object(key,v.data,v.metadata,options?.range):null;}
 async head(key){const v=this.objects.get(key);return v?this.object(key,v.data,v.metadata):null;}
 async delete(keys){for(const k of Array.isArray(keys)?keys:[keys])this.objects.delete(k);}
 async list({prefix,cursor}){const all=[...this.objects.keys()].filter(k=>k.startsWith(prefix)).sort();const start=cursor?Number(cursor):0;const page=all.slice(start,start+1000);const next=start+page.length;return{objects:page.map(key=>({key})),truncated:next<all.length,cursor:next<all.length?String(next):undefined};}
 async createMultipartUpload(key,options){const id=randomBytes(20).toString('hex');this.sessions.set(id,{key,metadata:options?.httpMetadata,parts:new Map()});return this.resumeMultipartUpload(key,id);}
 resumeMultipartUpload(key,id){const self=this;const session=this.sessions.get(id);return {uploadId:id,async uploadPart(n,body){if(!session||session.key!==key)throw new Error('missing multipart');const data=body instanceof Uint8Array?Buffer.from(body):Buffer.from(await new Response(body).arrayBuffer());const etag=createHash('md5').update(data).digest('hex');session.parts.set(n,{data,etag});self.uploadedParts.push(n);return{partNumber:n,etag};},async complete(parts){if(!session)throw new Error('missing multipart');const buffers=parts.map(p=>{const s=session.parts.get(p.partNumber);if(!s||s.etag!==p.etag)throw new Error('etag mismatch');return s.data;});const data=Buffer.concat(buffers);self.objects.set(key,{data,metadata:session.metadata??{}});self.sessions.delete(id);return self.object(key,data,session.metadata);},async abort(){self.aborts++;self.sessions.delete(id);}};}
}
export async function environment(){const db=new FakeD1(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));const env={MEDIA:new FakeR2(),DB:db,OWNER_TOKEN:'fixture-owner-'.padEnd(40,'x'),SESSION_SECRET:'fixture-session-'.padEnd(40,'x'),PUBLIC_BASE_URL:'https://share.example',MAX_UPLOAD_BYTES:String(100*1024*1024)};return {env,worker,request:(path,options={})=>worker.fetch(new Request(env.PUBLIC_BASE_URL+path,options),env),close:()=>db.close()};}
export function ownerOptions(env,method='POST',body){return {method,headers:{Authorization:`Bearer ${env.OWNER_TOKEN}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})};}
