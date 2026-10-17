import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import * as nativeFiles from 'node:fs';
import * as filesystem from 'node:fs/promises';
// Isolated fixture IO is independent of the production capture bundle.
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { matrixMedia } from './matrix-media.mjs';
import { synchronizedMedia } from './synchronized-media.mjs';
import { qualifyNativeReference } from './native-reference-analysis.mjs';
import { requireQualifiedOrdinalStimulus } from './matrix-calibration.mjs';
import { requireDecodedAlignment } from './media-coordinates.mjs';
import { decodedSync } from './decoded-media.mjs';
import { productSyncSourceVerdict, requireProductSyncSource } from './matrix-source-qualification.mjs';
import { inspectHistogramPayload } from './matrix-native-observation.mjs';
import { macHostState, isVerifiedUnlockedMac, assertUnlockedMac, monitorMacLock } from './matrix-host-state.mjs';
import { nativeClockSeed } from './native-clock-seed.mjs';
import { beginColdTrace, requireNativeClockTrace } from './cold-trace.mjs';

const run = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = async (operation, milliseconds, label) => {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
  })]); } finally { clearTimeout(timer); }
};
const { mkdtemp, writeFile, readFile, mkdir, access } = filesystem;
const long = process.env.RUSHES_M1_LONG === '1';
const reference = process.env.RUSHES_M1_REFERENCE === '1';
if (long && reference) throw new Error('Choose full600s or bounded180s reference');
const targetMs = long ? 600000 : reference ? 180000 : 8000;
const sourceMode = process.env.RUSHES_M1_SOURCE_MODE || 'native-feedback';
if (!['native-feedback', 'native-reference', 'container'].includes(sourceMode)) throw new Error('Unknown matrix source mode');
const sourceControl = process.env.RUSHES_M1_SOURCE_CONTROL === '1';
if (sourceControl && (sourceMode !== 'container' || long || reference)) throw new Error('Direct control requires bounded8s container mode');
const allocationDiagnostic = process.env.RUSHES_M1_ALLOCATION_DIAGNOSTIC === '1';
const diagnostic = process.env.RUSHES_M1_DIAGNOSTIC === '1' || allocationDiagnostic;
const nativeTraceRequested = process.env.RUSHES_M1_NATIVE_TRACE_PROOF === '1';
if (process.env.RUSHES_M1_NATIVE_TRACE_PROOF !== undefined && !nativeTraceRequested) throw new Error('Native trace option must be1');
if (nativeTraceRequested && (sourceMode !== 'native-reference' || long || reference || diagnostic || sourceControl))
  throw new Error('Native audio tracing is limited to the existing short supplied-reference qualification');
const diagnosticDurationMs = allocationDiagnostic ? 180000 : 240000;
const macLockRequired = allocationDiagnostic || (long && process.platform === 'darwin');
const root = fileURLToPath(new URL('..', import.meta.url));
const proof = resolve(process.env.RUSHES_M1_PROOF || await mkdtemp(join(tmpdir(), 'rushes-m1-')));
await mkdir(proof, { recursive: true, mode: 0o700 });
const profile = join(proof, 'isolated-chrome-profile');
const evidence = { schema: 'rushes.independent-m1/1', startedAt: new Date().toISOString(),
  node: process.version, platform: process.platform, long, reference, sourceMode, sourceControl, sourceRevision: (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
  normalBackgroundFlags: true, source: 'native Chrome fake MJPEG with frame-fed optical ordinal and dual-frequency AudioWorklet ordinal',
  fixtureImage: process.env.RUSHES_M1_ENTROPY === '1' ? 'pixel entropy stress' : 'moving detailed 12px tiles',
  physicalPermissions: 'not tested', nativeMinimizedWindow: 'not tested; headless virtual pages only',
  diagnostic, allocationDiagnostic, samples: [], actions: [], checks: [], failures: [], browserStderr: [], lifecycle: [], hostTimeline: [], nativeAllocationSamples: [], fixturePages: [], appRequests: [] };
evidence.fileHashes = {};
for (const filename of ['test/matrix.mjs', 'test/matrix-fixture.mjs', 'test/matrix-media.mjs', 'test/matrix-source.worker.mjs', 'test/matrix-native-observation.mjs', 'test/matrix-host-state.mjs', 'test/matrix-calibration.mjs', 'test/matrix-tone.worklet.mjs', 'test/media-coordinates.mjs', 'test/decoded-media.mjs', 'test/synchronized-media.mjs',
  'test/matrix-source-qualification.mjs', 'test/native-reference-clock.mjs', 'test/native-reference-witness.mjs', 'test/native-reference-analysis.mjs', 'src/capture/index.ts', 'src/capture/audio.ts', 'src/capture/audio-frame.ts', 'src/capture/audio.worker.ts', 'src/capture/pcm-mixer.ts', 'src/capture/composition.worker.ts', 'src/capture/storage.ts'])
  evidence.fileHashes[filename] = createHash('sha256').update(await readFile(join(root, filename))).digest('hex');
for (const filename of ['test/native-clock-seed.mjs', 'test/cold-trace.mjs'])
  evidence.fileHashes[filename] = createHash('sha256').update(await readFile(join(root, filename))).digest('hex');
evidence.fileHashes['src/capture/cadence.ts'] = createHash('sha256').update(await readFile(join(root, 'src/capture/cadence.ts'))).digest('hex');
evidence.fileHashes['test/native-optical-roi.mjs'] = createHash('sha256').update(await readFile(join(root, 'test/native-optical-roi.mjs'))).digest('hex');
evidence.lifecycle.push({ name: 'decode-tool-identity-start', at: new Date().toISOString() });
await writeFile(join(proof, 'metrics.json'), JSON.stringify(evidence, null, 2));
evidence.ffmpeg = (await run(process.env.RUSHES_FFMPEG || 'ffmpeg', ['-version'], { timeout: 5000 })).stdout.split('\n')[0];
evidence.ffprobe = (await run(process.env.RUSHES_FFPROBE || 'ffprobe', ['-version'], { timeout: 5000 })).stdout.split('\n')[0];
const check = (name, operation) => {
  try { operation(); evidence.checks.push({ name, passed: true }); }
  catch (error) { evidence.checks.push({ name, passed: false, message: error.message }); evidence.failures.push(`${name}: ${error.message}`); }
};
const save = () => writeFile(join(proof, 'metrics.json'), JSON.stringify(evidence, null, 2));
async function stage(name, details) { evidence.lifecycle.push({ name, ...details, at: new Date().toISOString() }); await save(); }
let processHandle, browser, server, origin, page;
let stderrWrites = Promise.resolve();
let histogramSession, hostMonitor, latestHostSample;
let nativeTrace, nativeTraceFinished = false;
async function finishNativeTrace(context) {
  if (!nativeTrace || nativeTraceFinished) return;
  nativeTraceFinished = true;
  try {
    evidence.nativeTrace = await nativeTrace.finish(context);
    const capability = evidence.recording?.metrics.clockCapability ?? evidence.preparationMetrics?.clockCapability;
    evidence.nativeClockTrace = requireNativeClockTrace(evidence.nativeTrace, capability);
  } catch (error) { evidence.failures.push(`Native trace: ${error.stack || error}`); }
  await save();
}
evidence.macHostPrerequisite = { required: macLockRequired, continuousLongMonitor: long && !diagnostic && process.platform === 'darwin',
  scope: process.platform === 'darwin' ? 'Mac lock prerequisite only; no physical background or display-on claim' : 'Mac lock evidence is not applicable on this platform' };
const histogramName = 'Media.VideoCapture.Track.FrameDrop.DeviceCapture';

async function mediaFileEvidence(path) {
  const digest = createHash('sha256');
  for await (const bytes of nativeFiles.createReadStream(path)) digest.update(bytes);
  return { path, bytes: (await filesystem.stat(path)).size, sha256: digest.digest('hex') };
}
async function recordHostLoss(host) {
  if (evidence.hostPrerequisiteLost) return;
  evidence.hostPrerequisiteLost = host;
  evidence.failures.push(`Mac unlocked prerequisite lost or unverified: ${JSON.stringify(host)}`);
  await save();
  if (page && browser?.isConnected()) {
    try { evidence.hostLossBeforeStop = await page.evaluate(() => window.matrixTake?.snapshot()); }
    catch (error) { evidence.hostLossBeforeStopError = String(error); }
    try { await page.evaluate(() => window.matrixTake?.session.stop()); }
    catch (error) { evidence.hostLossStopError = String(error); }
    try { evidence.hostLossAfterStop = await page.evaluate(() => window.matrixTake?.snapshot()); }
    catch (error) { evidence.hostLossAfterStopError = String(error); }
    await save();
  }
}
async function requireUnlockedHost(stage) {
  if (!macLockRequired) return;
  hostMonitor?.assert();
  const host = { ...await macHostState(), stage };
  evidence.hostTimeline.push(host); latestHostSample = host;
  if (!isVerifiedUnlockedMac(host)) await recordHostLoss(host);
  assertUnlockedMac(host, stage);
  hostMonitor?.assert();
}
async function startMatrixTake(options = {}) {
  await requireUnlockedHost('before-media-preparation');
  await stage('page-preparation-start');
  const clockSeed = sourceMode === 'native-reference' && !evidence.recording ? await nativeClockSeed(page) : undefined;
  await bounded(page.evaluate(async options => {
    const { prepareMatrix } = await import('/test/matrix-fixture.mjs');
    window.matrixTake = await prepareMatrix(options);
  }, { ...options, sourceMode, referenceWitness: sourceMode === 'native-reference' && !evidence.recording, clockSeed }), 30000, 'Matrix page preparation');
  await stage('page-preparation-ready');
  await requireUnlockedHost('before-recording-start');
  await bounded(page.evaluate(() => window.matrixTake.start()), 30000, 'Matrix recording startup');
  await stage('recording-started');
}
async function nativeAllocationProbe() {
  const result = { startedAt: new Date().toISOString() };
  try { result.tracks = await page.evaluate(() => window.matrixTake.nativeTrackStats()); }
  catch (error) { result.tracks = { availability: 'error', message: String(error) }; }
  try {
    const { histogram } = await histogramSession.send('Browser.getHistogram', { name: histogramName, delta: true });
    result.histogram = inspectHistogramPayload(histogram, histogramName);
  } catch (error) { result.histogram = { availability: 'absent-or-error', name: histogramName, delta: true, message: String(error) }; }
  result.endedAt = new Date().toISOString(); evidence.nativeAllocationSamples.push(result); return result;
}

async function chromeExecutable() {
  if (process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE) return process.env.RUSHES_CAPTURE_BROWSER_EXECUTABLE;
  const channel = process.env.RUSHES_CAPTURE_BROWSER || 'chrome';
  if (channel !== 'chrome') throw new Error('This native-process matrix requires stable chrome or RUSHES_CAPTURE_BROWSER_EXECUTABLE.');
  const candidates = process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32' ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).map(base => join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch { /* Try the next installed stable path. */ } }
  throw new Error('Installed stable Chrome was not found. Supply RUSHES_CAPTURE_BROWSER_EXECUTABLE.');
}
async function launch(media) {
  const executable = await chromeExecutable();
  evidence.browserExecutable = await mediaFileEvidence(executable);
  await requireUnlockedHost('before-browser-launch');
  const options = new Map([['headless', 'new'], ['remote-debugging-port', 0], ['user-data-dir', profile],
    ['no-first-run', true], ['no-default-browser-check', true], ['use-fake-device-for-media-stream', true],
    ['use-fake-ui-for-media-stream', true], ['use-file-for-fake-video-capture', media.video],
    ['use-file-for-fake-audio-capture', media.audio], ['autoplay-policy', 'no-user-gesture-required']]);
  if (media.container) {
    options.delete('use-file-for-fake-video-capture'); options.delete('use-file-for-fake-audio-capture');
  }
  const args = [...options].map(([name, value]) => value === true ? `--${name}` : `--${name}=${value}`);
  args.push('about:blank');
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
  evidence.launchArguments = args.map(arg => arg.startsWith('--user-data-dir=') ? '--user-data-dir=<isolated proof>'
    : arg.startsWith('--use-file-') ? arg.split('=')[0] + '=<synthetic file>' : arg);
  assert.ok(args.every(arg => !/disable-(background|renderer-backgrounding|hang-monitor)/.test(arg)));
  processHandle = spawn(executable, args, { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr = [];
  await writeFile(join(proof, 'owned-browser-pid.json'), JSON.stringify({ pid: processHandle.pid, profile }));
  processHandle.stderr.on('data', data => {
    const value = data.toString(); stderr.push(value); evidence.browserStderr.push({ at: new Date().toISOString(), value });
    stderrWrites = stderrWrites.then(() => filesystem.appendFile(join(proof, 'chrome-stderr.log'), value));
  });
  let endpoint;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (processHandle.exitCode !== null) throw new Error(`Chrome exited ${processHandle.exitCode}: ${stderr.join('').slice(-2500)}`);
    endpoint = stderr.join('').match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
    if (endpoint) break;
    await sleep(50);
  }
  if (!endpoint) throw new Error('Isolated Chrome did not start its headless test endpoint.');
  browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 }); evidence.chrome = browser.version();
  const context = browser.contexts()[0]; await context.setOffline(false);
  context.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/src/main.tsx' || pathname.startsWith('/api/')) evidence.appRequests.push(pathname);
  });
  page = context.pages()[0] || await context.newPage();
  const lifecycle = await context.newCDPSession(page);
  lifecycle.on('Page.lifecycleEvent', event => evidence.lifecycle.push({ at: new Date().toISOString(), ...event }));
  await lifecycle.send('Page.enable'); await lifecycle.send('Page.setLifecycleEventsEnabled', { enabled: true });
  page.on('crash', () => evidence.lifecycle.push({ at: new Date().toISOString(), name: 'page-crash' }));
  await page.goto(`${origin}/matrix-fixture`);
  const fixturePage = { title: await page.title(), appRootCount: await page.locator('#root').count() };
  evidence.fixturePages.push(fixturePage);
  assert.equal(fixturePage.title, 'Independent Rushes synthetic M1'); assert.equal(fixturePage.appRootCount, 0);
  return context;
}
async function killAbruptly() {
  const child = processHandle; if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') await run('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000 });
  else process.kill(-child.pid, 'SIGKILL');
  await bounded(new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); }), 5000, 'Owned matrix process exit');
  evidence.actions.push({ kind: 'abrupt-process-kill', pid: child.pid, at: new Date().toISOString() });
  browser = undefined; processHandle = undefined;
}
async function rss() {
  const pid = processHandle?.pid; if (!pid) return null;
  if (process.platform === 'win32') {
    const script = `$rows=Get-CimInstance Win32_Process;$ids=@(${pid});do{$prior=$ids.Count;foreach($p in $rows){if($ids -contains [int]$p.ParentProcessId -and $ids -notcontains [int]$p.ProcessId){$ids+=([int]$p.ProcessId)}}}while($ids.Count -ne $prior);$sum=0;foreach($id in $ids){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;if($p){$sum+=$p.WorkingSet64}};Write-Output $sum`;
    return Number((await run('powershell.exe', ['-NoProfile', '-Command', script])).stdout.trim());
  }
  const rows = (await run('ps', ['-axo', 'pid=,ppid=,rss='])).stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const ids = new Set([pid]); let previous = 0;
  while (ids.size !== previous) { previous = ids.size; for (const [child, parent] of rows) if (ids.has(parent)) ids.add(child); }
  return rows.filter(([child]) => ids.has(child)).reduce((total, row) => total + row[2] * 1024, 0);
}
async function sample(stage) {
  const [snapshot, processRss, host, nativeProbe] = await Promise.all([page.evaluate(() => window.matrixTake?.snapshot()), rss(),
    allocationDiagnostic ? macHostState() : Promise.resolve(null),
    allocationDiagnostic ? nativeAllocationProbe() : Promise.resolve(null)]);
  if (host) { evidence.hostTimeline.push(host); latestHostSample = host; }
  evidence.samples.push({ stage, at: new Date().toISOString(), rssBytes: processRss,
    elapsedMs: snapshot?.elapsedMs, heap: snapshot?.heap, inputFrames: snapshot?.metrics.frames['input-camera']?.count,
    outputFrames: snapshot?.metrics.frames['output-composed']?.count, pendingBytes: snapshot?.metrics.pendingBytes,
    workerFrameCount: snapshot?.metrics.workerEvents.filter(event => event.kind === 'progress').at(-1)?.frameCount,
    captureState: snapshot?.metrics.states.at(-1)?.state,
    inputStaleMs: snapshot?.metrics.frames['input-camera'] ? snapshot.wallMs - snapshot.metrics.frames['input-camera'].lastWallMs : null,
    outputStaleMs: snapshot?.metrics.frames['output-composed'] ? snapshot.wallMs - snapshot.metrics.frames['output-composed'].lastWallMs : null,
    visibility: snapshot?.visibilityState, focus: snapshot?.focused, host: host || latestHostSample || null,
    hostObservationAgeMs: latestHostSample?.endedAt ? Date.now() - Date.parse(latestHostSample.endedAt) : null, nativeProbe });
  return snapshot;
}
async function downloadTracks(manifest, directory) {
  await mkdir(directory, { recursive: true });
  const saved = {};
  for (const track of manifest.tracks) {
    const downloaded = page.waitForEvent('download');
    await page.evaluate(kind => window.matrixTake.download(kind), track.kind);
    const file = join(directory, `${track.kind}.webm`); await (await downloaded).saveAs(file); saved[track.kind] = file;
  }
  return saved;
}
async function probeFrames(file) {
  const { stdout } = await run(process.env.RUSHES_FFPROBE || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time,width,height', '-of', 'json', file], { maxBuffer: 32 * 1024 ** 2 });
  const frames = JSON.parse(stdout).frames;
  const pts = frames.map(frame => Number(frame.best_effort_timestamp_time));
  return { decodedFrameCount: pts.length, averageFps: (pts.length - 1) / (pts.at(-1) - pts[0]), width: frames[0]?.width, height: frames[0]?.height,
    firstPts: pts[0], lastPts: pts.at(-1), durationSeconds: pts.at(-1) - pts[0],
    maxGapMs: pts.slice(1).reduce((max, timestamp, index) => Math.max(max, (timestamp - pts[index]) * 1000), 0),
    gapsAbove250ms: pts.slice(1).flatMap((timestamp, index) => timestamp - pts[index] > 0.250001
      ? [{ beforeSeconds: pts[index], afterSeconds: timestamp, gapMs: (timestamp - pts[index]) * 1000 }] : []) };
}

async function runDiagnostic() {
  evidence.scope = `One bounded${diagnosticDurationMs / 1000}s foreground diagnostic; zero extra processor readers; constant tone; no M1/sync/background verdict`;
  evidence.source = 'Native fake MJPEG and constant-tone AudioWorklet; no extra processor consumers';
  if (allocationDiagnostic) {
    await requireUnlockedHost('before-allocation-diagnostic');
    histogramSession = await browser.newBrowserCDPSession();
    try { evidence.histogramBaseline = inspectHistogramPayload((await histogramSession.send('Browser.getHistogram', { name: histogramName, delta: true })).histogram, histogramName); }
    catch (error) { evidence.histogramBaseline = { availability: 'absent-or-error', message: String(error) }; }
  }
  await startMatrixTake({ diagnostic: true });
  await page.evaluate(duration => {
    setTimeout(() => { void window.matrixTake.session.stop(); }, duration - window.matrixTake.elapsed());
  }, diagnosticDurationMs);
  console.log(`Diagnostic ACTIVE${diagnosticDurationMs / 1000}s: ${evidence.chrome}; zero extra frame consumers, constant tone, real five recorders/OPFS/backup/preview.`);
  for (;;) {
    const snapshot = await sample('diagnostic-recording');
    if (allocationDiagnostic && evidence.samples.at(-1).host.IOConsoleLocked !== false) {
      evidence.hostPrerequisiteLost = evidence.samples.at(-1).host;
      await page.evaluate(() => window.matrixTake.session.stop()); break;
    }
    if (snapshot.metrics.states.at(-1).state !== 'recording') break;
    if (evidence.samples.length % 15 === 0) {
      await save(); console.log(`Diagnostic ${(snapshot.elapsedMs / 1000).toFixed(1)}s; existingworker frames ${evidence.samples.at(-1).workerFrameCount}; chunks ${snapshot.metrics.chunks.length}.`);
    }
    await sleep(2000);
  }
  const startedFinalization = Date.now(); let finishing = true;
  const monitor = (async () => { while (finishing) { await sample('diagnostic-finalization'); await sleep(250); } })();
  try { evidence.recording = await page.evaluate(() => window.matrixTake.finish()); }
  finally { finishing = false; await monitor; }
  evidence.finalizationMs = Date.now() - startedFinalization;
  hostMonitor?.assert();
  const manifest = evidence.recording.manifest;
  check('diagnostic has zero extra processor readers', () => assert.equal(evidence.recording.metrics.extraProcessorReaders, 0));
  check('diagnostic finishes complete', () => assert.equal(manifest.state, 'complete'));
  check('diagnostic effective duration within250ms of bounded target', () => assert.ok(Math.abs(manifest.durationMs - diagnosticDurationMs) <= 250));
  check('diagnostic observer errors are reported', () => assert.deepEqual(evidence.recording.metrics.observerErrors, []));
  const files = await downloadTracks(manifest, join(proof, 'normal-stop'));
  evidence.decoded = {}; evidence.audio = {};
  for (const kind of ['screen', 'camera', 'composed']) {
    evidence.decoded[kind] = await probeFrames(files[kind]);
    check(`${kind} diagnostic video decodes720p`, () => assert.deepEqual([evidence.decoded[kind].width, evidence.decoded[kind].height], [1280, 720]));
    check(`${kind} diagnostic decoded duration`, () => assert.ok(Math.abs(evidence.decoded[kind].durationSeconds * 1000 - manifest.durationMs) <= 250));
    check(`${kind} diagnostic decoded gaps`, () => assert.equal(evidence.decoded[kind].gapsAbove250ms.length, 0));
  }
  for (const kind of ['microphone', 'tab-audio', 'composed']) {
    const pcm = join(proof, `${kind}.pcm`);
    await run(process.env.RUSHES_FFMPEG || 'ffmpeg', ['-y', '-v', 'error', '-i', files[kind], '-vn', '-ar', '48000', '-ac', '1', '-f', 'f32le', pcm]);
    const bytes = await readFile(pcm), samples = bytes.length / 4;
    let square = 0; for (let index = 0; index < samples; index++) square += bytes.readFloatLE(index * 4) ** 2;
    evidence.audio[kind] = { durationSeconds: samples / 48000, rms: Math.sqrt(square / samples), decodedSamples: samples };
    check(`${kind} diagnostic audio is audible`, () => assert.ok(evidence.audio[kind].rms > 0.05));
    check(`${kind} diagnostic audio duration`, () => assert.ok(Math.abs(evidence.audio[kind].durationSeconds * 1000 - manifest.durationMs) <= 250));
  }
  evidence.memory = { baselineRssBytes: evidence.samples[0].rssBytes,
    peakRssBytes: Math.max(...evidence.samples.map(value => value.rssBytes || 0)),
    peakHeapBytes: Math.max(...evidence.samples.map(value => value.heap?.used || 0)),
    maxChunkBytes: Math.max(...evidence.recording.metrics.chunks.map(chunk => chunk.bytes)),
    peakPendingBytes: evidence.recording.metrics.peakPendingBytes,
    totalRecordedBytes: manifest.tracks.reduce((sum, track) => sum + track.bytes, 0) };
  evidence.backgroundCoverage = 'Not tested: no virtual tab activation; headless foreground diagnostic only';
  if (allocationDiagnostic) {
    await nativeAllocationProbe();
    const trackAvailability = evidence.nativeAllocationSamples.map(sample => Object.values(sample.tracks).map(track => track.availability));
    const histogramAvailable = evidence.nativeAllocationSamples.some(sample => sample.histogram.availability === 'available');
    const allTracksAvailable = trackAvailability.every(values => values.length === 2 && values.every(value => value === 'available'));
    const hostUnlocked = evidence.hostTimeline.every(sample => sample.IOConsoleLocked === false);
    evidence.nativeAllocationInterpretation = { trackCountersAvailable: allTracksAvailable, histogramAvailable, hostUnlocked,
      classification: allTracksAvailable && histogramAvailable && hostUnlocked && evidence.chrome === '155.0.8059.39' ? 'Counters observed; attribution still requires root review'
        : 'INCONCLUSIVE: missing counters/reporting or unsupported host state',
      reasonValues: { 15: 'buffer pool maximum count exceeded', 16: 'buffer pool allocation failed' },
      mappingVersionMatches: evidence.chrome === '155.0.8059.39',
      limitation: 'UMA events can be duplicated across tracks and delayed; counts are not a causal application diagnosis' };
    evidence.hostObservationCoverage = 'About2s lock/display/idle samples; unobserved intervals are not proven unlocked';
  }
}

try {
  await requireUnlockedHost('before-run-preparation');
  await stage('fixture-preparation-start');
  const media = sourceMode === 'container' ? { container: await synchronizedMedia(proof, long ? 630 : reference ? 195 : 20) } : process.env.RUSHES_M1_SOURCE_FILE ? { video: process.env.RUSHES_M1_SOURCE_FILE,
    audio: join(dirname(process.env.RUSHES_M1_SOURCE_FILE), 'calibration.wav') } : await matrixMedia(proof, { onStage: stage });
  await stage('fixture-preparation-ready');
  if (media.container) {
    media.video = media.container; media.audio = media.container;
    const decoded = await decodedSync(media.container, media.container);
    requireDecodedAlignment(decoded.points);
    evidence.sourceQualification = { qualified: true, sourceKind: 'encoded-common-content-timeline', source: 'One encoded A/V container with a common content timeline', decoded };
    evidence.source = 'Media-element tracks from independently decoded synchronized optical/tone container';
  }
  const [videoEvidence, audioEvidence] = await Promise.all([mediaFileEvidence(media.video), mediaFileEvidence(media.audio)]);
  evidence.sourceMediaFiles = { video: videoEvidence, audio: audioEvidence };
  server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error',
    plugins: [{ name: 'rushes-independent-matrix-fixture', configureServer(value) {
      if (media.container) value.middlewares.use('/matrix-media', (request, response) => {
        const bytes = nativeFiles.statSync(media.container).size;
        const match = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const first = match ? Number(match[1]) : 0, last = match?.[2] ? Number(match[2]) : bytes - 1;
        if (first > last || last >= bytes) { response.statusCode = 416; response.end(); return; }
        response.setHeader('Content-Type', 'video/webm'); response.setHeader('Accept-Ranges', 'bytes');
        response.setHeader('Content-Length', last - first + 1);
        if (match) { response.statusCode = 206; response.setHeader('Content-Range', `bytes ${first}-${last}/${bytes}`); }
        if (request.method === 'HEAD') response.end();
        else nativeFiles.createReadStream(media.container, { start: first, end: last }).pipe(response);
      });
      value.middlewares.use('/matrix-fixture', (_request, response) => { response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><title>Independent Rushes synthetic M1</title>'); });
    } }],
  });
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  await stage('browser-launch-start');
  const context = await launch(media);
  await stage('browser-launch-ready');
  if (nativeTraceRequested) nativeTrace = await beginColdTrace(browser, page, join(proof, 'native-trace'), { audioDiagnostics: true });
  if (long && !diagnostic && process.platform === 'darwin') {
    evidence.hostObservationCoverage = 'Independent approximately2s lock metadata monitor, with fresh reads before each launch/start; unobserved intervals are not proven unlocked';
    hostMonitor = monitorMacLock({ read: macHostState,
      onSample: host => { host.stage = 'continuous-long-host'; evidence.hostTimeline.push(host); latestHostSample = host; },
      onLoss: recordHostLoss });
  }
  if (sourceControl) {
    evidence.scope = 'Direct8s MediaElement/MediaRecorder control, no Rushes capture/compositor/storage; not M1 acceptance';
    evidence.directSource = await page.evaluate(async () => {
      const { directContainerControl } = await import('/test/matrix-fixture.mjs'); return directContainerControl(8000);
    });
    const downloaded = page.waitForEvent('download');
    await page.evaluate(() => {
      const url = URL.createObjectURL(window.directControlBlob), link = document.createElement('a');
      link.href = url; link.download = 'direct-source.webm'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });
    const file = join(proof, 'direct-source.webm'); await (await downloaded).saveAs(file);
    evidence.directSource.decoded = await probeFrames(file);
    check('direct source decoded duration within250ms', () => assert.ok(Math.abs(evidence.directSource.decoded.durationSeconds * 1000 - evidence.directSource.actualDurationMs) <= 250));
    check('direct source has no decoded gap over250ms', () => assert.equal(evidence.directSource.decoded.gapsAbove250ms.length, 0));
    evidence.directSource.sync = await decodedSync(file, file);
    check('direct source decoded alignment including uncertainty within100ms', () => requireDecodedAlignment(evidence.directSource.sync.points));
  }
  else if (diagnostic) await runDiagnostic();
  else {
  await startMatrixTake();
  if (!long) await page.evaluate(targetMs => {
    // A foreground smoke-only control clock keeps process/RSS polling latency
    // outside the target duration. Neither fake input nor composition uses it.
    void (async () => {
      while (window.matrixTake.elapsed() < targetMs) await new Promise(resolve => setTimeout(resolve, 25));
      await window.matrixTake.session.stop();
    })();
  }, targetMs);
  console.log(`M1 ${long ? '600-second' : reference ? '180-second reference' : 'quick smoke'}: ${evidence.chrome}, ${process.platform}, ${sourceMode} synthetic media, default throttling.`);
  const alternate = await context.newPage(); await alternate.goto(`${origin}/matrix-fixture?alternate`);
  await page.bringToFront();
  const pausesAt = long ? [60000, 160000, 260000, 360000, 460000] : reference ? [30000, 60000, 90000, 120000, 150000] : [1500, 2500, 3500, 4500, 5500];
  let pauseIndex = 0, offlineStarted, offlineEnded = false, switched = false, returned = false;
  for (;;) {
    const snapshot = await sample('recording'); hostMonitor?.assert(); const elapsed = snapshot.elapsedMs;
    if (snapshot.metrics.states.at(-1).state !== 'recording') break;
    if (pauseIndex < pausesAt.length && elapsed >= pausesAt[pauseIndex]) {
      await page.evaluate(() => window.matrixTake.pause()); await sleep(long ? 1000 : 100);
      await page.evaluate(() => window.matrixTake.resume()); evidence.actions.push({ kind: 'pause-resume', elapsedMs: elapsed }); pauseIndex++;
    }
    if (!offlineStarted && elapsed >= (long ? 80000 : 2000)) {
      await context.setOffline(true); offlineStarted = Date.now(); evidence.actions.push({ kind: 'offline-start', wall: offlineStarted, elapsedMs: elapsed });
    }
    if (offlineStarted && !offlineEnded && Date.now() - offlineStarted >= (long ? 300000 : 2000)) {
      await context.setOffline(false); offlineEnded = true; evidence.actions.push({ kind: 'offline-end', wall: Date.now(), milliseconds: Date.now() - offlineStarted });
    }
    if (!switched && elapsed >= (long ? 100000 : 2500)) {
      await alternate.bringToFront(); switched = true; evidence.actions.push({ kind: 'activate-alternate-page', elapsedMs: elapsed,
        actualVisibility: await page.evaluate(() => document.visibilityState), actualFocus: await page.evaluate(() => document.hasFocus()) });
    }
    if (switched && !returned && elapsed >= (long ? 420000 : 6000)) {
      await page.bringToFront(); returned = true; evidence.actions.push({ kind: 'return-recorder-page', elapsedMs: elapsed });
    }
    if (elapsed >= targetMs) break;
    if (evidence.samples.length % 15 === 0) { await save(); console.log(`M1 progress ${(elapsed / 1000).toFixed(1)}s; input ${snapshot.metrics.frames['input-camera'].count}, output ${snapshot.metrics.frames['output-composed'].count}.`); }
    await sleep(Math.max(1, Math.min(long ? 2000 : 100, targetMs - elapsed)));
  }
  await context.setOffline(false); await page.bringToFront();
  const finalizationStarted = Date.now(); let finishing = true;
  const monitor = (async () => { while (finishing) { await sample('finalization'); await sleep(250); } })();
  try { evidence.recording = await page.evaluate(() => window.matrixTake.finish()); }
  finally { finishing = false; await monitor; }
  evidence.finalizationMs = Date.now() - finalizationStarted;
  hostMonitor?.assert();
  // Keep the actual PCM even if a later shape/decode/phase guard rejects the run.
  if (sourceMode === 'native-reference') {
    const pending = page.waitForEvent('download');
    await page.evaluate(() => window.matrixTake.downloadSourceReference());
    const observationPath = join(proof, 'supplied-reference.f32le'); await (await pending).saveAs(observationPath);
    evidence.sourceObservationFile = await mediaFileEvidence(observationPath);
    await save();
  }
  // Retain PCM first. A diagnostic qualification failure must not discard media
  // or prevent the original independent source/decode predicates from running.
  await finishNativeTrace({ stage: 'normal-stop', manifest: evidence.recording.manifest.state });
  const manifest = evidence.recording.manifest;
  check('normal Stop is complete', () => assert.equal(manifest.state, 'complete'));
  check('observer faults are reported rather than accepted', () => assert.deepEqual(evidence.recording.metrics.observerErrors, []));
  check('at least five pauses', () => assert.ok(manifest.pauses.length >= 5));
  check('target take duration', () => assert.ok(Math.abs(manifest.durationMs - targetMs) <= 250));
  check('offline interval', () => assert.ok(evidence.actions.find(action => action.kind === 'offline-end')?.milliseconds >= (long ? 300000 : 2000)));
  check('chunk queue stays at or below 32 MiB', () => assert.ok(evidence.recording.metrics.peakPendingBytes <= 32 * 1024 ** 2));
  check('chunk writes serialize', () => assert.equal(evidence.recording.metrics.peakConcurrentAppends, 1));
  check('input gap at most 250 ms', () => assert.ok(evidence.recording.metrics.frames['input-camera'].maxTimestampGapUs <= 250000));
  check('composed output gap at most 250 ms', () => assert.ok(evidence.recording.metrics.frames['output-composed'].maxTimestampGapUs <= 250000));
  check('input never stalls over 250 ms while recording', () => assert.ok(
    evidence.samples.filter(value => value.captureState === 'recording').every(value => value.inputStaleMs <= 250)));
  check('output never stalls over 250 ms while recording', () => assert.ok(
    evidence.samples.filter(value => value.captureState === 'recording').every(value => value.outputStaleMs <= 250)));
  evidence.backgroundCoverage = evidence.recording.metrics.visibility.some(value => value.state === 'hidden')
    ? 'Observed hidden page; virtual tab activation only, physical minimization remains untested'
    : 'UNMEASURED: Chrome headless virtual tab activation did not make recorder visibility hidden';
  const files = await downloadTracks(manifest, join(proof, 'normal-stop'));
  evidence.decoded = {};
  for (const kind of ['screen', 'camera', 'composed']) {
    evidence.decoded[kind] = await probeFrames(files[kind]);
    check(`${kind} 720p decoded frames`, () => assert.deepEqual([evidence.decoded[kind].width, evidence.decoded[kind].height], [1280, 720]));
    check(`${kind} decoded duration`, () => assert.ok(Math.abs(evidence.decoded[kind].durationSeconds * 1000 - manifest.durationMs) <= 250));
    check(`${kind} no unexplained decoded gap over 250 ms`, () => assert.equal(evidence.decoded[kind].gapsAbove250ms.length, 0));
  }
  evidence.calibrationQualification = sourceMode !== 'container' ? requireQualifiedOrdinalStimulus(
    evidence.recording.metrics.calibrationInputEdges, evidence.recording.metrics.calibrationAudioEdges) : evidence.sourceQualification;
  if (sourceMode === 'native-feedback') evidence.inputAVPhase = 'Unknown: stimulus qualifies relative emission shape only; no encoder-start epoch inferred';
  if (sourceMode === 'native-reference') {
    evidence.sourceQualification = qualifyNativeReference(evidence.recording, await readFile(evidence.sourceObservationFile.path));
    evidence.inputAVPhase = 'Measured generated supplied-track reference phase only; physical sensor/playout timing remains unmeasured';
  }
  evidence.productSyncSource = productSyncSourceVerdict(sourceMode, evidence.sourceQualification);
  check('known input A/V phase is required for product-sync acceptance', () => requireProductSyncSource(sourceMode, evidence.sourceQualification));
  await save();
  evidence.sync = {};
  for (const kind of ['screen', 'camera', 'composed']) {
    evidence.sync[kind] = await decodedSync(files[kind], kind === 'composed' ? files.composed : files.microphone);
    check(`${kind} decoded beginning/middle/end sync within 100 ms`, () => requireDecodedAlignment(evidence.sync[kind].points));
    check(`${kind} decoded audio presentation gaps within250ms`, () => assert.ok(evidence.sync[kind].audioJoins.every(join => Math.abs(join.gapMs) <= 250)));
    check(`${kind} decoded audio duration agrees within 250 ms`, () => assert.ok(
      Math.abs(evidence.sync[kind].audioDurationSeconds * 1000 - manifest.durationMs) <= 250));
  }
  evidence.memory = { baselineRssBytes: evidence.samples[0].rssBytes,
    peakRssBytes: Math.max(...evidence.samples.map(value => value.rssBytes || 0)),
    peakFinalizationRssBytes: Math.max(...evidence.samples.filter(value => value.stage === 'finalization').map(value => value.rssBytes || 0)),
    peakHeapBytes: Math.max(...evidence.samples.map(value => value.heap?.used || 0)),
    maxChunkBytes: Math.max(...evidence.recording.metrics.chunks.map(chunk => chunk.bytes)),
    totalRecordedBytes: manifest.tracks.reduce((sum, track) => sum + track.bytes, 0) };
  await save(); console.log('Normal recording measurements saved; starting abrupt-kill recovery.');
  await alternate.close(); await page.reload();
  await startMatrixTake();
  await sleep(6500); evidence.beforeKill = await page.evaluate(() => window.matrixTake.snapshot());
  const killedAtElapsed = evidence.beforeKill.elapsedMs; await killAbruptly();
  await launch(media);
  // An alarm would expose any recovery path trying to reacquire fake or real media.
  await page.evaluate(() => { window.recoveryDeviceRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.recoveryDeviceRequests++; throw new Error('Recovery requested a device'); };
    navigator.mediaDevices.getDisplayMedia = async () => { window.recoveryDeviceRequests++; throw new Error('Recovery requested a screen'); }; });
  evidence.recovery = await page.evaluate(async id => {
    const { recoverMatrix } = await import('/test/matrix-fixture.mjs'); return recoverMatrix(id);
  }, evidence.beforeKill.id);
  evidence.recovery.measuredTailMs = killedAtElapsed - evidence.recovery.manifest.lastCheckpointMs;
  const acknowledged = evidence.beforeKill.manifest.tracks.flatMap(track => track.chunks);
  check('all acknowledged OPFS checkpoints survive process kill', () => {
    for (const chunk of acknowledged) assert.ok(evidence.recovery.chunks.some(saved => saved.track === chunk.track
      && saved.sequence === chunk.sequence && saved.actualDigest === chunk.sha256 && saved.actualBytes === chunk.bytes));
  });
  check('acknowledged closed backup chunks survive process kill', () => {
    for (const chunk of acknowledged) assert.ok(evidence.recovery.backupChunks.some(saved => saved.track === chunk.track
      && saved.sequence === chunk.sequence && saved.digest === chunk.sha256 && saved.bytes === chunk.bytes));
  });
  check('recovery marks interruption and never resumes media', () => {
    assert.equal(evidence.recovery.manifest.state, 'interrupted'); assert.equal(evidence.recovery.mediaDevicesWereRequested, false);
    assert.ok(evidence.recovery.manifest.recoveryNote.includes('encoder tail'));
    assert.ok(!evidence.recovery.activeLocks.some(lock => lock.name === `rushes-active-${evidence.beforeKill.id}`));
  });
  evidence.recoveryCounterControl = await page.evaluate(async () => {
    let message; try { await navigator.mediaDevices.getUserMedia({ video: true }); } catch (error) { message = String(error); }
    return { requests: window.recoveryDeviceRequests, message };
  });
  check('device-request counter detects a known attempted request without device access', () => {
    assert.equal(evidence.recoveryCounterControl.requests, 1);
    assert.ok(evidence.recoveryCounterControl.message.includes('Recovery requested a device'));
  });
  await page.reload();
  await startMatrixTake({ backup: false });
  await sleep(2500);
  const quotaSession = await browser.contexts()[0].newCDPSession(page);
  await quotaSession.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1 });
  await sleep(3500);
  evidence.quota = await page.evaluate(() => window.matrixTake.finish());
  await quotaSession.send('Storage.overrideQuotaForOrigin', { origin });
  check('actual reduced origin quota safely interrupts capture', () => {
    assert.equal(evidence.quota.manifest.state, 'interrupted'); assert.ok(evidence.quota.metrics.warnings.some(value => /storage/i.test(value)));
    assert.ok(evidence.quota.manifest.tracks.some(track => track.chunks.length > 0));
  });
  await page.reload();
  await startMatrixTake({ backup: false });
  await sleep(2500);
  await page.evaluate(() => {
    const prototype = FileSystemWritableFileStream.prototype, write = prototype.write;
    window.restoreWrite = () => { prototype.write = write; };
    prototype.write = function(...args) {
      if (args[0] instanceof Blob) return Promise.reject(new DOMException('M1 injected write failure at actual OPFS write call', 'NotReadableError'));
      return write.apply(this, args);
    };
  });
  await sleep(2500);
  evidence.writeFailure = await page.evaluate(async () => { window.restoreWrite(); return window.matrixTake.finish(); });
  check('OPFS write-call failure safely interrupts and retains prior bytes', () => {
    assert.equal(evidence.writeFailure.manifest.state, 'interrupted');
    assert.ok(evidence.writeFailure.manifest.tracks.some(track => track.chunks.length > 0));
    assert.ok(evidence.writeFailure.metrics.warnings.some(value => value.includes('M1 injected write failure')));
  });
  }
} catch (error) {
  evidence.failures.push(`Harness execution: ${error.stack || error}`); console.error(error);
  if (page) {
    try { evidence.preparationMetrics = await bounded(page.evaluate(() => globalThis.matrixPreparationMetrics), 1000, 'Preparation error read-back'); }
    catch (failure) { evidence.preparationReadFailure = String(failure); }
    try { evidence.observerErrors = await bounded(page.evaluate(() => globalThis.matrixObserverErrors), 1000, 'Observer error read-back'); }
    catch (failure) { evidence.observerErrorReadFailure = String(failure); }
  }
} finally {
  await finishNativeTrace({ stage: 'failure-or-final-retirement' });
  check('independent fixture pages never boot the Rushes App', () => assert.deepEqual(evidence.appRequests, []));
  if (hostMonitor) {
    try { await hostMonitor.stop(); hostMonitor.assert(); }
    catch (error) { evidence.failures.push(`Host lock monitor: ${error.stack || error}`); }
  }
  if (long && process.platform === 'darwin') check('long Mac experiment has verified unlocked host reads without prerequisite loss', () => {
    assert.ok(hostMonitor, 'the continuous long-mode monitor must have started');
    assert.ok(evidence.hostTimeline.some(host => host.stage === 'continuous-long-host'));
    assert.ok(evidence.hostTimeline.length > 0); assert.ok(evidence.hostTimeline.every(isVerifiedUnlockedMac));
    assert.equal(evidence.hostPrerequisiteLost, undefined);
  });
  evidence.endedAt = new Date().toISOString(); await stderrWrites; await save();
  try { if (browser) await bounded(browser.close(), 3000, 'Matrix browser close'); }
  catch (error) { evidence.failures.push(`Browser close: ${error}`); }
  if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null)
    await killAbruptly().catch(error => { evidence.failures.push(`Owned process cleanup: ${error}`); });
  await server?.close();
  await save();
}
console.log(JSON.stringify({ proof, chrome: evidence.chrome, long, memory: evidence.memory,
  backgroundCoverage: evidence.backgroundCoverage, checks: evidence.checks, failures: evidence.failures }, null, 2));
process.exitCode = evidence.failures.length ? 1 : 0;
