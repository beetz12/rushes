import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
const observer = await readFile(new URL('./matrix-source.worker.mjs', import.meta.url), 'utf8');
for (const fault of ['drawing', 'port', 'reader']) test(`source observer closes owned frames and reports ${fault} fault`, async () => {
  let closed = 0, released = false, consumed = false;
  const messages = [], frame = { timestamp: 100000, close() { closed++; } };
  const reader = { async read() {
    if (fault === 'reader') throw new Error('reader fault');
    if (consumed) return { done: true }; consumed = true; return { value: frame, done: false };
  }, releaseLock() { released = true; } };
  const sandbox = createContext({ onmessage: null, postMessage: value => messages.push(value),
    performance: { timeOrigin: 0, now: () => 1 },
    OffscreenCanvas: class { getContext() { return { drawImage() {
      if (fault === 'drawing') throw new Error('drawing fault');
    }, getImageData() { return { data: new Uint8Array(64) }; } }; } },
  });
  runInContext(observer, sandbox);
  await sandbox.onmessage({ data: { input: { getReader: () => reader }, audioPort: {
    postMessage() { if (fault === 'port') throw new Error('port fault'); },
  } } });
  assert.equal(released, true);
  assert.equal(closed, fault === 'reader' ? 0 : 1);
  const error = messages.find(message => message.kind === 'observer-error');
  assert.ok(error?.message.includes(`${fault} fault`));
  assert.equal(messages.some(message => message.kind === 'ready'), false);
});
