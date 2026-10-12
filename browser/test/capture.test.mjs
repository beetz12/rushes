import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
let server, browser, origin;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  server.middlewares.use('/capture-fixture', (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Rushes synthetic capture test</title>'); });
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ ...(process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE ? { executablePath: process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE } : { channel: process.env.RUSHES_CAPTURE_BROWSER || 'chrome' }), headless: true });
  console.log(`Capture runtime ${browser.version()}; isolated synthetic media only.`);
});
after(async () => { await browser?.close(); await server?.close(); });
async function pageFixture(callback) {
  const context = await browser.newContext(); const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try { await page.goto(`${origin}/capture-fixture`); await callback(page); assert.deepEqual(errors, []); }
  finally { await context.close(); }
}
test('pause during the startup checkpoint retains the health watcher across resume and releases it on cancel', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { fixture } = await import('/test/capture-fixture.mjs');
    const value = await fixture();
    const save = value.store.save, interval = window.setInterval, clear = window.clearInterval;
    let entered, releaseSave, held = false;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { releaseSave = resolve; });
    const watchers = new Set(), releasedWatchers = [], installed = [];
    value.store.save = async manifest => {
      if (!held && manifest.state === 'recording') { held = true; entered(); await gate; }
      return save(manifest);
    };
    window.setInterval = function(callback, milliseconds, ...args) {
      const id = interval.call(this, callback, milliseconds, ...args);
      if (milliseconds === 1000) { watchers.add(id); installed.push(id); }
      return id;
    };
    window.clearInterval = function(id) {
      if (watchers.delete(id)) releasedWatchers.push(id);
      return clear.call(this, id);
    };
    try {
      const starting = value.session.start(); await ready;
      await value.session.pause(); releaseSave(); await starting;
      const paused = { installs: installed.length, active: watchers.size, state: value.states.at(-1) };
      await value.session.resume();
      const resumed = { installs: installed.length, active: watchers.size, state: value.states.at(-1) };
      await value.session.cancel();
      return { paused, resumed, released: releasedWatchers.length, activeAfterCancel: watchers.size,
        states: value.states, retainedDrafts: (await value.store.list()).length };
    } finally {
      releaseSave(); await value.session.cancel(); await value.cleanup();
      window.setInterval = interval; window.clearInterval = clear;
    }
  });
  assert.deepEqual(result.paused, { installs: 1, active: 1, state: 'paused' });
  assert.deepEqual(result.resumed, { installs: 1, active: 1, state: 'recording' });
  assert.equal(result.released, 1); assert.equal(result.activeAfterCancel, 0); assert.equal(result.retainedDrafts, 0);
  assert.deepEqual(result.states, ['recording', 'paused', 'recording', 'failed']);
}));
test('screen/camera composition, separate originals, mixed audio, pause timeline, moved bubble, and final chunks decode', { timeout: 45000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { fixture, inspectVideo, inspectAudio } = await import('/test/capture-fixture.mjs');
    const value = await fixture(); await value.session.start();
    await new Promise(resolve => setTimeout(resolve, 2200)); await value.session.pause();
    await new Promise(resolve => setTimeout(resolve, 700)); value.session.setBubble({ x: 100, y: 100, size: 180 });
    await value.session.resume(); await new Promise(resolve => setTimeout(resolve, 2100));
    const manifest = await value.session.stop();
    const data = {};
    for (const track of manifest.tracks) {
      const blob = await value.store.trackBlob(value.id, track.kind);
      data[track.kind] = ['microphone', 'tab-audio'].includes(track.kind) ? await inspectAudio(blob) : await inspectVideo(blob, [[600, 360], [1070, 590], [190, 190]]);
    }
    const mixed = await inspectAudio(await value.store.trackBlob(value.id, 'composed'));
    const released = [...value.feeds.flatMap(feed => feed.getTracks()), ...value.session.preview.getTracks()].every(track => track.readyState === 'ended');
    await value.cleanup(); return { manifest, data, mixed, released, states: value.states, finalCheckpoint: value.checkpoints.at(-1) };
  });
  console.log('Calibration offsets/durations', result.manifest.tracks.map(track => [track.kind, track.startOffsetMs, result.data[track.kind].duration]), result.manifest.durationMs);
  assert.equal(result.manifest.state, 'complete'); assert.equal(result.released, true);
  assert.deepEqual(result.manifest.tracks.map(track => track.kind), ['screen', 'camera', 'microphone', 'tab-audio', 'composed']);
  assert.deepEqual(result.states, ['recording', 'paused', 'recording', 'stopping', 'complete']);
  assert.equal(result.finalCheckpoint.state, 'complete'); assert.equal(result.manifest.pauses.length, 1);
  assert.ok(result.manifest.pauses[0].endMs - result.manifest.pauses[0].startMs >= 650);
  assert.ok(result.manifest.durationMs > 4000 && result.manifest.durationMs < 4900);
  for (const track of result.manifest.tracks) {
    assert.ok(track.startOffsetMs >= 0 && track.startOffsetMs < 150);
    assert.ok(track.bytes > 0 && track.chunks.length >= 2);
    assert.ok(track.chunks.every((chunk, index) => chunk.sequence === index && /^[a-f0-9]{64}$/.test(chunk.sha256)));
  }
  assert.ok(Math.max(...result.manifest.tracks.map(track => track.startOffsetMs)) - Math.min(...result.manifest.tracks.map(track => track.startOffsetMs)) <= 100);
  assert.deepEqual([result.data.composed.width, result.data.composed.height], [1280, 720]);
  // Red camera is baked into the first corner, then moves to the opposite one.
  assert.ok(result.data.composed.samples[0][1][0] > 160 && result.data.composed.samples[0][1][2] < 100);
  assert.ok(result.data.composed.samples.at(-1)[2][0] > 160 && result.data.composed.samples.at(-1)[2][2] < 100);
  assert.ok(result.data.composed.samples.at(-1)[1][2] > 160);
  assert.ok(result.mixed.powers.every(power => power > 0.025));
  assert.ok(result.data.microphone.powers[0] > 0.08 && result.data.microphone.powers[1] < 0.01);
  assert.ok(result.data['tab-audio'].powers[1] > 0.08 && result.data['tab-audio'].powers[0] < 0.01);
  for (const info of Object.values(result.data)) assert.ok(Math.abs(info.duration * 1000 - result.manifest.durationMs) < 250);
}));
test('late first camera frame stays in preflight and all recording tracks begin together', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { fixture, inspectVideo } = await import('/test/capture-fixture.mjs');
    const before = performance.now();
    const value = await fixture('screen-camera', true, false, undefined, 700);
    const preparationMs = performance.now() - before;
    try {
      await value.session.start();
      await new Promise(resolve => setTimeout(resolve, 1200));
      const manifest = await value.session.stop();
      const videos = {};
      for (const kind of ['screen', 'camera', 'composed']) videos[kind] = await inspectVideo(await value.store.trackBlob(value.id, kind));
      return { preparationMs, manifest, videos };
    } finally { await value.session.cancel(); await value.cleanup(); }
  });
  assert.ok(result.preparationMs >= 650, `Preflight resolved before the first camera frame: ${result.preparationMs}ms`);
  assert.equal(result.manifest.state, 'complete');
  assert.ok(result.manifest.durationMs >= 1200 && result.manifest.durationMs < 1500);
  const offsets = result.manifest.tracks.map(track => track.startOffsetMs);
  assert.ok(Math.max(...offsets) - Math.min(...offsets) <= 100, JSON.stringify(offsets));
  for (const info of Object.values(result.videos)) assert.ok(Math.abs(info.duration * 1000 - result.manifest.durationMs) < 250);
}));
test('source loss before first composition output rejects preflight and releases every input without a draft', { timeout: 15000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { createCaptureSession } = await import('/src/capture/index.ts');
    const { createDraftStore } = await import('/src/capture/storage.ts');
    const screenCanvas = document.createElement('canvas'); screenCanvas.width = 640; screenCanvas.height = 360;
    const screen = screenCanvas.captureStream(0), screenTrack = screen.getVideoTracks()[0];
    const screenContext = screenCanvas.getContext('2d');
    const ticking = setInterval(() => { screenContext.fillRect(0, 0, 640, 360); screenTrack.requestFrame(); }, 33);
    const cameraCanvas = document.createElement('canvas'); cameraCanvas.width = 640; cameraCanvas.height = 360;
    const camera = cameraCanvas.captureStream(0), cameraTrack = camera.getVideoTracks()[0];
    const store = await createDraftStore(), id = crypto.randomUUID(), before = performance.now();
    const ending = setTimeout(() => { cameraTrack.stop(); cameraTrack.dispatchEvent(new Event('ended')); }, 100);
    let session, error;
    try { session = await createCaptureSession({ id, title: 'Preflight source loss', mode: 'screen-camera', screen, camera, store, persistent: false, backupFolder: false }); }
    catch (value) { error = value.message; }
    finally { clearInterval(ticking); clearTimeout(ending); if (session) await session.cancel(); }
    return { error, preparationMs: performance.now() - before, released: [screenTrack, cameraTrack].every(track => track.readyState === 'ended'), drafts: await store.list() };
  });
  assert.match(result.error ?? '', /source ended|source closed/i);
  assert.ok(result.preparationMs < 1500, `Source loss waited for the initialization deadline: ${result.preparationMs}ms`);
  assert.equal(result.released, true); assert.deepEqual(result.drafts, []);
}));
test('active-time deadline stays under the hard ceiling across pause; delayed controls preserve an interrupted take', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { fixture, inspectVideo } = await import('/test/capture-fixture.mjs');
    const { BROWSER_LIMITS } = await import('/src/contracts.ts');
    const originalLimit = BROWSER_LIMITS.maxTakeSeconds, rows = [];
    BROWSER_LIMITS.maxTakeSeconds = 1;
    try {
      for (const behavior of ['normal', 'paused', 'delayed']) {
        const value = await fixture(); const wallStart = performance.now();
        try {
          await value.session.start();
          if (behavior === 'paused') {
            await new Promise(resolve => setTimeout(resolve, 250)); await value.session.pause();
            await new Promise(resolve => setTimeout(resolve, 400)); await value.session.resume();
          } else if (behavior === 'delayed') {
            await new Promise(resolve => setTimeout(resolve, 650));
            const blockedUntil = performance.now() + 450;
            while (performance.now() < blockedUntil) { /* Intentional main-loop scheduling fault. */ }
          }
          for (let attempts = 0; attempts < 100 && !value.states.some(state => ['complete', 'interrupted'].includes(state)); attempts++)
            await new Promise(resolve => setTimeout(resolve, 25));
          const automatic = value.states.includes('stopping');
          const manifest = await value.session.stop();
          const decoded = behavior === 'delayed' ? undefined : await inspectVideo(await value.store.trackBlob(value.id, 'composed'));
          rows.push({ behavior, manifest, decoded, automatic, wallMs: performance.now() - wallStart,
            released: value.feeds.flatMap(feed => feed.getTracks()).every(track => track.readyState === 'ended') });
        } finally { await value.session.cancel(); await value.cleanup(); }
      }
    } finally { BROWSER_LIMITS.maxTakeSeconds = originalLimit; }
    return rows;
  });
  for (const row of result) {
    assert.equal(row.automatic, true); assert.equal(row.released, true);
    assert.ok(row.manifest.tracks.every(track => track.bytes > 0));
    if (row.behavior === 'delayed') {
      assert.equal(row.manifest.state, 'interrupted'); assert.ok(row.manifest.durationMs > 1000);
      assert.match(row.manifest.recoveryNote, /delayed beyond the take limit/);
    } else {
      assert.equal(row.manifest.state, 'complete');
      assert.ok(row.manifest.durationMs >= 750 && row.manifest.durationMs <= 1000, String(row.manifest.durationMs));
      assert.ok(Math.abs(row.decoded.duration * 1000 - row.manifest.durationMs) <= 250);
      if (row.behavior === 'paused') { assert.equal(row.manifest.pauses.length, 1); assert.ok(row.wallMs > 1150); }
    }
  }
}));
test('screen without audio and camera-only captures produce playable originals; rapid Stop waits for final data', { timeout: 30000 }, async () => pageFixture(async page => {
  const results = await page.evaluate(async () => {
    const { fixture, inspectVideo } = await import('/test/capture-fixture.mjs');
    const results = [];
    for (const mode of ['screen', 'camera']) {
      const value = await fixture(mode, false, false, `private-reservation-${mode}`); await value.session.start();
      await new Promise(resolve => setTimeout(resolve, 350));
      const [one, two] = await Promise.all([value.session.stop(), value.session.stop()]);
      const info = await inspectVideo(await value.store.trackBlob(value.id, 'composed'));
      const saved = await value.store.load(value.id);
      results.push({ manifest: one, savedCloudId: saved.cloudRecordingId, checkpointCloudIds: value.checkpoints.map(point => point.cloudRecordingId), same: JSON.stringify(one) === JSON.stringify(two), info }); await value.cleanup();
    }
    return results;
  });
  for (const result of results) {
    assert.equal(result.manifest.state, 'complete'); assert.equal(result.same, true);
    assert.equal(result.manifest.cloudRecordingId, `private-reservation-${result.manifest.mode}`);
    assert.equal(result.savedCloudId, result.manifest.cloudRecordingId);
    assert.ok(result.checkpointCloudIds.every(id => id === result.manifest.cloudRecordingId));
    assert.ok(result.info.duration > 0.2 && result.info.duration < 0.7);
    assert.equal(result.manifest.tracks.length, 2); assert.ok(result.manifest.tracks.every(track => track.chunks.length === 1 && track.bytes > 0));
  }
}));
test('cancel releases all streams and removes its draft; ended camera safely finalizes saved screen and audio', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { fixture } = await import('/test/capture-fixture.mjs');
    const canceled = await fixture('screen-camera'); await canceled.session.start();
    await new Promise(resolve => setTimeout(resolve, 100)); await canceled.session.cancel();
    const empty = await canceled.store.list();
    const ended = canceled.feeds.every(feed => feed.getTracks().every(track => track.readyState === 'ended')); await canceled.cleanup();
    const value = await fixture('screen-camera'); await value.session.start();
    await new Promise(resolve => setTimeout(resolve, 2200));
    // Track.stop itself intentionally does not dispatch ended; simulate source loss.
    const camera = value.feeds[1].getVideoTracks()[0]; camera.stop(); camera.dispatchEvent(new Event('ended'));
    await new Promise(resolve => setTimeout(resolve, 600)); const manifest = await value.session.stop();
    const bytes = await value.store.trackBlob(value.id, 'screen'); await value.cleanup();
    return { empty: empty.length, ended, manifest, bytes: bytes.size, warnings: value.warnings };
  });
  assert.equal(result.empty, 0); assert.equal(result.ended, true); assert.equal(result.manifest.state, 'interrupted');
  assert.ok(result.bytes > 0); assert.ok(result.warnings.some(warning => warning.includes('ended')));
}));
test('reload preserves acknowledged OPFS chunks and recovers the manifest without restarting capture', { timeout: 30000 }, async () => pageFixture(async page => {
  const before = await page.evaluate(async () => {
    const { fixture } = await import('/test/capture-fixture.mjs'); window.take = await fixture('screen-camera', false);
    await window.take.session.start(); await new Promise(resolve => setTimeout(resolve, 4300));
    const manifest = await window.take.store.load(window.take.id);
    return { id: window.take.id, chunks: manifest.tracks.flatMap(track => track.chunks), checkpoint: manifest.lastCheckpointMs };
  });
  assert.ok(before.chunks.length >= 4); await page.reload();
  const after = await page.evaluate(async id => {
    const { createDraftStore } = await import('/src/capture/storage.ts'); const store = await createDraftStore(); const manifest = await store.load(id);
    const digests = []; for (const chunk of manifest.tracks.flatMap(track => track.chunks)) { const blob = await store.readChunk(id, chunk); digests.push({ ...chunk, readBytes: blob.size }); }
    return { manifest, digests };
  }, before.id);
  assert.equal(after.manifest.state, 'interrupted'); assert.ok(after.manifest.recoveryNote.includes('encoder tail'));
  assert.ok(after.manifest.lastCheckpointMs >= before.checkpoint);
  assert.ok(after.manifest.durationMs >= after.manifest.lastCheckpointMs);
  assert.ok(after.manifest.durationMs >= Math.max(...after.digests.map(chunk => chunk.checkpointMs)));
  assert.ok(after.manifest.recoveryNote.includes('estimate'));
  assert.notEqual(after.manifest.state, 'complete');
  for (const chunk of before.chunks) assert.ok(after.digests.some(saved => saved.track === chunk.track && saved.sequence === chunk.sequence && saved.sha256 === chunk.sha256 && saved.readBytes === chunk.bytes));
}));
test('durable backups, ordered/idempotent appends, journal-gap recovery and digest corruption retain bytes', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { createDraftStore } = await import('/src/capture/storage.ts'); const root = await navigator.storage.getDirectory();
    const backup = await root.getDirectoryHandle('synthetic-external-backup', { create: true });
    const store = await createDraftStore(backup), id = 'storage-fixture';
    const manifest = { schema: 'rushes.browser-recording/1', id, title: 'Storage fixture', createdAt: new Date().toISOString(), mode: 'screen', state: 'recording', durationMs: 0, epochMs: 1,
      tracks: [{ kind: 'screen', mimeType: 'video/webm', startOffsetMs: 0, chunks: [], bytes: 0 }], pauses: [], events: [], bubble: { x: 0, y: 0, size: 180 }, lastCheckpointMs: 0, persistent: false, backupFolder: true };
    await store.create(manifest);
    let duplicateCode; try { await store.create(manifest); } catch (error) { duplicateCode = error.code; }
    const data = new Blob(['first durable bytes'], { type: 'video/webm' });
    const descriptor = await store.append(id, 'screen', 0, data, 2000); await store.append(id, 'screen', 0, data, 2000);
    const rejects = [];
    for (const [sequence, blob] of [[0, new Blob(['conflicting bytes'])], [2, data]]) {
      try { await store.append(id, 'screen', sequence, blob, 4000); rejects.push(false); } catch { rejects.push(true); }
    }
    // A stale caller save must never replace newly committed chunk descriptors.
    await store.save(manifest);
    const backed = await backup.getDirectoryHandle(id); const backedBytes = await (await backed.getFileHandle('screen-00000.bin')).getFile();
    const backedManifest = JSON.parse(await (await (await backed.getFileHandle('manifest.json')).getFile()).text());
    const folder = await (await root.getDirectoryHandle('rushes-browser-v1')).getDirectoryHandle(id);
    const orphan = await (await folder.getFileHandle('screen-00001.bin', { create: true })).createWritable(); await orphan.write('uncheckpointed tail'); await orphan.close();
    const recovered = await (await createDraftStore()).load(id);
    const writable = await (await folder.getFileHandle('screen-00000.bin')).createWritable(); await writable.write('tampered bytes'); await writable.close();
    let checksumFailed = false; try { await store.readChunk(id, descriptor); } catch { checksumFailed = true; }
    const corrupt = await (await createDraftStore()).load(id);
    const retained = await (await folder.getFileHandle('screen-00000.bin')).getFile();
    return { descriptor, duplicateCode, rejects, backedBytes: backedBytes.size, backedManifest, recovered, checksumFailed, corrupt, retained: retained.size };
  });
  assert.equal(result.duplicateCode, 'DRAFT_EXISTS'); assert.deepEqual(result.rejects, [true, true]); assert.equal(result.backedBytes, result.descriptor.bytes);
  assert.equal(result.backedManifest.tracks[0].chunks.length, 1); assert.equal(result.recovered.tracks[0].chunks.length, 2);
  assert.equal(result.recovered.state, 'interrupted'); assert.ok(result.recovered.recoveryNote.includes('uncheckpointed'));
  assert.equal(result.checksumFailed, true); assert.ok(result.corrupt.recoveryNote.includes('Checksum mismatch')); assert.ok(result.retained > 0);
}));
test('quota/write failure stops encoders, releases sources and preserves previously acknowledged data', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { fixture } = await import('/test/capture-fixture.mjs'); const value = await fixture('screen', false);
    const append = value.store.append; let count = 0;
    value.store.append = async (...args) => { if (++count > 2) throw new DOMException('Synthetic OPFS quota exhausted', 'QuotaExceededError'); return append(...args); };
    await value.session.start(); await new Promise(resolve => setTimeout(resolve, 4500)); const manifest = await value.session.stop();
    const recovered = await value.store.load(value.id); const ended = value.feeds[0].getTracks().every(track => track.readyState === 'ended');
    await value.cleanup(); return { manifest, recovered, ended, count, warnings: value.warnings };
  });
  assert.equal(result.manifest.state, 'interrupted'); assert.equal(result.ended, true);
  assert.ok(result.recovered.tracks.reduce((sum, track) => sum + track.bytes, 0) > 0);
  assert.ok(result.warnings.some(warning => warning.includes('quota exhausted')));
}));

test('decoded synthetic visual/audio edges align at beginning, middle and end of a paused take', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { fixture, syncTransitions } = await import('/test/capture-fixture.mjs');
    const value = await fixture('screen-camera', true, true); await value.session.start();
    await new Promise(resolve => setTimeout(resolve, 2100)); value.pauseCalibration(); await value.session.pause();
    await new Promise(resolve => setTimeout(resolve, 730)); value.resumeCalibration(); await value.session.resume();
    await new Promise(resolve => setTimeout(resolve, 2200)); const manifest = await value.session.stop();
    const drifts = await syncTransitions(await value.store.trackBlob(value.id, 'composed'));
    const originals = {};
    const audio = await value.store.trackBlob(value.id, 'microphone');
    for (const kind of ['screen', 'camera']) originals[kind] = await syncTransitions(await value.store.trackBlob(value.id, kind), audio,
      manifest.tracks.find(track => track.kind === kind).startOffsetMs, manifest.tracks.find(track => track.kind === 'microphone').startOffsetMs);
    await value.cleanup(); return { manifest, drifts, originals };
  });
  console.log('Decoded visual/audio edges', result.drifts);
  assert.equal(result.manifest.state, 'complete'); assert.equal(result.drifts.length, 3);
  assert.ok(result.drifts.every(edge => Math.abs(edge.driftMs) <= 100));
  console.log('Decoded original edge drift (ms)', Object.fromEntries(Object.entries(result.originals).map(([kind, edges]) => [kind, edges.map(edge => edge.driftMs)])));
  for (const edges of Object.values(result.originals)) assert.ok(edges.every(edge => Math.abs(edge.driftMs) <= 100));
}));

test('encoder error and Stop while paused finalize safely without retaining a live source', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { fixture } = await import('/test/capture-fixture.mjs');
    const recorders = [], originalStart = MediaRecorder.prototype.start;
    MediaRecorder.prototype.start = function(...argumentsValue) { recorders.push(this); return originalStart.apply(this, argumentsValue); };
    const value = await fixture('screen', false); await value.session.start();
    await new Promise(resolve => setTimeout(resolve, 300)); recorders.at(-1).dispatchEvent(new Event('error'));
    const failed = await value.session.stop(); await value.cleanup(); MediaRecorder.prototype.start = originalStart;
    const paused = await fixture('camera', false); await paused.session.start(); await new Promise(resolve => setTimeout(resolve, 400));
    await paused.session.pause(); await new Promise(resolve => setTimeout(resolve, 400)); const finished = await paused.session.stop();
    const ended = paused.session.preview.getTracks().every(track => track.readyState === 'ended'); await paused.cleanup();
    return { failed, finished, ended };
  });
  assert.equal(result.failed.state, 'interrupted'); assert.ok(result.failed.recoveryNote.includes('encoder failed'));
  assert.equal(result.finished.state, 'complete'); assert.ok(result.finished.durationMs < 650);
  assert.equal(result.finished.pauses.length, 1); assert.equal(result.ended, true);
}));
test('backup close failure is reported while the verified OPFS chunk remains recoverable', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { createDraftStore } = await import('/src/capture/storage.ts'); const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle('backup-close-fixture', { create: true }); let fail = false;
    const fakeBackup = { getDirectoryHandle: async (...args) => {
      const directory = await folder.getDirectoryHandle(...args);
      if (!fail) return directory;
      return { getFileHandle: async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => { throw new DOMException('Synthetic folder permission revoked', 'NotAllowedError'); }, abort: async () => {} }) }) };
    } };
    const store = await createDraftStore(fakeBackup), id = 'backup-close-draft';
    const manifest = { schema: 'rushes.browser-recording/1', id, title: 'Folder failure fixture', createdAt: new Date().toISOString(), mode: 'screen', state: 'recording', durationMs: 0, epochMs: 1,
      tracks: [{ kind: 'screen', mimeType: 'video/webm', startOffsetMs: 0, chunks: [], bytes: 0 }], pauses: [], events: [], bubble: { x: 0, y: 0, size: 180 }, lastCheckpointMs: 0, persistent: false, backupFolder: true };
    await store.create(manifest); fail = true; let message = '';
    try { await store.append(id, 'screen', 0, new Blob(['primary bytes']), 2000); } catch (error) { message = error.message; }
    try { await store.save({ ...manifest, state: 'interrupted' }); } catch { /* Primary final state commits before the failing folder checkpoint. */ }
    const recovered = await (await createDraftStore()).load(id); const bytes = await (await createDraftStore()).readChunk(id, recovered.tracks[0].chunks[0]);
    return { message, recovered, text: await bytes.text() };
  });
  assert.ok(result.message.includes('permission revoked')); assert.equal(result.recovered.state, 'interrupted');
  assert.equal(result.text, 'primary bytes'); assert.equal(result.recovered.lastCheckpointMs, 2000);
}));

test('a second tab observes a live draft without marking it interrupted or starting devices', { timeout: 30000 }, async () => {
  const context = await browser.newContext(); const first = await context.newPage(); const second = await context.newPage();
  try {
    await first.goto(`${origin}/capture-fixture`); await second.goto(`${origin}/capture-fixture`);
    const id = await first.evaluate(async () => {
      const { fixture } = await import('/test/capture-fixture.mjs'); window.live = await fixture('screen', false);
      await window.live.session.start(); await new Promise(resolve => setTimeout(resolve, 2100)); return window.live.id;
    });
    const viewed = await second.evaluate(async id => {
      const { createDraftStore } = await import('/src/capture/storage.ts'); return (await createDraftStore()).load(id);
    }, id);
    assert.equal(viewed.state, 'recording'); assert.ok(viewed.tracks.some(track => track.bytes > 0));
    const refused = await second.evaluate(async id => {
      const { createDraftStore } = await import('/src/capture/storage.ts');
      try { await (await createDraftStore()).remove(id); return false; } catch (error) { return error.message.includes('another tab'); }
    }, id);
    assert.equal(refused, true);
    await first.evaluate(async () => { await window.live.session.stop(); await window.live.cleanup(); });
    const stopped = await second.evaluate(async id => {
      const { createDraftStore } = await import('/src/capture/storage.ts'); return (await createDraftStore()).load(id);
    }, id);
    assert.equal(stopped.state, 'complete');
  } finally { await context.close(); }
});

test('a post-commit backup failure during startup releases its live draft lease and all sources', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { fixture } = await import('/test/capture-fixture.mjs');
    const { createDraftStore } = await import('/src/capture/storage.ts');
    const value = await fixture('screen', false); const create = value.store.create;
    value.store.create = async manifest => { await create(manifest); throw new DOMException('Synthetic initial folder checkpoint denied', 'NotAllowedError'); };
    let error = ''; try { await value.session.start(); } catch (failed) { error = failed.message; }
    const manifest = await value.session.stop(); const lease = (await navigator.locks.query()).held.some(lock => lock.name === `rushes-active-${value.id}`);
    const saved = await (await createDraftStore()).load(value.id);
    const ended = value.feeds[0].getTracks().every(track => track.readyState === 'ended'); await value.cleanup();
    return { error, manifest, saved, lease, ended };
  });
  assert.ok(result.error.includes('checkpoint denied')); assert.equal(result.manifest.state, 'interrupted');
  assert.equal(result.saved.state, 'interrupted'); assert.equal(result.lease, false); assert.equal(result.ended, true);
}));

test('source loss before or after primary creation terminally closes the owned draft before start rejects', { timeout: 30000 }, async () => {
  const context = await browser.newContext(); const owner = await context.newPage(); const observer = await context.newPage();
  try {
    await owner.goto(`${origin}/capture-fixture`); await observer.goto(`${origin}/capture-fixture`);
    for (const phase of ['before-primary', 'after-primary']) {
      const result = await owner.evaluate(async phase => {
        const { fixture } = await import('/test/capture-fixture.mjs');
        const value = await fixture('screen', false); const create = value.store.create;
        let entered, open;
        const signal = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { open = resolve; });
        const original = new Blob([`closed original bytes ${phase}`], { type: 'video/webm' });
        value.store.create = async manifest => {
          if (phase === 'before-primary') { entered(); await gate; }
          await create(manifest);
          await value.store.append(value.id, 'screen', 0, original, 0);
          if (phase === 'after-primary') { entered(); await gate; }
        };
        const started = value.session.start().then(() => 'unexpected success', error => error.message);
        await signal;
        const track = value.feeds[0].getVideoTracks()[0]; track.stop(); track.dispatchEvent(new Event('ended'));
        open(); const message = await started;
        // No Stop call: rejected startup itself must finish persistence/lease cleanup.
        const saved = await value.store.load(value.id);
        const held = (await navigator.locks.query()).held.some(lock => lock.name === `rushes-active-${value.id}`);
        const data = await value.store.readChunk(value.id, saved.tracks.find(track => track.kind === 'screen').chunks[0]);
        const ended = [...value.feeds[0].getTracks(), ...value.session.preview.getTracks()].every(track => track.readyState === 'ended');
        await value.cleanup();
        return { id: value.id, saved, held, ended, message, states: value.states, text: await data.text() };
      }, phase);
      assert.ok(result.message.includes('source closed')); assert.equal(result.saved.state, 'interrupted');
      assert.equal(result.saved.epochMs, 0); assert.equal(result.held, false); assert.equal(result.ended, true);
      assert.equal(result.text, `closed original bytes ${phase}`); assert.equal(result.states.at(-1), 'interrupted');
      assert.ok(result.saved.recoveryNote.includes('source ended'));
      const removed = await observer.evaluate(async id => {
        const { createDraftStore } = await import('/src/capture/storage.ts'); const store = await createDraftStore();
        const saved = await store.load(id); await store.remove(id); return saved.state;
      }, result.id);
      assert.equal(removed, 'interrupted');
    }
  } finally { await context.close(); }
});

test('an initial orphan and malformed retained metadata do not hide healthy completed recordings', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { fixture } = await import('/test/capture-fixture.mjs');
    const { createDraftStore } = await import('/src/capture/storage.ts');
    const healthy = await fixture('screen', false); await healthy.session.start();
    await new Promise(resolve => setTimeout(resolve, 350)); const completed = await healthy.session.stop();
    const original = await healthy.store.trackBlob(healthy.id, 'screen'); await healthy.cleanup();
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('rushes-browser-v1');
    const id = 'initial-write-orphan', handleMethod = FileSystemDirectoryHandle.prototype.getFileHandle;
    FileSystemDirectoryHandle.prototype.getFileHandle = function(name, options) {
      if (this.name === id && name === 'manifest.json' && options?.create) throw new DOMException('Synthetic initial manifest quota exhausted', 'QuotaExceededError');
      return handleMethod.call(this, name, options);
    };
    let creationError;
    try { await healthy.store.create({ ...completed, id, state: 'ready', epochMs: 0, tracks: [] }); }
    catch (error) { creationError = error.message; }
    finally { FileSystemDirectoryHandle.prototype.getFileHandle = handleMethod; }
    async function put(folder, name, data) {
      const writer = await (await folder.getFileHandle(name, { create: true })).createWritable(); await writer.write(data); await writer.close();
    }
    const damaged = await root.getDirectoryHandle('malformed-draft', { create: true });
    const malformed = '{original metadata never closed';
    await put(damaged, 'manifest.json', malformed); await put(damaged, 'camera-00000.bin', original);
    await put(damaged, 'unknown-retained.bin', 'unknown bytes must stay');
    const shape = await root.getDirectoryHandle('shape-damaged-draft', { create: true });
    await put(shape, 'manifest.json', JSON.stringify({ schema: 'rushes.browser-recording/1', id: 'shape-damaged-draft', tracks: [] }));
    await put(shape, 'composed-00000.bin', original);
    const invalidName = await root.getDirectoryHandle('unknown folder name', { create: true });
    await put(invalidName, 'screen-00000.bin', original);
    const recovered = await createDraftStore(); const listed = await recovered.list();
    const row = listed.find(value => value.id === 'malformed-draft');
    const bytes = await recovered.readChunk(row.id, row.tracks[0].chunks[0]);
    const alias = listed.find(value => value.id.startsWith('recovery-'));
    const aliasData = await recovered.trackBlob(alias.id, 'screen');
    const orphan = await root.getDirectoryHandle(id), orphanNames = [];
    for await (const name of orphan.keys()) orphanNames.push(name);
    return { creationError, listed, healthy: healthy.id, bytes: bytes.size, originalBytes: original.size,
      malformed: await (await (await damaged.getFileHandle('manifest.json')).getFile()).text(),
      unknown: await (await (await damaged.getFileHandle('unknown-retained.bin')).getFile()).text(),
      orphanNames, aliasBytes: aliasData.size };
  });
  assert.ok(result.creationError.includes('quota exhausted')); assert.deepEqual(result.orphanNames, []);
  assert.equal(result.listed.find(row => row.id === result.healthy).state, 'complete');
  for (const id of ['initial-write-orphan', 'malformed-draft', 'shape-damaged-draft']) {
    const row = result.listed.find(value => value.id === id); assert.equal(row.state, 'interrupted');
    assert.ok(row.recoveryNote.includes('retained')); assert.ok(row.recoveryNote.includes('unknown'));
  }
  assert.equal(result.bytes, result.originalBytes); assert.equal(result.aliasBytes, result.originalBytes);
  assert.equal(result.malformed, '{original metadata never closed'); assert.equal(result.unknown, 'unknown bytes must stay');
}));
