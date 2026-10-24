import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { fixtureDocument } from './fixture-document.mjs';
import { ownedTestBrowser } from './owned-test-browser.mjs';

test('synthetic document makes no implicit missing-icon request; a real missing resource still trips the guard', { timeout: 15000 }, async context => {
  const failures = [], errors = [];
  const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'fixture-document-test', configureServer(instance) {
      instance.middlewares.use((request, response, next) => {
        response.once('finish', () => { if (response.statusCode >= 400) failures.push({ path: request.url, status: response.statusCode }); });
        if (request.url === '/icon-fixture') {
          response.setHeader('Content-Type', 'text/html'); response.end(fixtureDocument('Generated <control> & "title"'));
        } else if (request.url === '/missing-icon-canary.ico') { response.statusCode = 404; response.end('Missing resource canary'); }
        else next();
      });
    } }] });
  let owned;
  try {
    await server.listen();
    owned = await ownedTestBrowser(context.signal, () => chromium.launchServer({ headless: true, timeout: 5000,
      ...(process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE ? { executablePath: process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE } : { channel: 'chrome' }) }),
      endpoint => chromium.connect(endpoint, { timeout: 5000 }));
    const page = await owned.browser.newPage();
    page.on('console', message => { if (message.type() === 'error') errors.push(message.location().url); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/icon-fixture`);
    await page.waitForLoadState('networkidle');
    assert.equal(await page.title(), 'Generated <control> & "title"');
    assert.equal(await page.locator('#root').count(), 0);
    assert.equal(await page.locator('link[rel=icon]').getAttribute('href'),
      'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'));
    assert.deepEqual(failures, []); assert.deepEqual(errors, []);
    const status = await page.evaluate(async () => (await fetch('/missing-icon-canary.ico')).status);
    assert.equal(status, 404);
    await page.waitForLoadState('networkidle');
    assert.deepEqual(failures, [{ path: '/missing-icon-canary.ico', status: 404 }]);
    assert.ok(errors.some(url => url.endsWith('/missing-icon-canary.ico')));
  } finally { await owned?.close(); await server.close(); }
});
