import * as phaseTest from 'node:test';
import * as phaseAssert from 'node:assert/strict';
import * as phaseFiles from 'node:fs';
const source=phaseFiles.readFileSync(new URL('./matrix.mjs',import.meta.url),'utf8');
const begin=source.indexOf('async function checkpointOperation('),end=source.indexOf('\nlet checkpointSequence',begin);
phaseAssert.ok(begin>=0&&end>begin);
const factory=new Function('checkpointRequested','checkpointPhase','evidence',`${source.slice(begin,end)};return checkpointOperation;`);
phaseTest.test('a failed diagnostic ledger cannot replace the actual page or RSS failure',async()=>{
 const original=new Error('generated native operation failure'),ledger=new Error('generated ledger write failure'),evidence={failures:[]};
 const operation=factory(true,async(name,lane,status)=>{if(status==='rejected')throw ledger;},evidence);
 await phaseAssert.rejects(operation('rss',async()=>{throw original;}),error=>error===original);
 phaseAssert.equal(evidence.failures.length,1);
});

phaseTest.test('RSS error evidence uses bounded native fields without copying environment or arbitrary objects',async()=>{
 const error=new Error('m'.repeat(1000));Object.assign(error,{code:'ETIMEDOUT',killed:true,signal:'SIGTERM',stderr:'s'.repeat(4000),env:{TOKEN:'credential-sentinel-never-copy'}});
 let details;const operation=factory(true,async(name,lane,status,value)=>{if(status==='rejected')details=value;},{failures:[]});
 await phaseAssert.rejects(operation('rss',async()=>{throw error;}),value=>value===error);
 phaseAssert.equal(details.code,'ETIMEDOUT');phaseAssert.equal(details.killed,true);phaseAssert.equal(details.message.length,512);phaseAssert.equal(details.stderr.length,1536);
 phaseAssert.equal(JSON.stringify(details).includes('credential-sentinel'),false);phaseAssert.equal(Object.hasOwn(details,'env'),false);
});
