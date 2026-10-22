import { test, expect } from 'vitest';
import disk from 'node:fs/promises';
import operatingSystem from 'node:os';
import paths from 'node:path';
import { Arch } from 'electron-builder';
import { EventEmitter } from 'node:events';
import { nativeHelperBeforeSigning } from '../scripts/package-helper.mjs';

async function hookFixture(t) {
  const directory = await disk.mkdtemp(paths.join(operatingSystem.tmpdir(), 'rushes-helper-hook-'));
  t.onTestFinished(() => disk.rm(directory, { recursive: true, force: true }));
  const application = paths.join(directory, 'Rushes.app');
  const cancellation = new EventEmitter(); cancellation.cancelled = false;
  const context = { electronPlatformName: 'darwin', arch: Arch.arm64, appOutDir: directory,
    packager: { appInfo: { productFilename: 'Rushes' }, info: { cancellationToken: cancellation } } };
  async function prepared() {
    const helper = paths.join(application, 'Contents/Helpers/RushesAutomation.app/Contents');
    for (const name of ['Info.plist', 'MacOS/RushesAutomation', 'Resources/Metadata.appintents/extract.actionsdata']) {
      const file = paths.join(helper, name); await disk.mkdir(paths.dirname(file), { recursive: true });
      await disk.writeFile(file, 'Generated hook-access barrier only; never a valid or signed application.');
    }
  }
  return { context, application, cancellation, prepared };
}

test('before-sign hook awaits the helper and forwards the selected app and development identity', async t => {
  const f = await hookFixture(t), calls = [];
  const identity = 'Apple Development: Generated Local Fixture (ABCDEFGHIJ)';
  let release; const barrier = new Promise(resolve => { release = resolve; }); let entered;
  const started = new Promise(resolve => { entered = resolve; }); let finished = false;
  const hook = nativeHelperBeforeSigning({ mac: { identity } }, async (...argumentsList) => {
    calls.push(argumentsList); entered(); await barrier; await f.prepared();
  });
  const work = hook(f.context).then(() => { finished = true; });
  try { await started; expect(finished).toBe(false); }
  finally { release(); }
  await work; expect(finished).toBe(true); expect(calls).toHaveLength(1);
  const [command, argumentsList, options] = calls[0];
  expect(command).toBe('python3');
  expect(argumentsList.slice(1)).toEqual(['--app', f.application, '--sign-identity', identity, '--configuration', 'release']);
  expect(argumentsList[0]).toMatch(/scripts\/app-intents\/embed-host\.py$/);
  expect(options.cancellation).toBe(f.cancellation); expect(options.cwd).toMatch(/rushes/);
});

test('production helper intent reaches the native embedder without credential data', async t => {
  const f = await hookFixture(t), calls = [];
  const identity = 'Developer ID Application: Generated Production Fixture (ABCDEFGHIJ)';
  await nativeHelperBeforeSigning({ forceCodeSigning: true, mac: { identity } }, async (...args) => {
    calls.push(args); await f.prepared();
  })(f.context);
  expect(calls[0][1].slice(-1)).toEqual(['--production']);
  expect(calls[0][1]).toContain(identity);
  expect(Object.keys(calls[0][2]).sort()).toEqual(['cancellation', 'cwd']);
});

test('missing helper or failed native embedding refuses the containing app signing boundary', async t => {
  const f = await hookFixture(t);
  await expect(nativeHelperBeforeSigning({}, async () => {})(f.context)).rejects.toMatchObject({ code: 'ENOENT' });
  const failure = new Error('Generated compiler failure');
  await expect(nativeHelperBeforeSigning({}, async () => { throw failure; })(f.context)).rejects.toBe(failure);
});

test('cancellation before and during helper preparation prevents outer signing', async t => {
  const f = await hookFixture(t); let calls = 0;
  f.cancellation.cancelled = true;
  await expect(nativeHelperBeforeSigning({}, async () => { calls++; })(f.context)).rejects.toThrow(/before launch/);
  expect(calls).toBe(0); f.cancellation.cancelled = false;
  await expect(nativeHelperBeforeSigning({}, async () => {
    calls++; await f.prepared(); f.cancellation.cancelled = true;
  })(f.context)).rejects.toThrow(/before outer signing/);
  expect(calls).toBe(1);
});

test('unsupported platform, architecture or product cannot launch the helper compiler', async t => {
  const f = await hookFixture(t); let calls = 0;
  const hook = nativeHelperBeforeSigning({}, async () => { calls++; });
  for (const context of [ { ...f.context, electronPlatformName: 'win32' }, { ...f.context, arch: Arch.x64 },
    { ...f.context, packager: { ...f.context.packager, appInfo: { productFilename: 'Other' } } } ])
    await expect(hook(context)).rejects.toThrow();
  expect(calls).toBe(0);
});
