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
  browser = await chromium.launch({ channel: process.env.RUSHES_CAPTURE_BROWSER || 'chrome', headless: true });
  console.log(`Capture runtime ${browser.version()}; isolated synthetic media only.`);
});
after(async () => { await browser?.close(); await server?.close(); });
async function pageFixture(callback) {
  const context = await browser.newContext(); const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try { await page.goto(`${origin}/capture-fixture`); await callback(page); assert.deepEqual(errors, []); }
  finally { await context.close(); }
}
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
test('screen without audio and camera-only captures produce playable originals; rapid Stop waits for final data', { timeout: 30000 }, async () => pageFixture(async page => {
  const results = await page.evaluate(async () => {
    const { fixture, inspectVideo } = await import('/test/capture-fixture.mjs');
    const results = [];
    for (const mode of ['screen', 'camera']) {
      const value = await fixture(mode, false); await value.session.start();
      await new Promise(resolve => setTimeout(resolve, 350));
      const [one, two] = await Promise.all([value.session.stop(), value.session.stop()]);
      const info = await inspectVideo(await value.store.trackBlob(value.id, 'composed'));
      results.push({ manifest: one, same: JSON.stringify(one) === JSON.stringify(two), info }); await value.cleanup();
    }
    return results;
  });
  for (const result of results) {
    assert.equal(result.manifest.state, 'complete'); assert.equal(result.same, true);
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
  for (const chunk of before.chunks) assert.ok(after.digests.some(saved => saved.track === chunk.track && saved.sequence === chunk.sequence && saved.sha256 === chunk.sha256 && saved.readBytes === chunk.bytes));
}));
test('durable backups, ordered/idempotent appends, journal-gap recovery and digest corruption retain bytes', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { createDraftStore } = await import('/src/capture/storage.ts'); const root = await navigator.storage.getDirectory();
    const backup = await root.getDirectoryHandle('synthetic-external-backup', { create: true });
    const store = await createDraftStore(backup), id = 'storage-fixture';
    const manifest = { schema: 'rushes.browser-recording/1', id, title: 'Storage fixture', createdAt: new Date().toISOString(), mode: 'screen', state: 'recording', durationMs: 0, epochMs: 1,
      tracks: [{ kind: 'screen', mimeType: 'video/webm', startOffsetMs: 0, chunks: [], bytes: 0 }], pauses: [], events: [], bubble: { x: 0, y: 0, size: 180 }, lastCheckpointMs: 0, persistent: false, backupFolder: true };
    await store.create(manifest); const data = new Blob(['first durable bytes'], { type: 'video/webm' });
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
    return { descriptor, rejects, backedBytes: backedBytes.size, backedManifest, recovered, checksumFailed, corrupt, retained: retained.size };
  });
  assert.deepEqual(result.rejects, [true, true]); assert.equal(result.backedBytes, result.descriptor.bytes);
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
