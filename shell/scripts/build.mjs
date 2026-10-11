import {build} from 'esbuild';
await build({entryPoints:['src/main/index.ts'],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:'dist/main/index.cjs'});
await build({entryPoints:['src/preload/index.ts'],bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],outfile:'dist/preload/index.cjs'});
