import { build } from 'electron-builder';
import { access } from 'node:fs/promises';
for (const f of ['../.build/release/rushcore-engine', '../.build/release/rushes']) await access(f);
const config = process.env.RUSHES_SIGN_IDENTITY
  ? { mac: { identity: process.env.RUSHES_SIGN_IDENTITY, type: 'development', notarize: false } }
  : {};
await build({ mac: ['dir'], publish: 'never', config });
