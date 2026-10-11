#!/usr/bin/env node
// Existing-user OAuth deploy. Dry-run by default; --apply is an explicit external write.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile,access } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join,resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { deployWorker } from '../dist/index.js';
import { createBootstrap } from './bootstrap.mjs';
const run=promisify(execFile);
const NODE=join(homedir(),'.nvm/versions/node/v22.22.0/bin/node');
const WRANGLER=join(homedir(),'.nvm/versions/node/v22.22.0/lib/node_modules/wrangler/bin/wrangler.js');
// One explicit configured path, supplied by the verified root-session preflight; no scanning.
const OAUTH=join(homedir(),'Library/Preferences/.wrangler/config/default.toml');
try {
 const {values}=parseArgs({options:{'account-id':{type:'string'},'expected-email':{type:'string'},'worker-name':{type:'string'},'bucket-name':{type:'string'},'database-name':{type:'string'},'workers-subdomain':{type:'string'},'bootstrap-path':{type:'string'},'apply':{type:'boolean',default:false}},strict:true});
 const accountId=values['account-id'],expectedEmail=values['expected-email'];
 if(!accountId||!/^[a-f0-9]{32}$/.test(accountId)||!expectedEmail)throw new Error('Explicit account-id and expected-email are required.');
 const identityEnv={...process.env,CLOUDFLARE_ACCOUNT_ID:accountId};for(const key of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL'])delete identityEnv[key];
 const identity=await run(NODE,[WRANGLER,'whoami'],{timeout:30000,maxBuffer:65536,env:identityEnv});
 if(!identity.stdout.includes(accountId)||!identity.stdout.toLowerCase().includes(expectedEmail.toLowerCase()))throw new Error('Wrangler identity does not match the selected account and expected email.');
 const workerName=values['worker-name']??'rushes-share',bucketName=values['bucket-name']??'rushes-media',databaseName=values['database-name']??'rushes-share';
 if(![workerName,bucketName,databaseName].every(n=>/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(n)))throw new Error('Invalid selected resource names.');
 const script=await readFile(new URL('../../worker/dist/worker.js',import.meta.url),'utf8');const schemaSQL=await readFile(new URL('../../worker/schema.sql',import.meta.url),'utf8');
 const apiToken=(await readFile(OAUTH,'utf8')).match(/^oauth_token\s*=\s*"([^"\r\n]+)"\s*$/m)?.[1];
 if(!apiToken)throw new Error('The explicitly configured Wrangler OAuth credential is unavailable.');
 const base=`https://api.cloudflare.com/client/v4/accounts/${accountId}`;
 const query=async path=>{let r;try{r=await fetch(base+path,{headers:{Authorization:`Bearer ${apiToken}`},signal:AbortSignal.timeout(15000),redirect:'error'});}catch{throw new Error('Cloudflare read-only preflight failed.');}const data=await r.json();if(!r.ok||!data.success){if(data.errors?.some(e=>e.code===10042)){const error=new Error(`R2 is disabled in selected account ${accountId}; enable R2 in Cloudflare Dashboard before applying.`);error.code='R2_NOT_ENABLED';throw error;}throw new Error(`Cloudflare preflight failed (HTTP ${r.status}; code ${data.errors?.[0]?.code??'unknown'}).`);}return data.result;};
 const subdomain=values['workers-subdomain']??(await query('/workers/subdomain')).subdomain;if(typeof subdomain!=='string'||!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(subdomain))throw new Error('The selected account needs an existing workers.dev subdomain.');
 const workerURL=`https://${workerName}.${subdomain}.workers.dev`;
 const plan={accountId,identityVerified:true,expectedEmail,workerName,bucketName,databaseName,workerURL,source:'worker/dist/worker.js',schema:'worker/schema.sql',cron:'0 3 * * *',mutations:[`POST ${base}/r2/buckets (only when missing)`,`POST ${base}/d1/database (only when missing)`,`POST ${base}/d1/database/<selected-db>/query`,`PUT ${base}/workers/scripts/${workerName}`,`POST ${base}/workers/scripts/${workerName}/subdomain`,`PUT ${base}/workers/scripts/${workerName}/schedules`],checks:['HTTP /health','owner-authorized /api/setup/check']};
 try{await query('/r2/buckets');}catch(e){if(e.code==='R2_NOT_ENABLED'){console.log(JSON.stringify({ok:false,dryRun:!values.apply,writesStarted:false,plan,error:{code:e.code,message:e.message}}));process.exit(1);}throw e;}
 if(!values.apply){console.log(JSON.stringify({ok:true,dryRun:true,plan}));process.exit(0);}
 if(!values['bootstrap-path'])throw new Error('--apply requires a caller-selected bootstrap-path retained until secure import.');const bootstrapPath=resolve(values['bootstrap-path']);try{await access(bootstrapPath);throw new Error('Bootstrap path exists; preserve it and select a new path.');}catch(e){if(e.code!=='ENOENT')throw e;}
 const ownerToken=randomBytes(32).toString('base64url'),sessionSecret=randomBytes(32).toString('base64url');
 // Prepare recoverable ciphertext before mutations. No plaintext token file or console output.
 await createBootstrap(bootstrapPath,{ownerToken,sessionSecret},{accountId,workerName,bucketName,databaseName,workerURL});
 const result=await deployWorker({accountId,apiToken,workerName,bucketName,databaseName,workersSubdomain:subdomain,script,schemaSQL,ownerToken,sessionSecret});const {ownerToken:_owner,sessionSecret:_session,...publicResult}=result;
 console.log(JSON.stringify({ok:true,applied:true,result:publicResult,encryptedBootstrapPath:bootstrapPath,importRequired:true}));
} catch(e) {console.log(JSON.stringify({ok:false,error:{code:e.code??'DEPLOY_PREFLIGHT_FAILED',message:e.message&&!(e.stdout||e.stderr)?e.message:'Deploy preflight failed; no credential output was emitted.'}}));process.exitCode=1;}
