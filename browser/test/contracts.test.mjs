import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('browser contract never exposes owner or vendor credential fields', async () => {
  const body = await readFile(new URL('../src/contracts.ts', import.meta.url), 'utf8');
  assert.equal(/OWNER_TOKEN|STRIPE_SECRET|CLOUDFLARE_API_TOKEN/.test(body), false);
});
