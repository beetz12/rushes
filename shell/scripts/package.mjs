import {build} from 'electron-builder';
import {access} from 'node:fs/promises';
for(const f of ['../.build/release/rushcore-engine','../.build/release/rushes']) await access(f);
await build({mac:['dir'],publish:'never'});
