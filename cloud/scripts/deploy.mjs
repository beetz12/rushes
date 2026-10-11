#!/usr/bin/env node
// Original one-click wrapper. No credential argv/env scanning, logging or plaintext state.
// A secure caller supplies and retains {apiToken, ownerToken, sessionSecret} on stdin.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { deployWorker } from '../dist/index.js';
try {
 const {values}=parseArgs({options:{'account-id':{type:'string'},'worker-name':{type:'string'},'bucket-name':{type:'string'},'database-name':{type:'string'},'workers-subdomain':{type:'string'}},strict:true});
 let secretInput='';for await(const c of process.stdin){secretInput+=c;if(secretInput.length>16384)throw new Error('Invalid input');}
 const secrets=JSON.parse(secretInput);
 if(typeof secrets.ownerToken!=='string'||typeof secrets.sessionSecret!=='string')throw new Error('A secure caller must retain pre-created Worker secrets before deployment.');
 const input={accountId:values['account-id'],workerName:values['worker-name']??'rushes-share',bucketName:values['bucket-name']??'rushes-media',databaseName:values['database-name']??'rushes-share',workersSubdomain:values['workers-subdomain'],apiToken:secrets.apiToken,ownerToken:secrets.ownerToken,sessionSecret:secrets.sessionSecret,script:await readFile(new URL('../../worker/dist/worker.js',import.meta.url),'utf8'),schemaSQL:await readFile(new URL('../../worker/schema.sql',import.meta.url),'utf8')};
 const result=await deployWorker(input);const {ownerToken:_owner,sessionSecret:_session,...safe}=result;console.log(JSON.stringify({ok:true,result:safe}));
} catch(e) {console.log(JSON.stringify({ok:false,error:{code:e.code??'INVALID_DEPLOY_INPUT',message:e.code?e.message:'Deployment requires built artifacts, selected account/subdomain and secrets from a secure caller.'}}));process.exitCode=1;}
