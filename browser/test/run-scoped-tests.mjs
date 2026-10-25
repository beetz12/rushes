import {promises as scopedFiles} from 'node:fs';
import nodePaths from 'node:path';
import addresses from 'node:url';
import jobs from 'node:child_process';

export function classifyTests(manifest, actual) {
  if(manifest?.schema!=='rushes.web-tests/1') throw new Error('Unknown test manifest');
  const declared=[...manifest.web,...manifest.deferred];
  if(!manifest.web.length||!manifest.deferred.length||new Set(declared).size!==declared.length) throw new Error('Test classes must be nonempty and disjoint');
  if(declared.some(name=>!/^[-a-z0-9]+\.test\.mjs$/.test(name))) throw new Error('Only named test files are allowed');
  if([...declared].sort().join('\n')!==[...actual].sort().join('\n')) throw new Error('Every test file must be classified explicitly');
  if(!manifest.web.includes('ui-web.test.mjs')||!manifest.web.includes('ui-upload.test.mjs')) throw new Error('Shipped web suites are required');
  if(!Array.isArray(manifest.sharedStudioNames)||manifest.sharedStudioNames.length!==15||new Set(manifest.sharedStudioNames).size!==15) throw new Error('All 15 shared Studio regressions are required');
  return manifest;
}

if(process.argv[1]===addresses.fileURLToPath(import.meta.url)) {
  const directory=addresses.fileURLToPath(new URL('.',import.meta.url));
  const manifest=classifyTests(JSON.parse(await scopedFiles.readFile(nodePaths.join(directory,'web-tests.json'),'utf8')),(await scopedFiles.readdir(directory)).filter(name=>name.endsWith('.test.mjs')));
  const deferred=process.argv.slice(2);
  if(deferred.length>1||(deferred.length===1&&deferred[0]!=='--deferred')) throw new Error('Use --deferred or no arguments');
  function launch(args) {
    const nodeArguments = ['--test'];
    nodeArguments.push('--test-concurrency=1');
    for (const argument of args) nodeArguments.push(argument);
    const result = jobs.spawnSync(process.execPath, nodeArguments, {cwd: nodePaths.dirname(directory), stdio: 'inherit'});
    if (result.error) throw result.error;
    const exit = result.status;
    if (exit === 0) return;
    process.exit(typeof exit === 'number' ? exit : 1);
  }
  if(deferred.length) launch(manifest.deferred.map(name=>`test/${name}`));
  else {
    launch(manifest.web.map(name=>`test/${name}`));
    const source=await scopedFiles.readFile(nodePaths.join(directory,'ui-studio.test.mjs'),'utf8');
    for(const name of manifest.sharedStudioNames) if(!source.includes(name)&&!(name.startsWith('cloud detail ignores retired ')&&source.includes(manifest.sharedStudioTemplate))) throw new Error(`Missing shared Studio regression: ${name}`);
    const escaped=manifest.sharedStudioNames.map(name=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
    launch(['--test-name-pattern',`^(?:${escaped.join('|')})$`,'test/ui-studio.test.mjs']);
  }
}
