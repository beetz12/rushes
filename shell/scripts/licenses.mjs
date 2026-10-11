import {readFile,writeFile,readdir,mkdir,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
const packageJSON=JSON.parse(await readFile('package.json','utf8'));await mkdir('licenses',{recursive:true});let rows=[];
for(const name of Object.keys({...packageJSON.dependencies,...packageJSON.devDependencies})){
 const dir=join('node_modules',name);const meta=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));
 if(!/^(MIT|BSD(-2-Clause|-3-Clause)?|Apache-2\.0|ISC|Zlib|CC0-1\.0)$/.test(meta.license))throw new Error(`Unapproved license ${name}: ${meta.license}`);
 const candidates=(await readdir(dir)).filter(f=>/^licen[cs]e(?:\.|$)/i.test(f));if(!candidates.length)throw new Error(`Missing license for ${name}`);
 const file=`${name.replaceAll('/','-').replace('@','')}-${meta.version}.txt`;await copyFile(join(dir,candidates[0]),join('licenses',file));rows.push(`| ${name} | ${meta.version} | ${meta.license} | shell/licenses/${file} | npm direct dependency; bundled when runtime |`);
}
await writeFile('DEPENDENCIES.md','# Desktop dependency notices\n\nAll shell code is original. No reference repository code was copied. Versions are locked in package-lock.json. Full notices accompany the application.\n\n| Package | Version | License | License file | Use |\n|---|---|---|---|---|\n'+rows.join('\n')+'\n');console.log(`Saved notices for ${rows.length} direct dependencies.`);
