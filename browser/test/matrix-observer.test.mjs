import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { copyOpticalRegion } from './native-optical-roi.mjs';
const workerSource = await readFile(new URL('./matrix-source.worker.mjs', import.meta.url), 'utf8');
const observer = workerSource.replace("import { copyOpticalRegion } from './native-optical-roi.mjs';", '');
assert.notEqual(observer, workerSource);
for (const fault of ['copy', 'port', 'reader']) test(`source observer closes owned frames and reports ${fault} fault`, async () => {
  let closed = 0, released = false, consumed = false, canceled = false;
  const messages = [], frame = { timestamp: 100000, format: 'NV12', codedWidth: 1280, codedHeight: 720,
    displayWidth: 1280, displayHeight: 720, visibleRect: { x: 0, y: 0, width: 1280, height: 720 },
    allocationSize: () => 12288, async copyTo(bytes) {
      if (fault === 'copy') throw new Error('copy fault'); bytes.fill(0); return [{ offset: 0, stride: 256 }];
    }, close() { closed++; } };
  const reader = { async read() {
    if (fault === 'reader') throw new Error('reader fault');
    if (consumed) return { done: true }; consumed = true; return { value: frame, done: false };
  }, async cancel() { canceled = true; }, releaseLock() { released = true; } };
  const sandbox = createContext({ onmessage: null, postMessage: value => messages.push(value),
    performance, copyOpticalRegion,
  });
  runInContext(observer, sandbox);
  await sandbox.onmessage({ data: { input: { getReader: () => reader }, audioPort: {
    postMessage() { if (fault === 'port') throw new Error('port fault'); },
  } } });
  assert.equal(released, true);
  assert.equal(canceled, true);
  assert.equal(closed, fault === 'reader' ? 0 : 1);
  const error = messages.find(message => message.kind === 'observer-error');
  assert.ok(error?.message.includes(`${fault} fault`));
  assert.equal(messages.some(message => message.kind === 'ready'), false);
});
