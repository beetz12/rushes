import * as checks from 'node:test';
import assert from 'node:assert/strict';
import * as files from 'node:fs/promises';
import * as paths from 'node:path';
import * as operatingSystem from 'node:os';
import { matrixMedia } from './matrix-media.mjs';
import { createHash } from 'node:crypto';

checks.test('canceling fixture encoding confirms its actual owned child exits and retains completed input files', { timeout: 20000 }, async context => {
  const entropy = process.env.RUSHES_M1_ENTROPY; delete process.env.RUSHES_M1_ENTROPY;
  context.after(() => { if (entropy === undefined) delete process.env.RUSHES_M1_ENTROPY; else process.env.RUSHES_M1_ENTROPY = entropy; });
  const directory = await files.mkdtemp(paths.join(operatingSystem.tmpdir(), 'rushes-fixture-abort-'));
  context.after(() => files.rm(directory, { recursive: true }));
  const controller = new AbortController(), stages = []; let pid;
  await assert.rejects(matrixMedia(directory, { signal: AbortSignal.any([controller.signal, context.signal]),
    onStage: async (name, details) => {
      stages.push(name);
      if (name === 'encoded-fixture-spawned') { pid = details.pid; controller.abort(); }
    } }), { name: 'AbortError' });
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.ok(stages.includes('raw-fixture-ready')); assert.equal(stages.includes('encoded-fixture-ready'), false);
  assert.ok((await files.stat(paths.join(directory, 'calibration.y4m'))).size > 80000000);
  assert.ok((await files.stat(paths.join(directory, 'calibration.wav'))).size > 190000);
  // Independently retained pre-optimization bytes; see the diagnostic design note.
  for (const [name, expected] of Object.entries({
    'calibration.y4m': 'c4dc1b20c16e0067f1c941b555f29d5541b787c5a56bac2aac337fd7ff8483af',
    'calibration.wav': '5631af0475cc31f063c9500f65bb085ea8f75158d12609ba737490acc6aecee7',
  })) assert.equal(createHash('sha256').update(await files.readFile(paths.join(directory, name))).digest('hex'), expected);
});
