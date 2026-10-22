import { build } from 'electron-builder';
import { access } from 'node:fs/promises';
import { packageSigning } from './package-signing.mjs';
import { nativeHelperBeforeSigning } from './package-helper.mjs';
const config = packageSigning(process.env);
for (const f of ['../.build/release/rushcore-engine', '../.build/release/rushes']) await access(f);
config.afterPack = nativeHelperBeforeSigning(config);
await build({ mac: ['dir'], publish: 'never', config });
