import { BROWSER_LIMITS, type BubblePlacement, type CaptureInputs, type CaptureSession, type CaptureState,
  type DraftManifest, type TrackKind } from '../contracts';

import { composedAudio } from './audio';

type FrameProcessor = { readable: ReadableStream<VideoFrame> };
type FrameGenerator = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type FrameAPIs = {
  MediaStreamTrackProcessor?: new (options: { track: MediaStreamTrack; maxBufferSize: number }) => FrameProcessor;
  MediaStreamTrackGenerator?: new (options: { kind: 'video' }) => FrameGenerator;
};
type RecorderSlot = { kind: TrackKind; recorder: MediaRecorder; sequence: number; ended: Promise<void>; started: boolean };
async function limited<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { if (deadline) clearTimeout(deadline); }
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const boundedBubble = (value: BubblePlacement): BubblePlacement => {
  if (![value.x, value.y, value.size].every(Number.isFinite)) throw new Error('Invalid camera bubble placement.');
  const size = Math.max(86, Math.min(432, value.size));
  return { x: Math.max(0, Math.min(BROWSER_LIMITS.width - size, value.x)),
    y: Math.max(0, Math.min(BROWSER_LIMITS.height - size, value.y)), size };
};
export function captureCapabilities(): { supported: boolean; reason?: string } {
  const apis = globalThis as unknown as FrameAPIs;
  if (!isSecureContext) return { supported: false, reason: 'Recording requires HTTPS or a local development origin.' };
  if (!apis.MediaStreamTrackProcessor || !apis.MediaStreamTrackGenerator || !globalThis.OffscreenCanvas || !globalThis.VideoFrame)
    return { supported: false, reason: 'Use supported desktop Chrome with frame processing enabled.' };
  if (!globalThis.MediaRecorder || !MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus'))
    return { supported: false, reason: 'Chrome could not provide the WebM recording codec.' };
  if (!navigator.storage?.getDirectory) return { supported: false, reason: 'Local recording storage is unavailable.' };
  return { supported: true };
}
class PlaybackDurationMismatch extends Error {
  constructor(readonly actualMs: number, readonly expectedMs: number, kind: TrackKind) {
    super(`The saved ${kind} duration (${Math.round(actualMs)} ms) does not match this ${Math.round(expectedMs)} ms recording. Original bytes remain available.`);
  }
}
export async function verifyPlayback(blob: Blob, videoTrack: boolean,
  expected?: { durationMs: number; kind: TrackKind }, budgetMs = 15_000): Promise<void> {
  if (!Number.isFinite(budgetMs) || budgetMs < 1 || budgetMs > 15_000) throw new Error('Invalid playback verification budget.');
  if (!blob.size) throw new Error('The recorder produced no playable bytes.');
  if (expected && (!Number.isFinite(expected.durationMs) || expected.durationMs < 0))
    throw new Error('The recording has no valid duration to verify. Saved bytes remain available.');
  const media = document.createElement(videoTrack ? 'video' : 'audio');
  const url = URL.createObjectURL(blob);
  media.preload = 'auto'; media.muted = true;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => settle(new Error(expected
        ? `The saved ${expected.kind} duration could not be verified before the playback deadline. Original bytes remain available.`
        : 'Playback verification timed out; saved originals remain available.')), budgetMs);
      let settled = false, seekingEnd = false;
      const settle = (error?: Error) => {
        if (settled) return; settled = true;
        clearTimeout(timer); media.onloadeddata = null; media.onerror = null; media.onseeked = null; media.ondurationchange = null;
        error ? reject(error) : resolve();
      };
      const inspectExtent = () => {
        if (!expected) { settle(); return; }
        if (!Number.isFinite(media.duration)) {
          if (!seekingEnd) {
            seekingEnd = true;
            try { media.currentTime = 1e6; }
            catch { settle(new Error(`The saved ${expected.kind} duration could not be measured. Original bytes remain available.`)); }
          }
          return;
        }
        if (media.duration < 0 || Math.abs(media.duration * 1000 - expected.durationMs) > 250)
          settle(new PlaybackDurationMismatch(media.duration * 1000, expected.durationMs, expected.kind));
        else settle();
      };
      media.onloadeddata = inspectExtent;
      media.ondurationchange = () => { if (seekingEnd) inspectExtent(); };
      media.onseeked = () => {
        if (!Number.isFinite(media.duration)) settle(new Error(`The saved ${expected?.kind ?? 'track'} duration could not be measured. Original bytes remain available.`));
        else inspectExtent();
      };
      media.onerror = () => settle(new Error(`The saved ${expected?.kind ?? 'track'} could not be decoded; original bytes have been retained.`));
      media.src = url; media.load();
    });
  } finally { media.removeAttribute('src'); media.load(); URL.revokeObjectURL(url); }
}

// Only already-granted streams enter this layer. There are no device permission calls.
export async function createCaptureSession(inputs: CaptureInputs): Promise<CaptureSession> {
  const capability = captureCapabilities();
  const sourceStreams = [inputs.screen, inputs.camera, inputs.microphone].filter((stream): stream is MediaStream => !!stream);
  const sources = [...new Set(sourceStreams.flatMap(stream => stream.getTracks()))];
  const releaseSources = () => sources.forEach(track => track.stop());
  const needsScreen = inputs.mode !== 'camera', needsCamera = inputs.mode !== 'screen';
  const screen = needsScreen ? inputs.screen?.getVideoTracks()[0] : undefined;
  const camera = needsCamera ? inputs.camera?.getVideoTracks()[0] : undefined;
  if (!capability.supported || (needsScreen && !screen) || (needsCamera && !camera) || sources.some(track => track.readyState !== 'live')) {
    releaseSources(); throw new Error(capability.reason ?? 'Choose live recording sources before starting.');
  }
  let initialBubble: BubblePlacement;
  try {
    initialBubble = boundedBubble(inputs.bubble ?? { x: 1040, y: 500, size: 180 });
    for (const track of [screen, camera]) if (track) {
      await track.applyConstraints({ width: { max: BROWSER_LIMITS.width }, height: { max: BROWSER_LIMITS.height },
        frameRate: { max: BROWSER_LIMITS.fps } });
    }
  } catch (error) { releaseSources(); throw new Error(`The selected source could not meet the 720p/30 recording limit: ${messageOf(error)}`); }
  const apis = globalThis as unknown as Required<FrameAPIs>;
  const clones: MediaStreamTrack[] = [];
  let generator: FrameGenerator;
  let worker: Worker;
  try {
    for (const track of [screen, camera]) if (track) clones.push(track.clone());
    generator = new apis.MediaStreamTrackGenerator({ kind: 'video' });
    try { worker = new Worker(new URL('./composition.worker.ts', import.meta.url), { type: 'module' }); }
    catch (error) { generator.stop(); throw error; }
  } catch (error) { clones.forEach(track => track.stop()); releaseSources(); throw error; }
  const preview = new MediaStream([generator]);
  let audio: ReturnType<typeof composedAudio> | undefined;
  let state: CaptureState = 'ready';
  let created = false, released = false, canceled = false, starting = false;
  let failure: string | undefined;
  let startedAt = 0, pauseAt = 0, pausedMs = 0, stoppedAt = 0;
  let saveTail: Promise<void> = Promise.resolve();
  let pendingBytes = 0;
  let ending: Promise<DraftManifest> | undefined;
  let canceling: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let takeDeadline: ReturnType<typeof setTimeout> | undefined;
  const takeCeilingMs = BROWSER_LIMITS.maxTakeSeconds * 1000;
  const takeStopAtMs = takeCeilingMs - Math.min(200, takeCeilingMs / 5);
  let abortInitialization: ((error: Error) => void) | undefined;
  let lastProgress = performance.now();
  const slots: RecorderSlot[] = [];
  const manifest: DraftManifest = {
    schema: 'rushes.browser-recording/1', id: inputs.id, title: inputs.title, createdAt: new Date().toISOString(),
    mode: inputs.mode, state, durationMs: 0, epochMs: 0, tracks: [], pauses: [], events: [],
    bubble: initialBubble, lastCheckpointMs: 0,
    persistent: inputs.persistent, backupFolder: inputs.backupFolder,
    ...(inputs.cloudRecordingId ? { cloudRecordingId: inputs.cloudRecordingId } : {}),
  };
  const elapsed = () => startedAt ? Math.max(0, (pauseAt || stoppedAt || performance.now()) - startedAt - pausedMs) : 0;
  const event = (kind: string, message?: string) => {
    manifest.events.push({ timeMs: startedAt ? performance.now() - startedAt : 0, kind, ...(message ? { message } : {}) });
  };
  const notify = (next: CaptureState) => { state = next; manifest.state = next; inputs.onState?.(next); };
  const warn = (message: string) => inputs.onWarning?.(message);
  function release() {
    if (released) return; released = true;
    if (timer) clearInterval(timer);
    if (takeDeadline) clearTimeout(takeDeadline);
    for (const { track, handler, name } of listeners) track.removeEventListener(name, handler);
    releaseSources(); clones.forEach(track => track.stop()); preview.getTracks().forEach(track => track.stop());
    audio?.close();
    worker.postMessage({ kind: 'stop' }); worker.terminate();
  }
  function fail(message: string) {
    if (canceled || ['complete', 'interrupted', 'failed'].includes(state)) return;
    failure ??= message; warn(message); event('failure', message);
    if (state === 'ready' && !created) { abortInitialization?.(new Error(message)); notify('failed'); release(); }
    else void finish().catch(error => { warn(messageOf(error)); release(); });
  }
  function activelyRecording(): boolean { return state === 'recording' && !released; }
  function stopAtLimit() {
    if (activelyRecording() && !ending) { event('take-limit'); void finish(); }
  }
  function armTakeDeadline() {
    if (takeDeadline) clearTimeout(takeDeadline);
    if (!activelyRecording()) return;
    const remaining = takeStopAtMs - elapsed();
    if (remaining <= 0) { stopAtLimit(); return; }
    takeDeadline = setTimeout(() => {
      if (state !== 'recording') return;
      if (elapsed() >= takeStopAtMs) stopAtLimit();
      else armTakeDeadline();
    }, remaining);
  }
  const listeners: { track: MediaStreamTrack; handler: EventListener; name: string }[] = [];
  for (const track of sources) {
    const ended = () => fail(`${track.kind} source ended. The saved portion is being finalized.`);
    const muted = () => { event('source-muted', track.kind); warn(`The ${track.kind} source is temporarily unavailable.`); };
    const unmuted = () => event('source-unmuted', track.kind);
    for (const [name, handler] of [['ended', ended], ['mute', muted], ['unmute', unmuted]] as const) {
      track.addEventListener(name, handler); listeners.push({ track, handler, name });
    }
  }
  function record(kind: TrackKind, stream: MediaStream, video: boolean) {
    const hasAudio = stream.getAudioTracks().length > 0;
    const mimeType = video ? (hasAudio ? 'video/webm;codecs=vp8,opus' : 'video/webm;codecs=vp8') : 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error(`No supported codec for ${kind}.`);
    const recorder = new MediaRecorder(stream, { mimeType,
      ...(video ? { videoBitsPerSecond: kind === 'camera' ? 1_500_000 : 4_000_000 } : {}),
      ...(hasAudio ? { audioBitsPerSecond: 128_000 } : {}),
    });
    const ended = new Promise<void>(resolve => recorder.addEventListener('stop', () => resolve(), { once: true }));
    const slot = { kind, recorder, sequence: 0, ended, started: false }; slots.push(slot);
    manifest.tracks.push({ kind, mimeType: recorder.mimeType, startOffsetMs: 0, startOffsetTimeBasis: 'media-recorder-start-event', chunks: [], bytes: 0 });
    recorder.addEventListener('dataavailable', eventValue => {
      if (!eventValue.data.size || canceled) return;
      const data = eventValue.data, sequence = slot.sequence++, checkpointMs = elapsed();
      pendingBytes += data.size;
      saveTail = saveTail.then(async () => {
        try {
          const descriptor = await inputs.store.append(inputs.id, kind, sequence, data, checkpointMs);
          const track = manifest.tracks.find(value => value.kind === kind)!;
          track.chunks.push(descriptor); track.bytes += descriptor.bytes;
          manifest.lastCheckpointMs = Math.max(manifest.lastCheckpointMs, checkpointMs);
          manifest.durationMs = checkpointMs;
          inputs.onCheckpoint?.(structuredClone(manifest));
        } catch (error) { fail(`Recording storage failed: ${messageOf(error)}. Saved chunks remain recoverable.`); }
        finally { pendingBytes -= data.size; }
      });
      if (pendingBytes > 32 * 1024 ** 2) fail('The storage writer fell behind. Finalizing the saved portion to protect this take.');
      if (checkpointMs >= BROWSER_LIMITS.maxTakeSeconds * 1000 && !ending) { event('take-limit'); void finish(); }
    });
    recorder.addEventListener('error', () => fail(`The ${kind} encoder failed. Saved chunks remain recoverable.`));
    return slot;
  }
  async function save() { manifest.durationMs = elapsed(); await inputs.store.save(structuredClone(manifest)); }
  async function drainCoverage(durationMs: number, expires: number): Promise<void> {
    const remaining = () => {
      const value = expires - performance.now();
      if (value < 1) throw new Error('Encoder finalization timed out before playable coverage was acknowledged. Closed chunks are preserved.');
      return value;
    };
    // Pause keeps already-submitted encoder callbacks alive. Native Stop does not
    // flush them. Only saved, decoded coverage acknowledges this bounded drain.
    const active = slots.filter(slot => slot.started && slot.recorder.state !== 'inactive');
    for (const slot of active) if (slot.recorder.state === 'recording') slot.recorder.pause();
    let uncovered: Error | undefined;
    for (let attempt = 1; attempt <= 16; attempt++) {
      if (canceled || failure) throw new Error(failure ?? 'Recording canceled during finalization.');
      await Promise.all(active.map(async slot => {
        let observed: (() => void) | undefined;
        const delivered = new Promise<void>(resolve => {
          observed = resolve; slot.recorder.addEventListener('dataavailable', observed, { once: true });
        });
        try {
          slot.recorder.requestData();
          await limited(delivered, remaining(), 'Encoder drain did not acknowledge its saved data. Closed chunks are preserved.');
        } finally { if (observed) slot.recorder.removeEventListener('dataavailable', observed); }
      }));
      await limited(saveTail, remaining(), 'Encoder drain storage timed out. Closed chunks are preserved.');
      if (canceled || failure) throw new Error(failure ?? 'Recording canceled during finalization.');
      let covered = true; uncovered = undefined;
      for (const slot of active) {
        const blob = await limited(inputs.store.trackBlob(inputs.id, slot.kind), remaining(), 'Reading encoder drain data timed out.');
        if (!blob.size) { covered = false; uncovered ??= new Error(`The saved ${slot.kind} has no playable bytes.`); continue; }
        try {
          await verifyPlayback(blob, !['microphone', 'tab-audio'].includes(slot.kind),
            { durationMs, kind: slot.kind }, remaining());
        } catch (error) {
          if (error instanceof PlaybackDurationMismatch && error.actualMs >= 0 && error.actualMs < durationMs - 250) { covered = false; uncovered ??= error; }
          else throw error;
        }
      }
      if (canceled || failure) throw new Error(failure ?? 'Recording canceled during finalization.');
      remaining();
      if (covered && active.length === slots.filter(slot => slot.started).length) {
        event('encoder-drain-covered', JSON.stringify({ requests: attempt, tracks: active.map(slot => slot.kind) })); return;
      }
    }
    throw new Error(`${uncovered?.message ?? 'Playable track coverage is unavailable.'} Encoder finalization could not acknowledge playable coverage. Closed chunks are preserved.`);
  }
  async function finish(): Promise<DraftManifest> {
    if (ending) return ending;
    if (canceled) throw new Error('This take was canceled.');
    ending = (async () => {
      if (!created) { release(); throw new Error('Start a recording before stopping it.'); }
      const duration = elapsed();
      if (duration > takeCeilingMs) failure ??= 'Automatic stop was delayed beyond the take limit. Saved originals remain available; this take is interrupted.';
      if (pauseAt) {
        const now = performance.now();
        manifest.pauses.push({ startMs: pauseAt - startedAt, endMs: now - startedAt });
        pausedMs += now - pauseAt; pauseAt = 0;
      }
      stoppedAt = performance.now(); notify('stopping'); event('stop-request');
      const encoderExpires = performance.now() + 15_000;
      if (!failure && startedAt) {
        try { await drainCoverage(duration, encoderExpires); }
        catch (error) { failure ??= messageOf(error); }
      }
      const waiting: Promise<void>[] = [];
      for (const slot of slots) {
        if (slot.started || slot.recorder.state !== 'inactive') waiting.push(slot.ended);
        if (slot.recorder.state !== 'inactive') {
          try { slot.recorder.stop(); }
          catch (error) { failure ??= messageOf(error); }
        }
      }
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.all(waiting), new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Encoder finalization timed out. Closed chunks are preserved.')), Math.max(1, encoderExpires - performance.now()));
        })]);
      } catch (error) { failure ??= messageOf(error); }
      finally { if (deadline) clearTimeout(deadline); release(); }
      if (performance.now() > encoderExpires) failure ??= 'Encoder finalization exceeded its deadline. Closed chunks are preserved.';
      let queueFinished = true;
      try { await limited(saveTail, 20_000, 'Storage finalization timed out. Closed chunks remain recoverable after reload.'); }
      catch (error) { queueFinished = false; failure ??= messageOf(error); }
      manifest.durationMs = duration;
      if (queueFinished) {
        try {
          const durable = await limited(inputs.store.load(inputs.id), 20_000, 'Reading the final chunk journal timed out.');
          for (const track of manifest.tracks) {
            const saved = durable.tracks.find(value => value.kind === track.kind);
            if (saved) { track.chunks = saved.chunks; track.bytes = saved.bytes; }
          }
          manifest.lastCheckpointMs = durable.lastCheckpointMs;
          if (durable.recoveryNote) failure ??= durable.recoveryNote;
        } catch (error) { failure ??= messageOf(error); }
      }
      if (audio?.diagnostics) event('composed-audio-timing', JSON.stringify(audio.diagnostics));
      event('recorders-stopped');
      if (!failure && !canceled) {
        try {
          for (const track of manifest.tracks) {
            if (canceled) break;
            const blob = await limited(inputs.store.trackBlob(inputs.id, track.kind), 20_000, 'Reading the saved track timed out. Closed chunks remain available after reload.');
            await verifyPlayback(blob, !['microphone', 'tab-audio'].includes(track.kind), { durationMs: duration, kind: track.kind });
          }
        } catch (error) { failure = messageOf(error); }
      }
      if (canceled) { manifest.state = 'failed'; return structuredClone(manifest); }
      manifest.state = failure ? 'interrupted' : 'complete';
      if (failure) { manifest.recoveryNote = failure; warn(failure); }
      try { if (queueFinished) await limited(inputs.store.save(structuredClone(manifest)), 10_000, 'Final checkpoint timed out. Closed chunks remain recoverable.'); }
      catch (error) { failure ??= messageOf(error); manifest.state = 'interrupted'; manifest.recoveryNote = failure; warn(failure); }
      if (canceled) { manifest.state = 'failed'; return structuredClone(manifest); }
      inputs.onCheckpoint?.(structuredClone(manifest));
      notify(manifest.state);
      return structuredClone(manifest);
    })();
    return ending;
  }
  try {
    const audioTracks = [inputs.microphone?.getAudioTracks()[0], screen ? inputs.screen?.getAudioTracks()[0] : undefined]
      .filter((track): track is MediaStreamTrack => !!track);
    audio = composedAudio(audioTracks, fail);
    if (audio.track) preview.addTrack(audio.track);
    if (screen) record('screen', new MediaStream([screen]), true);
    if (camera) record('camera', new MediaStream([camera]), true);
    const microphone = inputs.microphone?.getAudioTracks()[0];
    if (microphone) record('microphone', new MediaStream([microphone]), false);
    const tabAudio = screen ? inputs.screen?.getAudioTracks()[0] : undefined;
    if (tabAudio) record('tab-audio', new MediaStream([tabAudio]), false);
    record('composed', preview, true);
    const streams = clones.map(track => new apis.MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable);
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Composition worker did not initialize.')), 10_000);
      abortInitialization = error => { clearTimeout(timeout); reject(error); };
      worker.onmessage = (message: MessageEvent<{ kind: string; message?: string }>) => {
        if (message.data.kind === 'ready') {
          clearTimeout(timeout);
          if (released) reject(new Error('The recording source closed during initialization.'));
          else resolve();
        }
        else if (message.data.kind === 'error') {
          clearTimeout(timeout); reject(new Error(message.data.message)); fail(`Composition failed: ${message.data.message}`);
        } else if (message.data.kind === 'source-ended') fail('A video source ended. The saved portion is being finalized.');
        else if (message.data.kind === 'progress') lastProgress = performance.now();
        else if (message.data.kind === 'limit') stopAtLimit();
      };
      worker.onerror = () => { clearTimeout(timeout); reject(new Error('Composition worker failed.')); fail('Composition worker failed.'); };
    });
    worker.postMessage({ kind: 'setup', screen: screen ? streams[0] : undefined,
      camera: camera ? streams[screen ? 1 : 0] : undefined, output: generator.writable,
      width: BROWSER_LIMITS.width, height: BROWSER_LIMITS.height, fps: BROWSER_LIMITS.fps,
      maxSeconds: takeStopAtMs / 1000, bubble: manifest.bubble,
    }, [...streams, generator.writable]);
    await ready;
    abortInitialization = undefined;
    if (released) throw new Error('The recording source closed during initialization.');
    return {
      preview,
      async start() {
        if (state !== 'ready' || starting || released) throw new Error('This recording session has already been used.');
        starting = true;
        try {
          await audio?.start();
          if (released) throw new Error('The recording was canceled during startup.');
          await limited(inputs.store.create(structuredClone(manifest)), 10_000, 'Creating the local draft timed out.'); created = true;
          if (released) {
            if (canceled) await inputs.store.remove(inputs.id);
            throw new Error('The recording source closed during startup.');
          }
          startedAt = performance.now(); manifest.epochMs = startedAt; notify('recording');
          const starts = slots.map(slot => new Promise<void>((resolve, reject) => {
            const startedTimer = setTimeout(() => reject(new Error(`The ${slot.kind} encoder did not start.`)), 10_000);
            slot.recorder.addEventListener('error', () => { clearTimeout(startedTimer); reject(new Error(`The ${slot.kind} encoder failed during startup.`)); }, { once: true });
            const start = () => {
              clearTimeout(startedTimer);
              manifest.tracks.find(track => track.kind === slot.kind)!.startOffsetMs = performance.now() - startedAt;
              event(`start-${slot.kind}`); resolve();
            };
            slot.recorder.addEventListener('start', start, { once: true });
            try { slot.recorder.start(2000); slot.started = true; } catch (error) { clearTimeout(startedTimer); reject(error); }
          }));
          worker.postMessage({ kind: 'start' }); await Promise.all(starts); await save();
          armTakeDeadline();
          if (!released && !ending) timer = setInterval(() => {
            if (state === 'recording' && elapsed() >= takeStopAtMs) stopAtLimit();
            else if (camera && state === 'recording' && performance.now() - lastProgress > 15_000)
              fail('Video frames stopped arriving. The saved portion is being finalized.');
          }, 1000);
        } catch (error) {
          release();
          // A folder failure can reject create after OPFS and its lease commit.
          // Inspect that primary draft so terminal cleanup releases the live lease.
          if (!created && (error as { code?: unknown } | null)?.code !== 'DRAFT_EXISTS') {
            try {
              const saved = await limited(inputs.store.load(inputs.id), 5000, 'Inspecting the failed draft timed out.');
              if (saved.createdAt === manifest.createdAt && saved.epochMs === 0) created = true;
            } catch { /* No acknowledged primary draft; reload still retains any late closed writes. */ }
          }
          if (created && !canceled) {
            // Source loss may already have reported failed before create resolved.
            // The owned primary draft still needs a terminal checkpoint and lease
            // release before this start rejection is handed back to the caller.
            failure ??= messageOf(error);
            await finish();
          } else fail(messageOf(error));
          throw error;
        }
      },
      async pause() {
        if (state !== 'recording') throw new Error('Only an active take can be paused.');
        if (takeDeadline) clearTimeout(takeDeadline);
        pauseAt = performance.now(); slots.forEach(slot => { if (slot.recorder.state === 'recording') slot.recorder.pause(); });
        worker.postMessage({ kind: 'pause' }); notify('paused'); event('pause');
        try { await save(); } catch (error) { fail(messageOf(error)); throw error; }
      },
      async resume() {
        if (state !== 'paused') throw new Error('This take is not paused.');
        const now = performance.now(); manifest.pauses.push({ startMs: pauseAt - startedAt, endMs: now - startedAt });
        pausedMs += now - pauseAt; pauseAt = 0; lastProgress = now;
        slots.forEach(slot => { if (slot.recorder.state === 'paused') slot.recorder.resume(); });
        worker.postMessage({ kind: 'resume' }); notify('recording'); event('resume');
        armTakeDeadline();
        try { await save(); } catch (error) { fail(messageOf(error)); throw error; }
      },
      stop: finish,
      async cancel() {
        if (canceling) return canceling;
        canceled = true;
        // Claim completion before notifying or yielding to another caller.
        canceling = Promise.resolve().then(async () => {
          let stopError: unknown;
          try {
            for (const slot of slots) if (slot.recorder.state !== 'inactive') {
              try { slot.recorder.stop(); } catch (error) { stopError ??= error; }
            }
          } finally { release(); notify('failed'); }
          try {
            await limited(Promise.all(slots.filter(slot => slot.started).map(slot => slot.ended)),
              15_000, 'Encoder stop confirmation timed out during cancellation. Discarded draft cleanup will still finish.');
          } catch (error) { stopError ??= error; }
          if (ending) {
            try { await ending; } catch (error) { stopError ??= error; }
          }
          await limited(saveTail, 20_000, 'Cancellation storage cleanup timed out. A retained draft may be removed after reload.');
          if (created) await limited(inputs.store.remove(inputs.id), 10_000, 'Removing the canceled draft timed out.');
          if (stopError) throw stopError;
        });
        return canceling;
      },
      setBubble(value) {
        manifest.bubble = boundedBubble(value); worker.postMessage({ kind: 'bubble', value: manifest.bubble });
        event('bubble', JSON.stringify(manifest.bubble));
      },
    };
  } catch (error) { release(); throw error; }
}
