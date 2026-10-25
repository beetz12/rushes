import { test } from 'node:test';
import {strict as check} from 'node:assert';
import * as fs from 'node:fs/promises';
import { classifyTests } from './run-scoped-tests.mjs';
const manifest=JSON.parse(await fs.readFile(new URL('./web-tests.json',import.meta.url),'utf8'));
const files=(await fs.readdir(new URL('.',import.meta.url))).filter(name=>name.endsWith('.test.mjs'));
test('scoped gate partitions every named test and retains all shared web regressions',()=>{check.equal(classifyTests(manifest,files),manifest);});
for(const [name,mutate] of [
 ['unknown new suite',value=>[value,[...files,'new-web.test.mjs']]],
 ['duplicate classification',value=>{value.deferred.push(value.web[0]);return[value,files];}],
 ['missing shipped suite',value=>{value.web=value.web.filter(name=>name!=='ui-web.test.mjs');value.deferred.push('ui-web.test.mjs');return[value,files];}],
 ['lost shared regression',value=>{value.sharedStudioNames.pop();return[value,files];}],
 ['path traversal',value=>{value.web[0]='../foreign.test.mjs';return[value,files];}],
])test(`scoped gate refuses ${name}`,()=>check.throws(()=>classifyTests(...mutate(structuredClone(manifest)))));
