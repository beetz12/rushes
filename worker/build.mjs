import { build } from 'esbuild';
import { readFile,mkdir } from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['src/index.ts'],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:'dist/worker.js',define:{VIEWER_JS:JSON.stringify(await readFile('../viewer/dist/viewer.js','utf8')),VIEWER_CSS:JSON.stringify(await readFile('../viewer/dist/viewer.css','utf8'))}});
