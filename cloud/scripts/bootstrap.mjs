// Original encrypted bootstrap bridge. macOS Keychain protects the encryption key.
import { spawn } from 'node:child_process';
import { randomBytes,createCipheriv,createDecipheriv } from 'node:crypto';
import { mkdir,readFile,writeFile,rename,rm,stat } from 'node:fs/promises';
import { dirname } from 'node:path';
const SERVICE='com.rushes.cloud.bootstrap';
function security(args,stdin=''){return new Promise((resolve,reject)=>{const p=spawn('/usr/bin/security',args,{stdio:['pipe','pipe','pipe']});let output='';p.stdout.on('data',c=>output+=c);p.stderr.resume();p.on('error',()=>reject(new Error('Keychain service unavailable.')));p.on('close',code=>code===0?resolve(output):reject(new Error('Keychain operation failed.')));p.stdin.end(stdin);});}
export async function createBootstrap(path,secrets,metadata){const key=randomBytes(32);const account=randomBytes(16).toString('hex');const nonce=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,nonce);const ciphertext=Buffer.concat([cipher.update(JSON.stringify(secrets),'utf8'),cipher.final()]);
 // security interactive input keeps the secret key out of process arguments.
 await security(['-i'],`add-generic-password -U -a ${account} -s ${SERVICE} -w ${key.toString('hex')}\n`);
 const data={schema:'rushes.encrypted-bootstrap/1',service:SERVICE,account,nonce:nonce.toString('base64'),ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64'),metadata};
 await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=path+'.'+randomBytes(8).toString('hex')+'.tmp';try{await writeFile(temp,JSON.stringify(data),{mode:0o600});await rename(temp,path);}catch(e){await security(['delete-generic-password','-a',account,'-s',SERVICE]).catch(()=>{});throw e;}finally{key.fill(0);await rm(temp,{force:true});}return path;}
/** Call from a secure main-process importer. Never print the returned secrets. */
export async function readBootstrap(path){const info=await stat(path);if((info.mode&0o077)!==0)throw new Error('Bootstrap must be owner-only.');const b=JSON.parse(await readFile(path,'utf8'));if(b.schema!=='rushes.encrypted-bootstrap/1'||b.service!==SERVICE||!/^[a-f0-9]{32}$/.test(b.account))throw new Error('Invalid encrypted bootstrap.');const key=Buffer.from((await security(['find-generic-password','-a',b.account,'-s',SERVICE,'-w'])).trim(),'hex');try{const dec=createDecipheriv('aes-256-gcm',key,Buffer.from(b.nonce,'base64'));dec.setAuthTag(Buffer.from(b.tag,'base64'));const plain=Buffer.concat([dec.update(Buffer.from(b.ciphertext,'base64')),dec.final()]);try{return{secrets:JSON.parse(plain.toString('utf8')),metadata:b.metadata};}finally{plain.fill(0);}}finally{key.fill(0);}}
/** Only after safeStorage configuration and a distinct read-back prove import. */
export async function removeBootstrap(path){const b=JSON.parse(await readFile(path,'utf8'));if(b.schema!=='rushes.encrypted-bootstrap/1'||b.service!==SERVICE||!/^[a-f0-9]{32}$/.test(b.account))throw new Error('Invalid encrypted bootstrap.');await security(['delete-generic-password','-a',b.account,'-s',SERVICE]);await rm(path);}
