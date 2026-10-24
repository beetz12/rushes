import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { matrixMedia } from './matrix-media.mjs';
import { beginColdTrace } from './cold-trace.mjs';
import { ownedTestBrowser } from './owned-test-browser.mjs';
import { ownedProfile } from '../../verification/browser-retirement.mjs';
const runFile = promisify(execFile);
// Startup-readiness bound for recorder start-EVENT offsets: an event-dispatch observation
// (docs/design/browser-capture-recovery.md), never recorded-media alignment evidence.
// Envelope bound far below the product's ten-second encoder-start deadline.
const STARTUP_READINESS_MS = 1000;
const coldCanvasBacking = process.env.RUSHES_COLD_CANVAS_BACKING ?? 'cpu';
if (!['default', 'cpu'].includes(coldCanvasBacking)) throw new Error('Cold Canvas backing must be default or cpu');
const coldRasterProof = process.env.RUSHES_COLD_RASTER_PROOF === '1';
if (process.env.RUSHES_COLD_RASTER_PROOF !== undefined && (!coldRasterProof || !process.env.RUSHES_COLD_TRACE_PROOF))
  throw new Error('Cold raster proof requires1 and an explicit trace directory');
// Container sanity bound for muxer-rebased first packets; cross-track sync stays with decoded edges.
const CONTAINER_MEDIA_START_MS = 100;
let server, browser, origin;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error',
    plugins: [{ name: 'rushes-capture-test-fixture', configureServer(value) {
      value.middlewares.use('/capture-fixture', (_request, response) => {
        response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Rushes synthetic capture test</title>');
      });
    } }],
  });
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ ...(process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE ? { executablePath: process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE } : { channel: process.env.RUSHES_CAPTURE_BROWSER || 'chrome' }), headless: true });
  if (process.env.RUSHES_COLD_OWNER_PROOF) {
    const session = await browser.newBrowserCDPSession();
    try {
      const processes = (await session.send('SystemInfo.getProcessInfo')).processInfo.filter(value => value.type === 'browser');
      assert.equal(processes.length, 1);
      const pid = Number(processes[0].id); assert.ok(Number.isSafeInteger(pid) && pid > 0);
      const command = process.platform === 'win32'
        ? await runFile('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`], { timeout: 5000 })
        : await runFile('ps', ['-p', String(pid), '-o', 'args='], { timeout: 3000 });
      const profile = ownedProfile(command.stdout);
      await writeFile(process.env.RUSHES_COLD_OWNER_PROOF, JSON.stringify({ pid, profile, chrome: browser.version() }), { flag: 'wx' });
    } finally { await session.detach(); }
  }
  console.log(`Capture runtime ${browser.version()}; isolated synthetic media only.`);
});
after(async () => { await browser?.close(); await server?.close(); });
async function pageFixture(callback) {
  const context = await browser.newContext(); const page = await context.newPage();
  page.on('console',message=>{if(message.text().startsWith('GENERATED_AUDIO_FAILURE '))console.log(message.text());});
  await page.addInitScript(()=>{
    const NativeWorker=Worker;let audioWorkerId=0;
    globalThis.generatedAudioInputMetadata={rows:[],dropped:0};
    globalThis.Worker=class extends NativeWorker{
      constructor(url,options){
        super(url,options);
        this.generatedAudioWorker=String(url).includes('/audio.worker')?audioWorkerId++:undefined;
        if(this.generatedAudioWorker!==undefined)this.addEventListener('message',event=>{
          if(event.data.kind==='error')console.log('GENERATED_AUDIO_FAILURE '+JSON.stringify(event.data));
        });
      }
      postMessage(message,...rest){
        if(this.generatedAudioWorker!==undefined&&message?.kind==='input'){
          const ledger=globalThis.generatedAudioInputMetadata;
          if(ledger.rows.length<2048)ledger.rows.push({worker:this.generatedAudioWorker,source:message.source,rate:message.rate,timestampUs:message.timestamp,frames:message.left.length});
          else ledger.dropped++;
        }
        return super.postMessage(message,...rest);
      }
    };
  });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const appRequests = []; page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/src/main.tsx' || pathname.startsWith('/api/')) appRequests.push(pathname);
  });
  try {
    await page.goto(`${origin}/capture-fixture`);
    assert.equal(await page.title(), 'Rushes synthetic capture test');
    assert.equal(await page.locator('#root').count(), 0);
    await callback(page); assert.deepEqual(errors, []); assert.deepEqual(appRequests, []);
  }
  finally { await context.close(); }
}
test('screen/camera composition, separate originals, mixed audio, pause timeline, moved bubble, and final chunks decode', { timeout: 45000 }, async () => pageFixture(async page => {
  const tracing = process.env.RUSHES_COLD_TRACE_PROOF ? await beginColdTrace(browser, page, process.env.RUSHES_COLD_TRACE_PROOF,
    { canvasDiagnostics: coldRasterProof }) : undefined;
  let result;
  try {
  result = await page.evaluate(async canvasBacking => {
    const { fixture, inspectVideo, inspectAudio, waitForActiveTime } = await import('/test/capture-fixture.mjs');
    const value = await fixture('screen-camera', true, false, undefined, 0, 700, canvasBacking);
    const startRequestedAt = performance.now(); await value.session.start(); const startResolvedAt = performance.now();
    await waitForActiveTime(value.store, value.id, 2200); await value.session.pause();
    await new Promise(resolve => setTimeout(resolve, 700)); value.session.setBubble({ x: 100, y: 100, size: 180 });
    await value.session.resume(); await waitForActiveTime(value.store, value.id, 4300);
    const manifest = await value.session.stop();
    const data = {}, retained = {};
    for (const track of manifest.tracks) {
      const blob = await value.store.trackBlob(value.id, track.kind);
      const bytes = new Uint8Array(await blob.arrayBuffer()); const pieces = [];
      for (let offset = 0; offset < bytes.length; offset += 16384) pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 16384)));
      retained[track.kind] = btoa(pieces.join(''));
      data[track.kind] = ['microphone', 'tab-audio'].includes(track.kind) ? await inspectAudio(blob) : await inspectVideo(blob, [[600, 360], [1070, 590], [190, 190]]);
    }
    const mixed = await inspectAudio(await value.store.trackBlob(value.id, 'composed'));
    const released = [...value.feeds.flatMap(feed => feed.getTracks()), ...value.session.preview.getTracks()].every(track => track.readyState === 'ended');
    await value.cleanup(); return { manifest, data, mixed, released, retained, startRequestedAt, startResolvedAt,
      states: value.states, finalCheckpoint: value.checkpoints.at(-1), initialSaveDelays: value.initialSaveDelays,
      canvasBacking: value.canvasBacking, sourceContextAttributes: value.sourceContextAttributes,audioInputMetadata:globalThis.generatedAudioInputMetadata };
  }, coldCanvasBacking);
  // Retain this generated case before assertions, including on a timing failure.
  // Packet probes run only after Stop; they do not consume live media.
  const coldProof = process.env.RUSHES_M1_PROOF ?? await mkdtemp(`${tmpdir()}/rushes-cold-`);
  await mkdir(coldProof, { recursive: true });
  // ffprobe availability is an environment question; a probe failure on retained media is a defect.
  let probing = true;
  try { await runFile(process.env.RUSHES_FFPROBE || 'ffprobe', ['-version'], { timeout: 5000 }); }
  catch { probing = false; console.log('ffprobe unavailable; container packet checks skipped (html decode assertions still gate media).'); }
  const packets = {};
  for (const [kind, data] of Object.entries(result.retained)) {
    const path = join(coldProof, `capture-cold-${kind}.webm`);
    await writeFile(path, Buffer.from(data, 'base64'));
    if (!probing) continue;
    try {
      const raw = await runFile(process.env.RUSHES_FFPROBE || 'ffprobe', ['-v','error','-show_packets',
        '-show_entries','packet=codec_type,pts_time,duration_time','-of','json',path], { timeout: 5000, maxBuffer: 4 * 1024 ** 2 });
      const values = JSON.parse(raw.stdout).packets;
      packets[kind] = {};
      for (const type of ['video','audio']) {
        const stream = values.filter(value => value.codec_type === type);
        if (!stream.length) continue;
        const gaps = stream.slice(1).map((value,index) => ({ before: stream[index], after: value,
          milliseconds: (Number(value.pts_time) - Number(stream[index].pts_time)) * 1000 }));
        packets[kind][type] = { count: stream.length, first: stream.slice(0,8), last: stream.slice(-8),
          largestGap: gaps.reduce((best,value) => !best || value.milliseconds > best.milliseconds ? value : best, null) };
      }
    } catch (error) { packets[kind] = { probeError: String(error) }; }
  }
  await writeFile(join(coldProof, 'capture-cold.log'), JSON.stringify({ manifest: result.manifest,
    startRequestedAt: result.startRequestedAt, startResolvedAt: result.startResolvedAt, initialSaveDelays: result.initialSaveDelays,
    canvasBacking: result.canvasBacking, sourceContextAttributes: result.sourceContextAttributes, html: result.data,mixed:result.mixed,audioInputMetadata:result.audioInputMetadata, packets }, null, 2));
  delete result.retained;
  console.log('Calibration offsets/durations', result.manifest.tracks.map(track => [track.kind, track.startOffsetMs, result.data[track.kind].duration]), result.manifest.durationMs);
  assert.equal(result.manifest.state, 'complete'); assert.equal(result.released, true);
  assert.equal(result.canvasBacking, coldCanvasBacking);
  assert.ok(result.sourceContextAttributes.every(value => value.willReadFrequently === (coldCanvasBacking === 'cpu')));
  assert.equal(result.initialSaveDelays.length, 1); assert.ok(result.initialSaveDelays[0].actualMs >= 600);
  assert.deepEqual(result.manifest.tracks.map(track => track.kind), ['screen', 'camera', 'microphone', 'tab-audio', 'composed']);
  assert.deepEqual(result.states, ['recording', 'paused', 'recording', 'stopping', 'complete']);
  assert.equal(result.finalCheckpoint.state, 'complete'); assert.equal(result.manifest.pauses.length, 1);
  assert.ok(result.manifest.pauses[0].endMs - result.manifest.pauses[0].startMs >= 650);
  assert.ok(result.manifest.durationMs > 4000 && result.manifest.durationMs < 4900);
  for (const track of result.manifest.tracks) {
    // Startup readiness only: the recorder start-EVENT offset from the session epoch
    // (event-dispatch observation, docs/design/browser-capture-recovery.md).
    // Bounded to catch startup regressions; never recorded-media alignment evidence.
    assert.ok(track.startOffsetMs >= 0 && track.startOffsetMs < STARTUP_READINESS_MS, `${track.kind} start event took ${track.startOffsetMs}ms`);
    assert.equal(track.startOffsetTimeBasis, 'media-recorder-start-event');
    assert.ok(track.bytes > 0 && track.chunks.length >= 2);
    assert.ok(track.chunks.every((chunk, index) => chunk.sequence === index && /^[a-f0-9]{64}$/.test(chunk.sha256)));
  }
  assert.ok(Math.max(...result.manifest.tracks.map(track => track.startOffsetMs)) - Math.min(...result.manifest.tracks.map(track => track.startOffsetMs)) <= STARTUP_READINESS_MS);
  // Container sanity: every track's media begins within 100ms of its file origin (muxer-rebased
  // first packet — a file-integrity check, not cross-track sync proof; sync stays with decoded edges).
  // When ffprobe is available, a failed or empty probe is itself a failure.
  if (probing) {
    const expectedStreams = { screen: ['video'], camera: ['video'], microphone: ['audio'], 'tab-audio': ['audio'], composed: ['video', 'audio'] };
    for (const [kind, types] of Object.entries(expectedStreams)) {
      for (const type of types) {
        const info = packets[kind]?.[type];
        assert.ok(info && !info.probeError && info.first?.length, `${kind}/${type} packet probe failed or empty`);
        assert.ok(Number(info.first[0].pts_time) * 1000 <= CONTAINER_MEDIA_START_MS, `${kind}/${type} first packet pts=${info.first[0].pts_time}`);
      }
    }
  }
  assert.deepEqual([result.data.composed.width, result.data.composed.height], [1280, 720]);
  // Red camera is baked into the first corner, then moves to the opposite one.
  assert.ok(result.data.composed.samples[0][1][0] > 160 && result.data.composed.samples[0][1][2] < 100);
  assert.ok(result.data.composed.samples.at(-1)[2][0] > 160 && result.data.composed.samples.at(-1)[2][2] < 100);
  assert.ok(result.data.composed.samples.at(-1)[1][2] > 160);
  assert.ok(result.audioInputMetadata.rows.length>0&&result.audioInputMetadata.rows.length<=2048);
  assert.ok(result.mixed.powers.every(power => power > 0.025));
  assert.ok(result.data.microphone.powers[0] > 0.08 && result.data.microphone.powers[1] < 0.01);
  assert.ok(result.data['tab-audio'].powers[1] > 0.08 && result.data['tab-audio'].powers[0] < 0.01);
  for (const info of Object.values(result.data)) assert.ok(Math.abs(info.duration * 1000 - result.manifest.durationMs) < 250);
  } finally {
    await tracing?.finish(result ? { manifest: result.manifest, media: result.data,
      startRequestedAt: result.startRequestedAt, startResolvedAt: result.startResolvedAt } : { result: 'page evaluation did not return' });
  }
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
  // Start-event spread is a startup-readiness observation, not media alignment (see test 4).
  assert.ok(Math.max(...offsets) - Math.min(...offsets) <= STARTUP_READINESS_MS, JSON.stringify(offsets));
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
    const results = [],NativeRecorder=MediaRecorder;
    for (const {mode,split} of [{mode:'screen',split:false},{mode:'camera',split:false},{mode:'screen',split:true}]) {
      const observed=[];let dropped=0,value;
      globalThis.MediaRecorder=class extends NativeRecorder{
        constructor(...args){super(...args);const blobs=[];observed.push({recorder:this,blobs});this.addEventListener('dataavailable',event=>{
          if(!event.data.size)return;if(blobs.length<64)blobs.push(event.data);else dropped++;
        });}
      };
      try{
        value = await fixture(mode, false, false, `private-reservation-${mode}`); await value.session.start();
        if(split){
          await new Promise(resolve=>setTimeout(resolve,150));
          for(const {recorder} of observed)recorder.requestData();
          await new Promise(resolve=>setTimeout(resolve,200));
        }else await new Promise(resolve => setTimeout(resolve, 350));
        const [one, two] = await Promise.all([value.session.stop(), value.session.stop()]);
        const info = await inspectVideo(await value.store.trackBlob(value.id, 'composed'));
        const saved = await value.store.load(value.id),nativeChunks=[];
        // Hash existing event Blobs only after Stop; no extra live source reader.
        for(const {blobs} of observed){const rows=[];for(const blob of blobs){
          const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(value=>value.toString(16).padStart(2,'0')).join('');
          rows.push({sequence:rows.length,bytes:blob.size,sha256});
        }nativeChunks.push(rows);}
        results.push({manifest:one,nativeChunks,dropped,split,savedCloudId:saved.cloudRecordingId,checkpointCloudIds:value.checkpoints.map(point=>point.cloudRecordingId),same:JSON.stringify(one)===JSON.stringify(two),info});
      }finally{globalThis.MediaRecorder=NativeRecorder;await value?.cleanup();}
    }
    return results;
  });
  const exactChunks=(tracks,observed)=>{
    assert.equal(tracks.length,observed.length);
    tracks.forEach((track,index)=>{
      assert.ok(track.bytes>0&&observed[index].length>0);
      assert.deepEqual(track.chunks.map(({sequence,bytes,sha256})=>({sequence,bytes,sha256})),observed[index]);
      assert.equal(track.bytes,observed[index].reduce((total,row)=>total+row.bytes,0));
    });
  };
  console.log('Rapid Stop native/saved chunks',JSON.stringify(results.map(result=>({mode:result.manifest.mode,split:result.split,native:result.nativeChunks.map(rows=>rows.length),saved:result.manifest.tracks.map(track=>track.chunks.length)}))));
  for (const result of results) {
    assert.equal(result.manifest.state, 'complete'); assert.equal(result.same, true);
    assert.equal(result.manifest.cloudRecordingId, `private-reservation-${result.manifest.mode}`);
    assert.equal(result.savedCloudId, result.manifest.cloudRecordingId);
    assert.ok(result.checkpointCloudIds.every(id => id === result.manifest.cloudRecordingId));
    assert.ok(result.info.duration > 0.2 && result.info.duration < 0.7);
    assert.equal(result.manifest.tracks.length, 2);assert.equal(result.dropped,0);
    exactChunks(result.manifest.tracks,result.nativeChunks);
    if(result.split){
      assert.ok(result.nativeChunks.every(rows=>rows.length>=2),'The forced native boundary must actually produce multiple nonempty chunks');
      for(const change of [track=>track.chunks.pop(),track=>track.chunks.push({...track.chunks[0]}),track=>track.chunks.reverse(),track=>{track.chunks[0].sha256='0'.repeat(64);},track=>{track.chunks[0].bytes++;}]){
        const changed=structuredClone(result.manifest.tracks);change(changed[0]);assert.throws(()=>exactChunks(changed,result.nativeChunks));
      }
    }
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
    for (const kind of ['screen', 'camera']) originals[kind] = await syncTransitions(await value.store.trackBlob(value.id, kind), audio);
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
  let tracing, ownerStop;
  try {
    await first.goto(`${origin}/capture-fixture`); await second.goto(`${origin}/capture-fixture`);
    if (process.env.RUSHES_SECOND_TAB_TRACE_PROOF) tracing = await beginColdTrace(browser, first,
      process.env.RUSHES_SECOND_TAB_TRACE_PROOF, { canvasDiagnostics: true });
    const id = await first.evaluate(async () => {
      const { fixture } = await import('/test/capture-fixture.mjs'); window.live = await fixture('screen', false);
      const append = window.live.store.append; let delayed = false;
      window.secondTabWrites = {calls:0,delayReleased:false,entered:0,returned:0};
      window.live.store.append = async (...args) => {
        ++window.secondTabWrites.calls;
        if (!delayed) { delayed = true; await new Promise(resolve => setTimeout(resolve, 2500)); window.secondTabWrites.delayReleased = true; }
        ++window.secondTabWrites.entered;
        const result = await append(...args);
        ++window.secondTabWrites.returned;
        return result;
      };
      await window.live.session.start(); return window.live.id;
    });
    // Observe an acknowledged chunk; a nominal timeslice is not a durable write.
    await first.waitForFunction(() => window.live.checkpoints.some(manifest => manifest.tracks.some(track => track.bytes > 0)),
      null, { polling: 50, timeout: 10000 });
    const viewed = await second.evaluate(async id => {
      const { createDraftStore } = await import('/src/capture/storage.ts'); return (await createDraftStore()).load(id);
    }, id);
    assert.equal(viewed.state, 'recording'); assert.ok(viewed.tracks.some(track => track.bytes > 0));
    const refused = await second.evaluate(async id => {
      const { createDraftStore } = await import('/src/capture/storage.ts');
      try { await (await createDraftStore()).remove(id); return false; } catch (error) { return error.message.includes('another tab'); }
    }, id);
    assert.equal(refused, true);
    ownerStop = await first.evaluate(async retain => {
      const manifest = await window.live.session.stop();
      const warnings = [...window.live.warnings];
      await window.live.cleanup();
      const retained = {};
      if (retain) for (const track of manifest.tracks) {
        const bytes = new Uint8Array(await (await window.live.store.trackBlob(window.live.id, track.kind)).arrayBuffer());
        const pieces = [];
        for (let offset = 0; offset < bytes.length; offset += 16384) pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 16384)));
        retained[track.kind] = btoa(pieces.join(''));
      }
      return { manifest, warnings, retained };
    }, Boolean(process.env.RUSHES_SECOND_TAB_PROOF));
    if (process.env.RUSHES_SECOND_TAB_PROOF) {
      await mkdir(process.env.RUSHES_SECOND_TAB_PROOF, { recursive: true });
      for (const [kind, bytes] of Object.entries(ownerStop.retained))
        await writeFile(join(process.env.RUSHES_SECOND_TAB_PROOF, `${kind}.webm`), Buffer.from(bytes, 'base64'), { flag: 'wx' });
      await writeFile(join(process.env.RUSHES_SECOND_TAB_PROOF, 'terminal.json'), JSON.stringify({
        manifest: ownerStop.manifest, warnings: ownerStop.warnings }, null, 2), { flag: 'wx' });
    }
    delete ownerStop.retained;
    const stopped = await second.evaluate(async id => {
      const { createDraftStore } = await import('/src/capture/storage.ts'); return (await createDraftStore()).load(id);
    }, id);
    const terminal = manifest => ({ state: manifest.state, durationMs: manifest.durationMs,
      recoveryNote: manifest.recoveryNote, tracks: manifest.tracks.map(track => ({ kind: track.kind, bytes: track.bytes,
        chunks: track.chunks.length })), failures: manifest.events.filter(event => event.kind === 'failure') });
    console.log('Second-tab terminal result', JSON.stringify({ owner: terminal(ownerStop.manifest),
      warnings: ownerStop.warnings, observed: terminal(stopped) }));
    assert.equal(stopped.state, 'complete');
  } catch (error) {
    const snapshot = await first.evaluate(() => {
      const live = window.live;
      return {visibility:document.visibilityState, focused:document.hasFocus(), now:performance.now(), writes:window.secondTabWrites,
        states:live?.states, warnings:live?.warnings,
        checkpoints:live?.checkpoints.slice(-3).map(value => ({state:value.state,durationMs:value.durationMs,tracks:value.tracks.map(track => ({kind:track.kind,bytes:track.bytes,chunks:track.chunks.length}))})),
        inputs:live?.feeds.flatMap(stream => stream.getTracks().map(track => ({kind:track.kind,state:track.readyState,muted:track.muted,enabled:track.enabled}))),
      };
    }).catch(diagnosticError => ({diagnosticError:String(diagnosticError)}));
    console.log('Second-tab in-memory failure snapshot', JSON.stringify(snapshot));
    let diskTimer;
    try {
      snapshot.saved = await Promise.race([
        first.evaluate(() => window.live.store.load(window.live.id)),
        new Promise(resolve => { diskTimer = setTimeout(() => resolve({unavailable:'Draft read remained pending at the diagnostic deadline'}),1000); }),
      ]).catch(failure => ({error:String(failure)}));
    } finally { clearTimeout(diskTimer); }
    console.log('Second-tab failure snapshot', JSON.stringify(snapshot));
    if (process.env.RUSHES_SECOND_TAB_PROOF) {
      try {
        await mkdir(process.env.RUSHES_SECOND_TAB_PROOF, {recursive:true});
        await writeFile(join(process.env.RUSHES_SECOND_TAB_PROOF,'failure.json'),JSON.stringify(snapshot,null,2));
      } catch (diagnosticError) {
        console.error('Second-tab snapshot could not be saved', String(diagnosticError));
      }
    }
    throw error;
  } finally {
    try { await tracing?.finish(ownerStop ?? { result: 'Owner Stop did not return' }); }
    finally { await context.close(); }
  }
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

test('concurrent cancel callers join terminal events before another take; a confirmation timeout still removes the discarded draft', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { fixture, inspectVideo } = await import('/test/capture-fixture.mjs');
    const add = MediaRecorder.prototype.addEventListener, timeout = window.setTimeout;
    let releaseStops;
    const stops = new Promise(resolve => { releaseStops = resolve; });
    MediaRecorder.prototype.addEventListener = function(name, listener, options) {
      if (name === 'stop') return add.call(this, name, event => {
        void stops.then(() => typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event));
      }, options);
      return add.call(this, name, listener, options);
    };
    const value = await fixture();
    let valueCleaned = false;
    const cleanValue = async () => { if (!valueCleaned) { valueCleaned = true; await value.cleanup(); } };
    try {
      await value.session.start();
      let settled = 0;
      const first = value.session.cancel().then(() => { settled++; });
      const second = value.session.cancel().then(() => { settled++; });
      await new Promise(resolve => timeout(resolve, 40));
      const waiting = { settled, ended: [...value.feeds.flatMap(feed => feed.getTracks()), ...value.session.preview.getTracks()].every(track => track.readyState === 'ended'),
        hasDraft: (await value.store.list()).some(draft => draft.id === value.id) };
      releaseStops(); await Promise.all([first, second]);
      const cleared = { settled, drafts: (await value.store.list()).length, states: [...value.states] };
      MediaRecorder.prototype.addEventListener = add;
      await cleanValue();
      const next = await fixture();
      let nextManifest, decoded;
      try {
        await next.session.start(); await new Promise(resolve => timeout(resolve, 600));
        nextManifest = await next.session.stop();
        decoded = await inspectVideo(await next.store.trackBlob(next.id, 'composed'));
        await next.store.remove(next.id);
      } finally { await next.cleanup(); }

      let releaseLate;
      const late = new Promise(resolve => { releaseLate = resolve; });
      MediaRecorder.prototype.addEventListener = function(name, listener, options) {
        if (name === 'stop') return add.call(this, name, event => {
          void late.then(() => typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event));
        }, options);
        return add.call(this, name, listener, options);
      };
      const timed = await fixture();
      try {
        await timed.session.start();
        const bounds = [];
        window.setTimeout = function(callback, milliseconds, ...args) {
          if (milliseconds === 15000) { bounds.push(milliseconds); return timeout.call(this, callback, 40, ...args); }
          return timeout.call(this, callback, milliseconds, ...args);
        };
        const failure = await timed.session.cancel().then(() => null, error => error.message);
        return { waiting, cleared, nextManifest, decoded: { duration: decoded.duration, width: decoded.width, height: decoded.height },
          timed: { failure, bounds, drafts: (await timed.store.list()).length,
            ended: timed.feeds.flatMap(feed => feed.getTracks()).every(track => track.readyState === 'ended') } };
      } finally { releaseLate(); window.setTimeout = timeout; await timed.cleanup(); }
    } finally {
      releaseStops(); MediaRecorder.prototype.addEventListener = add; window.setTimeout = timeout; await cleanValue();
    }
  });
  assert.deepEqual(result.waiting, { settled: 0, ended: true, hasDraft: true });
  assert.deepEqual(result.cleared, { settled: 2, drafts: 0, states: ['recording', 'failed'] });
  assert.equal(result.nextManifest.state, 'complete'); assert.ok(result.decoded.duration > 0.4);
  assert.ok(Math.max(...result.nextManifest.tracks.map(track => track.startOffsetMs)) - Math.min(...result.nextManifest.tracks.map(track => track.startOffsetMs)) <= STARTUP_READINESS_MS);
  assert.ok(result.timed.failure.includes('Encoder stop confirmation timed out'));
  assert.deepEqual(result.timed.bounds, [15000]); assert.equal(result.timed.drafts, 0); assert.equal(result.timed.ended, true);
}));

test('a live camera source that silently stops producing frames cannot report a complete full-length take', { timeout: 20000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { fixture, inspectVideo } = await import('/test/capture-fixture.mjs');
    const originalInterval = globalThis.setInterval, sourceTimers = [];
    globalThis.setInterval = (callback, delay, ...args) => {
      const timer = originalInterval(callback, delay, ...args);
      if (delay === 1000 / 30) sourceTimers.push(timer);
      return timer;
    };
    let value;
    try { value = await fixture('camera', true); }
    finally { globalThis.setInterval = originalInterval; }
    const digest = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].join(',');
    const readSnapshot = value.store.readSnapshot.bind(value.store); let beforeVerificationHash;
    value.store.readSnapshot = async id => {
      const snapshot = await readSnapshot(id);
      if (!beforeVerificationHash) beforeVerificationHash = await digest(snapshot.tracks.get('camera'));
      return snapshot;
    };
    try {
      if (sourceTimers.length !== 2) throw new Error('Expected exactly the two generated video producers');
      await value.session.start();
      await new Promise(resolve => setTimeout(resolve, 250)); clearInterval(sourceTimers[1]);
      await new Promise(resolve => setTimeout(resolve, 1000));
      const cameraStayedLive = value.feeds[1].getVideoTracks()[0].readyState === 'live';
      const manifest = await value.session.stop();
      const before = await value.store.trackBlob(value.id, 'camera');
      const details = await inspectVideo(before);
      const originalHash = beforeVerificationHash, retainedHash = await digest(await value.store.trackBlob(value.id, 'camera'));
      return { manifest, cameraStayedLive, duration: details.duration, originalHash, retainedHash, warnings: value.warnings };
    } finally { await value.cleanup(); }
  });
  assert.equal(result.cameraStayedLive, true);
  assert.ok(result.manifest.durationMs >= 1200 && result.duration > 0 && result.duration * 1000 < result.manifest.durationMs - 500);
  assert.ok(result.originalHash); assert.equal(result.originalHash, result.retainedHash);
  console.log('Silent camera saved-extent observation', { state: result.manifest.state, sessionMs: result.manifest.durationMs, cameraMs: result.duration * 1000, originalBytesUnchanged: true });
  assert.equal(result.manifest.state, 'interrupted');
  assert.match(result.manifest.recoveryNote, /camera.*duration/i);
}));

test('native-reference preparation retains the actual clock failure before a take exists', async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { prepareMatrix } = await import('/test/matrix-fixture.mjs');
    const originalRecorder = MediaRecorder, originalWorker = Worker;
    navigator.mediaDevices.getUserMedia = async () => { throw new Error('Deliberate generated source refusal'); };
    let failure;
    try { window.matrixTake = await prepareMatrix({ sourceMode: 'native-reference' }); }
    catch (error) { failure = String(error); }
    return { failure, clock: window.matrixPreparationMetrics.clockCapability,
      takeExists: !!window.matrixTake, restored: MediaRecorder === originalRecorder && Worker === originalWorker };
  });
  assert.equal(result.takeExists, false); assert.equal(result.restored, true);
  assert.match(result.failure, /Deliberate generated source refusal/);
  assert.match(result.clock.error, /Deliberate generated source refusal/);
  assert.deepEqual(result.clock.observations, []); assert.deepEqual(result.clock.cleanupErrors, []);
}));

test('matrix witnesses freeze at Stop while later product finalization is parked', { timeout: 45000 }, async context => {
  const proof = await mkdtemp(`${tmpdir()}/rushes-witness-stop-`);
  const evidenceDirectory = process.env.RUSHES_M1_PROOF ?? proof; await mkdir(evidenceDirectory, { recursive: true });
  const events = [], reportFile = join(evidenceDirectory, 'witness-stop.log');
  await writeFile(reportFile, '[]', { flag: 'wx' });
  const stage = async value => { events.push({ at: new Date().toISOString(), ...value }); await writeFile(reportFile, JSON.stringify(events, null, 2)); };
  const media = await matrixMedia(proof, { signal: context.signal, onStage: (name, details) => stage({ stage: name, ...details }) });
  const argumentsForFakeSource = [`--use-file-for-fake-video-capture=${media.video}`];
  for (const name of ['device', 'ui']) argumentsForFakeSource.push(`--use-fake-${name}-for-media-stream`);
  await stage({ stage: 'native-launch-start' });
  const owned = await ownedTestBrowser(context.signal, () => chromium.launchServer({ ...(process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE
    ? { executablePath: process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE } : { channel: process.env.RUSHES_CAPTURE_BROWSER || 'chrome' }),
    headless: true, args: argumentsForFakeSource, timeout: 15000 }), endpoint => chromium.connect(endpoint, { timeout: 15000 }));
  const nativeBrowser = owned.browser;
  context.after(() => owned.close());
  try {
  await stage({ stage: 'native-launched', pid: owned.process.pid });
  const page = await nativeBrowser.newPage(); await page.goto(`${origin}/capture-fixture`);
  await page.exposeFunction('witnessStage', stage);
  const result = await page.evaluate(async () => {
    const { prepareMatrix } = await import('/test/matrix-fixture.mjs');
    let take, release, previewEndedAtBarrier = false;
    try {
      await window.witnessStage({ stage: 'before-prepare' });
      take = await prepareMatrix({ sourceMode: 'native-reference' });
      await window.witnessStage({ stage: 'before-start' }); await take.start();
      const readSnapshot = take.store.readSnapshot; let entered;
      const parked = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      take.store.readSnapshot = async (...args) => {
        // Park the same post-native-Stop journal boundary, not an earlier drain.
        if (take.session.preview.getTracks().every(track => track.readyState === 'ended')) {
          previewEndedAtBarrier = true; entered(); await gate;
        }
        return readSnapshot(...args);
      };
      await new Promise(resolve => setTimeout(resolve, 650));
      await window.witnessStage({ stage: 'before-stop' });
      const finishing = take.finish();
      await Promise.race([parked, finishing.then(() => { throw new Error('Finalization ended before its journal barrier'); })]);
      await window.witnessStage({ stage: 'journal-parked' });
      // Wait for the actual retirement result, which includes bounded PCM IO.
      // Native frame crossings and PCM coverage still enforce their250ms limits.
      while (take.snapshot().metrics.observationBoundary?.finishedPageMs === undefined)
        await new Promise(resolve => setTimeout(resolve, 20));
      const first = take.snapshot();
      await window.witnessStage({ stage: 'retirement-finished', snapshot: first });
      await new Promise(resolve => setTimeout(resolve, 300)); const second = take.snapshot();
      release(); const final = await finishing;
      return { first, second, final, previewEndedAtBarrier };
    } catch (error) {
      try { await window.witnessStage({ stage: 'browser-failure', error: String(error), snapshot: take?.snapshot() ?? null }); }
      catch { /* Node owns abort/exit evidence when this page is already gone. */ }
      throw error;
    } finally { release?.(); }
  });
  await stage({ stage: 'before-assertions', result });
  assert.equal(result.previewEndedAtBarrier, true);
  const output = result.first.metrics.generatedAudioOutput;
  assert.deepEqual({ type: output.type, sampleRate: output.sampleRate, state: output.state,
    requestedCallbackFrames: output.requestedCallbackFrames }, { type: 'none', sampleRate: 48000, state: 'running', requestedCallbackFrames: 128 });
  assert.ok(Number.isFinite(output.baseLatency) && output.baseLatency >= 0);
  assert.ok(output.renderQuantumSize === null || (Number.isSafeInteger(output.renderQuantumSize) && output.renderQuantumSize > 0));
  assert.ok(result.first.metrics.observationBoundary.finishedPageMs);
  assert.equal(result.first.metrics.states.at(-1).state, 'stopping');
  assert.deepEqual(result.first.metrics.frames, result.second.metrics.frames);
  assert.deepEqual(result.first.metrics.sourceObserverRetirement, result.second.metrics.sourceObserverRetirement);
  assert.equal(result.first.metrics.suppliedReference.closed, true);
  assert.deepEqual(result.first.metrics.suppliedReference, result.second.metrics.suppliedReference);
  assert.deepEqual(result.final.metrics.observerErrors, []);
  assert.equal(result.final.manifest.state, 'complete');
  } catch (error) { await stage({ stage: 'test-failure', error: String(error.stack || error) }); throw error; }
  finally {
    await owned.close();
    await stage({ stage: 'native-exited', pid: owned.process.pid,
      exitCode: owned.process.exitCode, signalCode: owned.process.signalCode });
  }
});

test('aborting a suspended generated browser evaluation confirms its owned process exits', { timeout: 15000 }, async context => {
  const controller = new AbortController();
  const owner = await ownedTestBrowser(AbortSignal.any([controller.signal, context.signal]), () => chromium.launchServer({ ...(process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE
    ? { executablePath: process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE } : { channel: process.env.RUSHES_CAPTURE_BROWSER || 'chrome' }), headless: true, timeout: 10000 }),
    endpoint => chromium.connect(endpoint, { timeout: 10000 }));
  try {
    const page = await owner.browser.newPage(); let entered;
    const parked = new Promise(resolve => { entered = resolve; });
    await page.exposeFunction('enteredAbortProbe', entered);
    const suspended = page.evaluate(async () => { await window.enteredAbortProbe(); await new Promise(() => {}); });
    const failed = assert.rejects(suspended, /closed|crashed|Target/i);
    await Promise.race([parked, suspended.then(() => { throw new Error('Abort probe ended before its barrier'); })]);
    controller.abort(); await failed; await owner.close();
    assert.ok(owner.process.exitCode !== null || owner.process.signalCode !== null);
  } finally { await owner.close(); }
});

test('saved coverage survives a native Stop that discards its late video tail', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const NativeRecorder = MediaRecorder;
    let discardedBytes = 0, requests = 0, stops = 0;
    // Model the observed native weak-callback teardown using real encoded data:
    // bytes flushed before Stop survive; bytes dispatched after Stop are lost.
    globalThis.MediaRecorder = class extends NativeRecorder {
      retired = false;
      constructor(...args) {
        super(...args);
        super.addEventListener('dataavailable', event => {
          if (this.retired && event.data.size) { discardedBytes += event.data.size; event.stopImmediatePropagation(); }
        });
      }
      requestData() { requests++; return super.requestData(); }
      stop() { stops++; this.retired = true; return super.stop(); }
    };
    const { fixture, inspectVideo, waitForActiveTime } = await import('/test/capture-fixture.mjs');
    let value;
    try {
      value = await fixture('screen', false); await value.session.start();
      await waitForActiveTime(value.store, value.id, 2800);
      const manifest = await value.session.stop(), decoded = {};
      for (const track of manifest.tracks) decoded[track.kind] = await inspectVideo(await value.store.trackBlob(value.id, track.kind));
      return { manifest, decoded, requests, discardedBytes, stops,
        released: [...value.feeds[0].getTracks(), ...value.session.preview.getTracks()].every(track => track.readyState === 'ended') };
    } finally { if (value) { await value.session.cancel(); await value.cleanup(); } globalThis.MediaRecorder = NativeRecorder; }
  });
  console.log('Native Stop tail control', JSON.stringify({ state: result.manifest.state, durationMs: result.manifest.durationMs,
    decoded: Object.fromEntries(Object.entries(result.decoded).map(([kind, value]) => [kind, value.duration])), requests: result.requests, discardedBytes: result.discardedBytes }));
  assert.equal(result.manifest.state, 'complete');
  assert.deepEqual(result.manifest.tracks.map(track => track.kind), ['screen', 'composed']);
  assert.equal(result.stops, 2); assert.equal(result.released, true);
  for (const value of Object.values(result.decoded)) assert.ok(Math.abs(value.duration * 1000 - result.manifest.durationMs) <= 250);
}));

for (const phase of ['after-stop', 'before-stop']) test(`audio source retirement preserves the ${phase} discontinuity boundary`, { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async phase => {
    const NativeWorker = Worker, NativeRecorder = MediaRecorder, recorders = [];
    let inject = false, injected = 0, terminal, signalTerminal, audioWorker, heldError, replaying = false;
    const retired = new Promise(resolve => { signalTerminal = resolve; });
    globalThis.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options); this.audio = String(url).includes('/audio.worker');
        if (this.audio) super.addEventListener('message', event => {
          if (['error', 'stopped'].includes(event.data.kind)) { terminal ??= event.data.kind; signalTerminal(); }
          if (phase === 'before-stop' && event.data.kind === 'error' && !replaying) { heldError = event.data; audioWorker = this; event.stopImmediatePropagation(); }
        });
      }
      postMessage(message, ...args) {
        if (this.audio && inject && message.kind === 'input') { message = { ...message, timestamp: message.timestamp + 500000 }; injected++; }
        return super.postMessage(message, ...args);
      }
    };
    globalThis.MediaRecorder = class extends NativeRecorder {
      constructor(stream, ...args) { super(stream, ...args); recorders.push({ recorder: this, tracks: stream.getTracks() }); }
    };
    const { fixture, waitForActiveTime, inspectAudio } = await import('/test/capture-fixture.mjs'); let value, outputWasLive;
    const boundedRetirement = async () => {
      let timer;
      try { await Promise.race([retired, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No mixer terminal receipt')), 3000); })]); }
      finally { clearTimeout(timer); }
    };
    try {
      value = await fixture('screen', true); await value.session.start(); await waitForActiveTime(value.store, value.id, 2200);
      const readSnapshot = value.store.readSnapshot.bind(value.store); let first = true;
      value.store.readSnapshot = async (...args) => {
        if (first && phase === 'after-stop') {
          first = false; await boundedRetirement();
          outputWasLive = recorders.at(-1).tracks.find(track => track.kind === 'audio').readyState === 'live';
        }
        return readSnapshot(...args);
      };
      inject = true;
      if (phase === 'before-stop') await boundedRetirement();
      const finishing = value.session.stop();
      if (heldError) { replaying = true; audioWorker.dispatchEvent(new MessageEvent('message', { data: heldError })); }
      const manifest = await finishing;
      const decoded = phase === 'after-stop' ? await inspectAudio(await value.store.trackBlob(value.id, 'composed')) : undefined;
      return { manifest, terminal, injected, outputWasLive, decoded, delayedPreStopError: !!heldError };
    } finally { if (value) { await value.session.cancel(); await value.cleanup(); } globalThis.Worker = NativeWorker; globalThis.MediaRecorder = NativeRecorder; }
  }, phase);
  console.log('Audio Stop boundary', JSON.stringify({ phase, state: result.manifest.state, terminal: result.terminal, injected: result.injected, outputWasLive: result.outputWasLive }));
  if (phase === 'after-stop') {
    assert.equal(result.manifest.state, 'complete'); assert.equal(result.terminal, 'stopped'); assert.equal(result.injected, 0); assert.equal(result.outputWasLive, true);
    assert.ok(Math.abs(result.decoded.duration * 1000 - result.manifest.durationMs) <= 250);
    assert.ok(result.decoded.powers.every(power => power > .03));
  } else {
    assert.equal(result.manifest.state, 'interrupted'); assert.equal(result.terminal, 'error'); assert.ok(result.injected > 0);
    assert.equal(result.delayedPreStopError, true);
    assert.match(result.manifest.recoveryNote, /discontinuity/);
  }
}));

test('a missing actual mixer Stop receipt cannot report a complete recording', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const NativeWorker = Worker; let held = 0;
    globalThis.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (String(url).includes('/audio.worker')) super.addEventListener('message', event => {
          if (event.data.kind === 'stopped') { held++; event.stopImmediatePropagation(); }
        });
      }
    };
    const { fixture, waitForActiveTime } = await import('/test/capture-fixture.mjs'); let value;
    try {
      value = await fixture('screen', true); await value.session.start(); await waitForActiveTime(value.store, value.id, 1200);
      const manifest = await value.session.stop(); return { manifest, held };
    } finally { if (value) { await value.session.cancel(); await value.cleanup(); } globalThis.Worker = NativeWorker; }
  });
  assert.equal(result.held, 1); assert.equal(result.manifest.state, 'interrupted'); assert.match(result.manifest.recoveryNote, /mixer.*acknowledge/i);
}));

test('empty drain acknowledgements cannot complete a short saved recording', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const NativeRecorder = MediaRecorder; let requests = 0, stops = 0;
    globalThis.MediaRecorder = class extends NativeRecorder {
      retired = false;
      constructor(...args) {
        super(...args);
        super.addEventListener('dataavailable', event => {
          if (this.retired && event.data.size) event.stopImmediatePropagation();
        });
      }
      requestData() { requests++; this.dispatchEvent(new BlobEvent('dataavailable', { data: new Blob() })); }
      stop() { stops++; this.retired = true; return super.stop(); }
    };
    const { fixture, waitForActiveTime } = await import('/test/capture-fixture.mjs'); let value;
    try {
      value = await fixture('screen', false); await value.session.start();
      await waitForActiveTime(value.store, value.id, 2800);
      const before = performance.now(), manifest = await value.session.stop();
      return { manifest, states: value.states, requests, stops, stopMs: performance.now() - before,
        released: [...value.feeds[0].getTracks(), ...value.session.preview.getTracks()].every(track => track.readyState === 'ended') };
    } finally { if (value) { await value.session.cancel(); await value.cleanup(); } globalThis.MediaRecorder = NativeRecorder; }
  });
  assert.equal(result.manifest.state, 'interrupted'); assert.equal(result.states.includes('complete'), false);
  assert.match(result.manifest.recoveryNote, /coverage/); assert.ok(result.requests > 0);
  assert.equal(result.stops, 2); assert.equal(result.released, true); assert.ok(result.stopMs < 15000);
  assert.ok(result.manifest.tracks.every(track => track.bytes > 0));
}));

test('cancel during saved playback verification cannot publish complete', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { fixture, waitForActiveTime } = await import('/test/capture-fixture.mjs');
    const createElement = document.createElement, value = await fixture('screen', false);
    let parked, announce, holding = true;
    const entered = new Promise(resolve => { announce = resolve; });
    document.createElement = function(name, ...args) {
      const element = Reflect.apply(createElement, this, [name, ...args]);
      if (name === 'video') element.addEventListener('loadeddata', event => {
        if (holding) { event.stopImmediatePropagation(); parked = element; announce(); }
      });
      return element;
    };
    try {
      await value.session.start(); await waitForActiveTime(value.store, value.id, 1200);
      const stopping = value.session.stop(); let deadline;
      try { await Promise.race([entered, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Playback verification was not observed')), 5000); })]); }
      finally { clearTimeout(deadline); }
      const cancelAt = value.states.length, canceling = value.session.cancel();
      // Let cancel claim ownership before releasing the real decode callback.
      await Promise.resolve(); holding = false; parked.dispatchEvent(new Event('loadeddata'));
      const manifest = await stopping; await canceling;
      return { manifest, afterCancel: value.states.slice(cancelAt), drafts: await value.store.list(),
        released: [...value.feeds[0].getTracks(), ...value.session.preview.getTracks()].every(track => track.readyState === 'ended') };
    } finally { holding = false; document.createElement = createElement; await value.session.cancel(); await value.cleanup(); }
  });
  assert.equal(result.manifest.state, 'failed'); assert.equal(result.afterCancel.includes('complete'), false);
  assert.deepEqual(result.drafts, []); assert.equal(result.released, true);
}));

test('an inactive recorder still owes its queued Stop acknowledgement', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const NativeRecorder = MediaRecorder, recorders = []; let acknowledged = false;
    globalThis.MediaRecorder = class extends NativeRecorder {
      constructor(...args) {
        super(...args); recorders.push(this);
        if (recorders.length === 1) {
          let replayed = false;
          super.addEventListener('stop', event => {
            if (!replayed) {
              event.stopImmediatePropagation();
              setTimeout(() => { replayed = true; acknowledged = true; this.dispatchEvent(new Event('stop')); }, 400);
            }
          });
        }
      }
    };
    const { fixture, waitForActiveTime } = await import('/test/capture-fixture.mjs'); let value;
    try {
      value = await fixture('screen', false); await value.session.start();
      await waitForActiveTime(value.store, value.id, 1200);
      recorders[0].stop(); assertInactive();
      // An error may observe inactive before the final data/Stop tasks dispatch.
      recorders[0].dispatchEvent(new Event('error'));
      const manifest = await value.session.stop();
      return { manifest, acknowledged,
        released: [...value.feeds[0].getTracks(), ...value.session.preview.getTracks()].every(track => track.readyState === 'ended') };
    } finally { if (value) { await value.session.cancel(); await value.cleanup(); } globalThis.MediaRecorder = NativeRecorder; }
    function assertInactive() { if (recorders[0].state !== 'inactive') throw new Error('The native recorder did not enter inactive'); }
  });
  assert.equal(result.manifest.state, 'interrupted'); assert.equal(result.acknowledged, true);
  assert.equal(result.released, true); assert.ok(result.manifest.tracks.every(track => track.bytes > 0));
}));

test('one verified all-track read hashes each closed chunk once and freshly detects changed bytes', { timeout: 45000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { createDraftStore } = await import('/src/capture/storage.ts');
    const store = await createDraftStore(), id = crypto.randomUUID();
    const kinds = ['screen', 'camera', 'microphone', 'tab-audio', 'composed'];
    const manifest = { schema: 'rushes.browser-recording/1', id, title: 'Generated verified read', createdAt: new Date().toISOString(),
      mode: 'screen-camera', state: 'recording', durationMs: 0, epochMs: 1,
      tracks: kinds.map(kind => ({ kind, mimeType: kind.includes('audio') || kind === 'microphone' ? 'audio/webm' : 'video/webm', startOffsetMs: 0, chunks: [], bytes: 0 })),
      pauses: [], events: [], bubble: { x: 0, y: 0, size: 180 }, lastCheckpointMs: 0, persistent: false, backupFolder: false };
    const expected = new Map(kinds.map(kind => [kind, []]));
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const hash = async blob => [...new Uint8Array(await digest('SHA-256', await blob.arrayBuffer()))].map(value => value.toString(16).padStart(2, '0')).join('');
    // On old source this follows the real per-track drain path, rather than
    // failing merely because the new batch method does not exist.
    const readAll = async () => {
      if (store.readSnapshot) return store.readSnapshot(id);
      const tracks = new Map();
      for (const kind of kinds) tracks.set(kind, await store.trackBlob(id, kind));
      return { tracks };
    };
    await store.create(manifest);
    try {
      for (let sequence = 0; sequence < 20; sequence++) for (const [index, kind] of kinds.entries()) {
        const bytes = new Uint8Array(64 * 1024); bytes.fill(index * 37 + sequence * 3);
        const blob = new Blob([bytes], { type: manifest.tracks[index].mimeType }); expected.get(kind).push(blob);
        await store.append(id, kind, sequence, blob, (sequence + 1) * 100);
      }
      const fileRead = FileSystemFileHandle.prototype.getFile;
      let chunkReads = 0, digestCalls = 0, digestBytes = 0, snapshot;
      FileSystemFileHandle.prototype.getFile = function(...args) {
        if (/^(screen|camera|microphone|tab-audio|composed)-\d{5}\.bin$/.test(this.name)) chunkReads++;
        return fileRead.apply(this, args);
      };
      crypto.subtle.digest = function(algorithm, bytes) { digestCalls++; digestBytes += bytes.byteLength; return digest(algorithm, bytes); };
      const started = performance.now();
      try { snapshot = await readAll(); }
      finally { FileSystemFileHandle.prototype.getFile = fileRead; crypto.subtle.digest = digest; }
      const elapsedMs = performance.now() - started;
      const exact = await Promise.all(kinds.map(async kind => ({ kind, bytes: snapshot.tracks.get(kind).size,
        expectedBytes: new Blob(expected.get(kind)).size, sha: await hash(snapshot.tracks.get(kind)), expectedSha: await hash(new Blob(expected.get(kind))) })));
      const root = await navigator.storage.getDirectory();
      const folder = await (await root.getDirectoryHandle('rushes-browser-v1')).getDirectoryHandle(id);
      const handle = await folder.getFileHandle('camera-00000.bin');
      const rewrite = async blob => { const writer = await handle.createWritable(); await writer.write(blob); await writer.close(); };
      const altered = new Uint8Array(await expected.get('camera')[0].arrayBuffer()); altered[0] ^= 1;
      await rewrite(new Blob([altered]));
      let sameSizeCorruptionRejected = false;
      try { await readAll(); } catch (error) { sameSizeCorruptionRejected = /checksum/i.test(error.message); }
      await rewrite(expected.get('camera')[0]);
      const extra = new Blob(['newly closed chunk'], { type: 'video/webm' });
      await store.append(id, 'camera', 20, extra, 2100); expected.get('camera').push(extra);
      const fresh = await readAll();
      const appendedBytes = fresh.tracks.get('camera').size, expectedAppendedBytes = new Blob(expected.get('camera')).size;
      const appendedSha = await hash(fresh.tracks.get('camera')), expectedAppendedSha = await hash(new Blob(expected.get('camera')));
      // An incomplete journal retains bytes; a subsequent verified read cannot
      // reuse its earlier success after a recognized chunk disappears.
      await folder.removeEntry('composed-00003.bin');
      let missingRejected = false;
      try { await readAll(); } catch { missingRejected = true; }
      return { chunkReads, digestCalls, digestBytes, elapsedMs, chunkCount: 100, rawBytes: 100 * 64 * 1024,
        exact, sameSizeCorruptionRejected, appendedBytes, expectedAppendedBytes, appendedSha, expectedAppendedSha,
        earlierSnapshotBytes: snapshot.tracks.get('camera').size, missingRejected };
    } finally { await store.remove(id); }
  });
  assert.ok(result.exact.every(row => row.bytes === row.expectedBytes && row.sha === row.expectedSha));
  assert.equal(result.sameSizeCorruptionRejected, true); assert.equal(result.missingRejected, true);
  assert.equal(result.appendedBytes, result.expectedAppendedBytes); assert.equal(result.appendedSha, result.expectedAppendedSha);
  assert.equal(result.earlierSnapshotBytes, 20 * 64 * 1024);
  console.log('Verified all-track read control', JSON.stringify({ chunkReads: result.chunkReads, digestCalls: result.digestCalls,
    digestBytes: result.digestBytes, rawBytes: result.rawBytes, elapsedMs: result.elapsedMs, exactBytes: true,
    sameSizeCorruptionRejected: result.sameSizeCorruptionRejected, missingRejected: result.missingRejected, freshAppend: true }));
  assert.equal(result.chunkReads, result.chunkCount, 'one fresh verified all-track pass reads each closed chunk once');
  assert.equal(result.digestCalls, result.chunkCount, 'each returned chunk must actually pass its digest check once');
  assert.equal(result.digestBytes, result.rawBytes);
}));

test('cancel during a verified snapshot cannot revive the take or publish complete', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const { fixture, waitForActiveTime } = await import('/test/capture-fixture.mjs');
    const value = await fixture('screen', false), read = value.store.readSnapshot.bind(value.store);
    let announce, release, first = true;
    const entered = new Promise(resolve => { announce = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    value.store.readSnapshot = async id => {
      const snapshot = await read(id);
      if (first) { first = false; announce(); await held; }
      return snapshot;
    };
    try {
      await value.session.start(); await waitForActiveTime(value.store, value.id, 1200);
      const stopping = value.session.stop(); let timer;
      try { await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No verified snapshot observed')), 5000); })]); }
      finally { clearTimeout(timer); }
      const cancelAt = value.states.length, canceling = value.session.cancel();
      await Promise.resolve();
      const endedWhileHeld = [...value.feeds[0].getTracks(), ...value.session.preview.getTracks()].every(track => track.readyState === 'ended');
      release(); const manifest = await stopping; await canceling;
      return { state: manifest.state, states: value.states.slice(cancelAt), endedWhileHeld, drafts: await value.store.list() };
    } finally { release(); await value.session.cancel(); await value.cleanup(); }
  });
  assert.equal(result.state, 'failed'); assert.equal(result.states.includes('complete'), false);
  assert.equal(result.endedWhileHeld, true); assert.deepEqual(result.drafts, []);
}));

test('final playback verifies a new snapshot after every native Stop acknowledgement', { timeout: 30000 }, async () => pageFixture(async page => {
  const result = await page.evaluate(async () => {
    const NativeRecorder = MediaRecorder; let stopEvents = 0, encoders = 0;
    globalThis.MediaRecorder = class extends NativeRecorder {
      constructor(...args) { super(...args); encoders++; this.addEventListener('stop', () => { stopEvents++; }); }
    };
    const { fixture, waitForActiveTime } = await import('/test/capture-fixture.mjs'); let value;
    try {
      value = await fixture('screen', true); const read = value.store.readSnapshot.bind(value.store), reads = [];
      value.store.readSnapshot = async id => {
        const stopsAtReadStart = stopEvents, snapshot = await read(id);
        reads.push({ stopsAtReadStart, bytes: [...snapshot.tracks].map(([kind, blob]) => [kind, blob.size]) }); return snapshot;
      };
      await value.session.start(); await waitForActiveTime(value.store, value.id, 2200);
      const manifest = await value.session.stop();
      return { manifest, reads, encoders, stopEvents };
    } finally { if (value) { await value.session.cancel(); await value.cleanup(); } globalThis.MediaRecorder = NativeRecorder; }
  });
  assert.equal(result.manifest.state, 'complete'); assert.ok(result.reads.length >= 2);
  assert.equal(result.reads[0].stopsAtReadStart, 0);
  assert.equal(result.stopEvents, result.encoders); assert.equal(result.reads.at(-1).stopsAtReadStart, result.encoders);
  assert.deepEqual(result.reads.at(-1).bytes, result.manifest.tracks.map(track => [track.kind, track.bytes]));
}));

test('native startup timeout freezes before cleanup and reports after release even when detail is refused', { timeout: 35000 }, async () => pageFixture(async page => {
  const rows = await page.evaluate(async () => {
    const { createCaptureSession } = await import('/src/capture/index.ts');
    const { createDraftStore } = await import('/src/capture/storage.ts');
    const NativeRecorder = MediaRecorder, result = [];
    for (const refuse of [false, true]) {
      const order = [], encoders = [];
      class HeldRecorder extends EventTarget {
        static isTypeSupported(value) { return NativeRecorder.isTypeSupported(value); }
        state = 'inactive';
        constructor(stream, options) { super(); this.mimeType = options.mimeType; encoders.push(this); }
        start() { this.state = 'recording'; } // Deliberately withhold the native start event.
        stop() { order.push('stop'); this.state = 'inactive'; this.dispatchEvent(new Event('stop')); }
      }
      globalThis.MediaRecorder = HeldRecorder;
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const context = canvas.getContext('2d'); context.fillRect(0, 0, 1280, 720);
      const screen = canvas.captureStream(30), store = await createDraftStore(), id = crypto.randomUUID();
      let session, detail, releasedAtWarning;
      try {
        session = await createCaptureSession({ id, title: 'Controlled missing native start event', mode: 'screen', screen,
          store, persistent: false, backupFolder: false, onWarning(message, value) {
            if (value?.type !== 'encoder-start') return;
            detail = value; releasedAtWarning = screen.getTracks().every(track => track.readyState === 'ended');
            order.push('warning'); if (refuse) throw new Error('Controlled detail refusal');
          } });
        let error;
        try { await session.start(); } catch (value) { error = value.message; }
        const saved = await store.load(id);
        result.push({ refuse, error, detail, releasedAtWarning, order, state: saved.state,
          refusalRetained: saved.events.some(event => event.kind === 'startup-warning-refused'),
          frozen: Object.isFrozen(detail) && Object.isFrozen(detail.encoders) && detail.encoders.every(Object.isFrozen),
          allInactive: encoders.every(value => value.state === 'inactive') });
      } finally { await session?.cancel(); screen.getTracks().forEach(track => track.stop()); globalThis.MediaRecorder = NativeRecorder; }
    }
    return result;
  });
  for (const row of rows) {
    assert.match(row.error, /screen encoder did not start/); assert.equal(row.state, 'interrupted');
    assert.equal(row.detail.released, false); assert.equal(row.releasedAtWarning, true);
    assert.ok(row.detail.elapsedMs >= 9900); assert.equal(row.detail.audio, null);
    assert.deepEqual(row.detail.encoders.map(value => value.slice(1)), [['recording', 1, 1, 0, 0, 0, 0], ['recording', 1, 1, 0, 0, 0, 0]]);
    assert.ok(row.detail.tracks.every(value => value[1] === 'live'));
    assert.equal(row.order[0], 'warning'); assert.equal(row.order.filter(value => value === 'stop').length, 2);
    assert.equal(row.refusalRetained, row.refuse); assert.equal(row.frozen, true); assert.equal(row.allInactive, true);
  }
}));
