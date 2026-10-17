import * as checks from 'node:test';
import assert from 'node:assert/strict';
import { ownedTestBrowser } from './owned-test-browser.mjs';

function serverFixture() {
  const child = { pid: 123, exitCode: null, signalCode: null };
  let killed = 0;
  const server = { process: () => child, wsEndpoint: () => 'owned-fixture',
    async kill() { killed++; child.signalCode = 'SIGKILL'; } };
  return { server, child, killed: () => killed };
}
checks.test('abort closes the owned browser without waiting for a suspended page operation', async () => {
  const controller = new AbortController(), f = serverFixture();
  const owner = await ownedTestBrowser(controller.signal, async () => f.server, async () => ({}));
  controller.abort(); assert.equal(f.killed(), 1); await owner.close();
  assert.equal(f.killed(), 1); assert.equal(f.child.signalCode, 'SIGKILL');
});
checks.test('a launch that resolves after abort is retired before connect or exposure', async () => {
  const controller = new AbortController(), f = serverFixture();
  const barrier = Promise.withResolvers(); let connects = 0;
  const starting = ownedTestBrowser(controller.signal, () => barrier.promise, async () => { connects++; });
  controller.abort(); barrier.resolve(f.server);
  await assert.rejects(starting, { name: 'AbortError' });
  assert.equal(connects, 0); assert.equal(f.killed(), 1);
});
checks.test('connect failure retires only this owned process and preserves the failure', async () => {
  const controller = new AbortController(), f = serverFixture();
  await assert.rejects(ownedTestBrowser(controller.signal, async () => f.server,
    async () => { throw new Error('deliberate connect failure'); }), /deliberate connect failure/);
  assert.equal(f.killed(), 1);
});
