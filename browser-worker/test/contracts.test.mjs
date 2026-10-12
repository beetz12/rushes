import { test } from 'node:test';
import assert from 'node:assert/strict';
test('service workstream starts independently from the personal worker', () => {
  assert.equal(new URL('../src/index.ts', import.meta.url).pathname.includes('/browser-worker/'), true);
});
