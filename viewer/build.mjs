import { copyFile } from 'node:fs/promises';
await copyFile(new URL('viewer.css',import.meta.url),new URL('dist/viewer.css',import.meta.url));
