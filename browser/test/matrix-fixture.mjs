import { createNativeEncoderControl } from './matrix-native-encoder-control.mjs';
import { createNativeEncoderFanout } from './matrix-native-encoder-fanout.mjs';
import { generatedAudioWorkerObserver } from './generated-audio-worker.mjs';
import { audioFailureMetadata, encoderStartMetadata, frameFormatName } from './startup-metadata.mjs';
import { nativeReferenceClock } from './native-reference-clock.mjs';
import { nativeReferenceWitness, SOURCE_PCM_GUARD_MS } from './native-reference-witness.mjs';
export async function directContainerControl(durationMs) {
  if (durationMs !== 8000) throw new Error('Direct source control is bounded to8s');
  const element = document.createElement('video'); element.muted = true; element.playsInline = true;
  element.src = '/matrix-media'; document.body.append(element);
  let stream, recorder;
  try {
    if (typeof element.captureStream !== 'function') throw new Error('Media-element captureStream is unavailable');
    await element.play(); stream = element.captureStream();
    if (stream.getVideoTracks().length !== 1 || stream.getAudioTracks().length !== 1) throw new Error('Direct source lacks both tracks');
    recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 4000000, audioBitsPerSecond: 128000 });
    const chunks = []; let bytes = 0;
    const ended = new Promise((resolve, reject) => {
      recorder.onstop = resolve; recorder.onerror = () => reject(new Error('Direct source encoder failed'));
    });
    recorder.ondataavailable = event => { if (event.data.size) { chunks.push(event.data); bytes += event.data.size; } };
    const begun = performance.now(); recorder.start(1000);
    await new Promise(resolve => setTimeout(resolve, durationMs));
    const actualDurationMs = performance.now() - begun; recorder.stop();
    let stopTimer;
    try { await Promise.race([ended, new Promise((_, reject) => { stopTimer = setTimeout(() => reject(new Error('Direct source Stop timed out')), 15000); })]); }
    finally { clearTimeout(stopTimer); }
    if (bytes > 32 * 1024 ** 2) throw new Error('Direct source control exceeded bounded8s memory');
    window.directControlBlob = new Blob(chunks, { type: recorder.mimeType });
    return { actualDurationMs, bytes, settings: stream.getTracks().map(track => ({ kind: track.kind, settings: track.getSettings() })),
      playback: { currentTime: element.currentTime, decoded: element.getVideoPlaybackQuality().totalVideoFrames,
        dropped: element.getVideoPlaybackQuality().droppedVideoFrames } };
  } finally {
    if (recorder?.state === 'recording') recorder.stop();
    stream?.getTracks().forEach(track => track.stop()); element.pause(); element.removeAttribute('src'); element.load(); element.remove();
  }
}

// One explicit raw encoder is layered on the existing source observation only.
export function withNativeEncoderControl(observation, source, NativeRecorder, metrics, dependencies = {}) {
  const control = createNativeEncoderControl(source, { ...dependencies, Recorder: NativeRecorder });
  let stopping, finished;
  const update = () => { metrics.nativeEncoderControl = control.snapshot(); };
  const emit = phase => {
    update(); const raw = metrics.nativeEncoderControl;
    try { (dependencies.emit ?? (row => console.info('GENERATED_NATIVE_ENCODER_CONTROL ' + JSON.stringify(row))))({
      schema: 'rushes.raw-native-vp8-row/1', takeId: observation.id, phase, atMs: (dependencies.now ?? (() => performance.now()))(),
      startCalls: raw.startCalls, startReturns: raw.startReturns, startEvents: raw.startEvents, firstStartMs: raw.firstStartMs,
      stopCalls: raw.stopCalls, stopReturns: raw.stopReturns, stopEvents: raw.stopEvents, bytes: raw.bytes, failures: raw.failures.length }); }
    catch { metrics.nativeEncoderObservationErrors = (metrics.nativeEncoderObservationErrors ?? 0) + 1; }
  };
  update();
  const stop = () => stopping ??= (async () => {
    const observed = observation.session.stop(); emit('before-stop');
    try { await control.stop(); }
    catch (error) { metrics.nativeEncoderRetirementError = String(error).slice(0, 256); }
    finally { emit('stop-settled'); await observed; }
  })();
  return { ...observation, session: { stop },
    async start() {
      const started = control.start(); observation.start(); emit('after-start-call');
      // Epoch follows the actual native call, before waiting for its event.
      try { await started; } finally { emit('startup-settled'); }
    },
    pause() { if (!stopping) { control.pause(); observation.pause(); update(); } },
    resume() { if (!stopping) { control.resume(); observation.resume(); update(); } },
    snapshot() { update(); return observation.snapshot(); },
    finish() { return finished ??= (async () => { try { await stop(); return await observation.finish(); } finally { update(); } })(); },
    async downloadNativeEncoder() {
      const url = URL.createObjectURL(control.blob()), link = document.createElement('a');
      link.href = url; link.download = 'raw-native.webm'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    },
  };
}

// Explicit raw encoder fanout, layered on the same source observation as the single control.
// It never reuses the single-control metrics, rows or schema.
export async function withNativeEncoderFanout(observation, source, NativeRecorder, metrics, count, dependencies = {}) {
  const fanout = await createNativeEncoderFanout(source, count, { ...dependencies, Recorder: NativeRecorder });
  let stopping, finished;
  const update = () => { metrics.nativeEncoderFanout = fanout.snapshot(); };
  const emit = phase => {
    update(); const group = metrics.nativeEncoderFanout, field = key => group.encoders.map(encoder => encoder[key]);
    try { (dependencies.emit ?? (row => console.info('GENERATED_NATIVE_ENCODER_FANOUT ' + JSON.stringify(row))))({
      schema: 'rushes.raw-native-vp8-fanout-row/1', takeId: observation.id, phase, count, atMs: (dependencies.now ?? (() => performance.now()))(),
      startCalls: field('startCalls'), startReturns: field('startReturns'), startEvents: field('startEvents'), firstStartMs: field('firstStartMs'),
      stopCalls: field('stopCalls'), stopReturns: field('stopReturns'), stopEvents: field('stopEvents'), bytes: field('bytes'),
      failures: group.encoders.map(encoder => encoder.failures.length) }); }
    catch { metrics.nativeEncoderFanoutObservationErrors = (metrics.nativeEncoderFanoutObservationErrors ?? 0) + 1; }
  };
  update();
  const stop = () => stopping ??= (async () => {
    const observed = observation.session.stop(); emit('before-stop');
    try { await fanout.stop(); }
    catch (error) { metrics.nativeEncoderFanoutRetirementError = String(error).slice(0, 256); }
    finally { emit('stop-settled'); await observed; }
  })();
  return { ...observation, session: { stop },
    async start() {
      const started = fanout.start(); observation.start(); emit('after-start-call');
      // Epoch follows every actual native Start call, before waiting for their events.
      try { await started; } finally { emit('startup-settled'); }
    },
    pause() { if (!stopping) { fanout.pause(); observation.pause(); update(); } },
    resume() { if (!stopping) { fanout.resume(); observation.resume(); update(); } },
    snapshot() { update(); return observation.snapshot(); },
    finish() { return finished ??= (async () => { try { await stop(); return await observation.finish(); } finally { update(); } })(); },
    async downloadNativeEncoderFanout(index) {
      const url = URL.createObjectURL(fanout.blob(index)), link = document.createElement('a');
      link.href = url; link.download = `raw-native-fanout-${index}.webm`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    },
  };
}

// Independent M1 instrumentation. Native Chrome fake media is supplied by the
// runner; this page never requests a real screen or uses a timer as its video source.
export async function prepareMatrix({ backup = true, diagnostic = false, sourceMode = 'native-feedback', referenceWitness = true, clockSeed, sourceOnly = false, nativeEncoderControl = false, nativeEncoderFanout = 0, sourceAudioFrames = 128, sourceAudioSink = 'none', startupObservation = false, audioTimingObservation = false } = {}) {
  if (typeof sourceOnly !== 'boolean' || (sourceOnly && (sourceMode !== 'native-reference' || diagnostic || !referenceWitness)))
    throw new Error('Source-only observation requires the ordinary native-reference witness');
  if (![128, 480].includes(sourceAudioFrames) || (sourceAudioFrames !== 128 && sourceMode !== 'native-reference'))
    throw new Error('Generated source audio hint must be128 or480 frames in native-reference mode');
  if (!['none', 'default'].includes(sourceAudioSink) || (sourceAudioSink === 'default' && (sourceMode !== 'native-reference' || sourceAudioFrames !== 128)))
    throw new Error('Default generated source sink requires explicit native-reference128 mode');
  if (typeof startupObservation !== 'boolean' || (startupObservation && (sourceMode !== 'native-reference' || sourceOnly || diagnostic)))
    throw new Error('Startup observations require an explicit generated full native-reference diagnostic');
  if (typeof audioTimingObservation !== 'boolean' || (audioTimingObservation && (!startupObservation || sourceMode !== 'native-reference' || sourceOnly || diagnostic || !referenceWitness)))
    throw new Error('Audio delivery timing requires the supervised initial native-reference diagnostic');
  if (typeof nativeEncoderControl !== 'boolean' || (nativeEncoderControl && (!sourceOnly || sourceMode !== 'native-reference' || diagnostic || !referenceWitness || sourceAudioFrames !== 128 || sourceAudioSink !== 'none')))
    throw new Error('Raw native encoder control requires its explicit native-reference128 source-only diagnostic');
  if (![0, 1, 2, 3].includes(nativeEncoderFanout) || (nativeEncoderFanout && (nativeEncoderControl || !sourceOnly || sourceMode !== 'native-reference' || diagnostic || !referenceWitness || sourceAudioFrames !== 128 || sourceAudioSink !== 'none')))
    throw new Error('Raw native encoder fanout requires its own explicit native-reference128 source-only diagnostic');
  let audioObserver;
  let startup = () => undefined, audioFailureAt;
  const { createCaptureSession } = await import('/src/capture/index.ts');
  const { createDraftStore } = await import('/src/capture/storage.ts');
  const nativeRecorder = globalThis.MediaRecorder;
  const nativeWorker = globalThis.Worker;
  const metrics = { recorderKinds: [], chunks: [], pendingBytes: 0, peakPendingBytes: 0,
    peakConcurrentAppends: 0, activeAppends: 0, appends: [], visibility: [], states: [],
    warnings: [], checkpoints: [], frames: {}, workerEvents: [], observerErrors: [], extraProcessorReaders: diagnostic ? 0 : sourceMode === 'container' ? 4 : sourceMode === 'native-reference' && referenceWitness ? 6 : 5 };
  globalThis.matrixObserverErrors = metrics.observerErrors;
  // Setup can fail before a take exists. Retain the generated clock witness too.
  globalThis.matrixPreparationMetrics = metrics;
  if (diagnostic) globalThis.Worker = class extends nativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', event => metrics.workerEvents.push({ ...(event.data.kind === 'packet' ? { kind: 'audio-packet', sequence: event.data.sequence, timestamp: event.data.timestamp, frames: event.data.data.length / 2 } : event.data), wallMs: performance.now() }));
      this.addEventListener('error', event => metrics.observerErrors.push({ name: 'production-worker-event', message: event.message, wallMs: performance.now() }));
    }
  };
  if (startupObservation) {
    audioObserver = generatedAudioWorkerObserver({ NativeWorker: nativeWorker, metrics, baseURL: location.href,
      getTakeId: () => id, getFailureAt: () => audioFailureAt, startup: row => startup(row), audioTiming: audioTimingObservation });
    globalThis.Worker = audioObserver.Worker;
  }
  const kinds = ['screen', 'camera', 'microphone', 'tab-audio', 'composed'];
  globalThis.MediaRecorder = class extends nativeRecorder {
    constructor(...args) {
      super(...args);
      const kind = kinds[metrics.recorderKinds.length]; metrics.recorderKinds.push(kind);
      if (startupObservation) for (const event of ['start', 'error', 'stop'])
        this.addEventListener(event, () => startup({ kind: 'recorder-event', id: kinds.indexOf(kind), role: kind, event, state: this.state }));
      this.addEventListener('dataavailable', event => {
        if (!event.data.size) return;
        metrics.pendingBytes += event.data.size;
        metrics.peakPendingBytes = Math.max(metrics.peakPendingBytes, metrics.pendingBytes);
        metrics.chunks.push({ kind, bytes: event.data.size, wallMs: performance.now() });
      });
    }
  };
  let source, sourceElement, toneContext, tone, audio;
  metrics.calibrationInputEdges = []; metrics.calibrationAudioEdges = []; metrics.calibrationAudioArrivals = [];
  metrics.sourceMode = sourceMode; metrics.sourceOnly = sourceOnly;
  if (sourceOnly) metrics.extraProcessorReaders = 5;
  const observingReference = sourceMode === 'native-reference' && referenceWitness;
  let suppliedReference;
  if (observingReference) {
    metrics.clockCapability = await nativeReferenceClock(clockSeed);
    if (metrics.clockCapability.error || !metrics.clockCapability.converter?.qualified) {
      globalThis.MediaRecorder = nativeRecorder; globalThis.Worker = nativeWorker;
      throw new Error(`Native supplied-reference clock is unqualified: ${metrics.clockCapability.error ?? 'No qualified converter'}`);
    }
  }
  if (sourceMode === 'container') {
    sourceElement = document.createElement('video'); sourceElement.muted = true; sourceElement.playsInline = true;
    sourceElement.src = '/matrix-media'; document.body.append(sourceElement);
    if (typeof sourceElement.captureStream !== 'function') throw new Error('Media-element captureStream is unavailable; absolute source test is unmeasured');
    await sourceElement.play(); source = sourceElement.captureStream();
    if (source.getVideoTracks().length !== 1 || source.getAudioTracks().length !== 1)
      throw new Error('Synchronized fixture must provide live video and audio tracks');
    audio = { stream: new MediaStream(source.getAudioTracks()) };
  } else if (['native-feedback', 'native-reference'].includes(sourceMode)) {
    const acquireNativeVideo = async () => {
      metrics.nativeVideoRequestedPageMs = performance.now();
      source = await navigator.mediaDevices.getUserMedia({
        video: { width: { exact: 1280 }, height: { exact: 720 }, frameRate: { exact: 30 } }, audio: false,
      });
      metrics.nativeVideoAcquiredPageMs = performance.now();
    };
    if (!observingReference) await acquireNativeVideo();
    // Begin observing actual PCM before creating the native video source. Merely
    // opening its disk sink does not prove that any head samples were received.
    try {
      toneContext = new AudioContext({ sampleRate: 48000, latencyHint: sourceAudioFrames / 48000,
        ...(sourceAudioSink === 'none' ? { sinkId: { type: 'none' } } : {}) });
      const observedSink = toneContext.sinkId;
      if (sourceAudioSink === 'none' ? observedSink?.type !== 'none' : observedSink !== '')
        throw new Error(sourceAudioSink === 'none' ? 'Silent fixture audio output is unavailable' : 'Default fixture audio output is unavailable');
      metrics.generatedAudioOutput = { type: sourceAudioSink, observedSink: typeof observedSink === 'string' ? observedSink : { type: observedSink.type },
        sampleRate: toneContext.sampleRate, requestedCallbackFrames: sourceAudioFrames };
      await toneContext.audioWorklet.addModule(new URL('./matrix-tone.worklet.mjs', import.meta.url));
      tone = new AudioWorkletNode(toneContext, 'matrix-tone', { processorOptions: { diagnostic } });
      audio = toneContext.createMediaStreamDestination();
      tone.connect(audio); await toneContext.resume();
      Object.assign(metrics.generatedAudioOutput, { state: toneContext.state, baseLatency: toneContext.baseLatency,
        renderQuantumSize: toneContext.renderQuantumSize ?? null });
      if (observingReference) {
        suppliedReference = await nativeReferenceWitness(audio.stream.getAudioTracks()[0], metrics.observerErrors, metrics.clockCapability);
        metrics.suppliedReferenceStartup = await suppliedReference.ready();
      }
      if (observingReference) await acquireNativeVideo();
    } catch (error) {
      const sink = toneContext?.sinkId;
      const startup = { contextState: toneContext?.state, contextTime: toneContext?.currentTime,
        sampleRate: toneContext?.sampleRate, sink: typeof sink === 'string' ? sink : { type: sink?.type },
        tracks: audio?.stream.getAudioTracks().map(track => ({ state: track.readyState, enabled: track.enabled, muted: track.muted })),
        witness: suppliedReference?.startupState?.(), observerErrors: metrics.observerErrors };
      metrics.suppliedReferenceStartupFailure = startup;
      const failures = [error];
      try { await suppliedReference?.stop(); } catch (cleanup) { failures.push(cleanup); }
      try { source?.getTracks().forEach(track => track.stop()); } catch (cleanup) { failures.push(cleanup); }
      try { audio?.stream.getTracks().forEach(track => track.stop()); } catch (cleanup) { failures.push(cleanup); }
      try { await toneContext?.close(); } catch (cleanup) { failures.push(cleanup); }
      globalThis.MediaRecorder = nativeRecorder; globalThis.Worker = nativeWorker;
      throw new AggregateError(failures, `Native source preparation failed: ${error}; startup=${JSON.stringify(startup)}`);
    }
    metrics.calibrationInputEdges = []; metrics.calibrationAudioEdges = []; metrics.calibrationAudioArrivals = [];
  } else throw new Error('Unknown test source mode');
  let sourceObserverTrack, sourceWorker, retireSourceObserver;
  if (!diagnostic && ['native-feedback', 'native-reference'].includes(sourceMode)) {
    sourceObserverTrack = source.getVideoTracks()[0].clone();
    const processor = new MediaStreamTrackProcessor({ track: sourceObserverTrack, maxBufferSize: 1 });
    sourceWorker = new Worker(new URL('./matrix-source.worker.mjs', import.meta.url), { type: 'module' });
    let stoppedResolve, stoppedReject;
    const stopped = new Promise((resolve, reject) => { stoppedResolve = resolve; stoppedReject = reject; });
    // Install rejection observation immediately; a later finish still receives the failure.
    void stopped.catch(() => undefined);
    retireSourceObserver = async stopAtTimestampUs => {
      let deadline;
      try {
        sourceWorker.postMessage({ kind: 'stop', stopAtTimestampUs });
        await Promise.race([stopped, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Source observer retirement timed out')), 1000);
        })]);
      } finally { clearTimeout(deadline); sourceObserverTrack.stop(); sourceWorker.terminate(); }
    };
    const ready = new Promise((resolve, reject) => {
      sourceWorker.onerror = error => { metrics.observerErrors.push({ name: 'source-anchor', message: error.message, wallMs: performance.now() }); reject(new Error(error.message)); };
      sourceWorker.onmessage = event => {
        if (event.data.kind === 'ready') resolve();
        if (event.data.kind === 'stopped') { metrics.sourceObserverRetirement = event.data; stoppedResolve(); }
        if (event.data.kind === 'input-anchor') metrics.calibrationInputEdges.push(event.data);
        if (event.data.kind === 'audio-anchor') metrics.calibrationAudioEdges.push(event.data);
        if (event.data.kind === 'audio-arrival') metrics.calibrationAudioArrivals.push(event.data);
        if (event.data.kind === 'observer-error') { metrics.observerErrors.push(event.data); stoppedReject(new Error(event.data.message)); reject(new Error(event.data.message)); }
      };
    });
    sourceWorker.postMessage({ input: processor.readable, audioPort: tone.port }, [processor.readable, tone.port]); await ready;
  }
  const screen = new MediaStream([source.getVideoTracks()[0].clone(), audio.stream.getAudioTracks()[0].clone()]);
  const camera = new MediaStream([source.getVideoTracks()[0].clone()]);
  const microphone = new MediaStream([audio.stream.getAudioTracks()[0].clone()]);
  const id = crypto.randomUUID();
  if (startupObservation) {
    metrics.startupObservation = { attempted: 0, emitted: 0, dropped: 0 };
    startup = row => {
      const index = metrics.startupObservation.attempted++;
      if (index >= 256) { metrics.startupObservation.dropped++; return; }
      console.info('GENERATED_CAPTURE_STARTUP ' + JSON.stringify({ takeId: id, index, timeMs: performance.now(), ...row }));
      metrics.startupObservation.emitted++;
    };
  }
  let rawStore, store;
  if (!sourceOnly) {
  const root = await navigator.storage.getDirectory();
  const backupDirectory = backup ? await root.getDirectoryHandle('m1-closed-backup', { create: true }) : undefined;
  rawStore = await createDraftStore(backupDirectory);
  store = { ...rawStore, append: async (...args) => {
    const begun = performance.now(); metrics.activeAppends++;
    metrics.peakConcurrentAppends = Math.max(metrics.peakConcurrentAppends, metrics.activeAppends);
    try {
      const descriptor = await rawStore.append(...args);
      metrics.appends.push({ kind: args[1], sequence: args[2], bytes: args[3].size,
        milliseconds: performance.now() - begun, checkpointMs: args[4] });
      return descriptor;
    } finally { metrics.activeAppends--; metrics.pendingBytes -= args[3].size; }
  } };
  }
  const monitors = [];
  const watch = (name, track) => {
    const clone = track.clone(), reader = new MediaStreamTrackProcessor({ track: clone, maxBufferSize: 1 }).readable.getReader();
    const info = { count: 0, firstTimestamp: null, lastTimestamp: null, maxTimestampGapUs: 0,
      maxWallGapMs: 0, buckets: {}, samples: [], settings: track.getSettings() };
    metrics.frames[name] = info;
    let lastWall = null, stop = false, settled = false, stopAtTimestampUs, crossingTimestampUs;
    const task = (async () => {
      try {
        while (!stop) {
          const item = await reader.read(); if (item.done) break;
          const frame = item.value;
          try {
            if (stopAtTimestampUs !== undefined && frame.timestamp > stopAtTimestampUs) { crossingTimestampUs = frame.timestamp; break; }
            const now = performance.now(), timestamp = frame.timestamp;
            info.count++; info.firstTimestamp ??= timestamp;
            if (info.count === 1) {
              info.firstFormat = frameFormatName(frame.format);
              if (startupObservation) startup({ kind: 'frame-format', role: name, format: info.firstFormat });
            }
            if (info.lastTimestamp !== null) info.maxTimestampGapUs = Math.max(info.maxTimestampGapUs, timestamp - info.lastTimestamp);
            if (lastWall !== null) info.maxWallGapMs = Math.max(info.maxWallGapMs, now - lastWall);
            info.lastTimestamp = timestamp; lastWall = now; info.lastWallMs = now;
            const bucket = Math.floor(now / 1000); info.buckets[bucket] = (info.buckets[bucket] || 0) + 1;
            if (info.count % 30 === 1) info.samples.push({ count: info.count, timestamp, wallMs: now });
          } finally { frame.close(); }
        }
      } catch (error) { metrics.observerErrors.push({ name, message: String(error), wallMs: performance.now() }); }
      finally {
        try { await reader.cancel(); }
        catch (error) { metrics.observerErrors.push({ name, message: String(error), wallMs: performance.now() }); }
        settled = true; reader.releaseLock();
      }
    })();
    monitors.push(async cutoff => {
      let deadline;
      try {
        if (name === 'output-composed') {
          // The product retires its generator at Stop; a clone need not receive
          // EOF or another output. Its live-take samples end at this receipt.
          info.boundary = { termination: 'recording-stop-cancel' };
        } else if (cutoff !== undefined) {
          if (info.lastTimestamp > cutoff) throw new Error(`${name} observation already exceeded its Stop boundary`);
          stopAtTimestampUs = cutoff;
          const begun = performance.now();
          await Promise.race([task, new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error(`${name} Stop boundary was not drained within250ms`)), 250);
          })]);
          const crossing = Number.isSafeInteger(crossingTimestampUs) && crossingTimestampUs > cutoff && crossingTimestampUs - cutoff <= 250000;
          if (!crossing || performance.now() - begun > 250)
            throw new Error(`${name} Stop boundary lacks a crossing within250ms`);
          info.boundary = { cutoffUs: cutoff, crossingTimestampUs: crossingTimestampUs ?? null,
            termination: 'later-native-frame' };
        }
      } finally {
        clearTimeout(deadline); stop = true;
        try { if (!settled) await reader.cancel(); }
        finally { clone.stop(); await task; }
      }
    });
  };
  if (!diagnostic) {
    watch('native-input', source.getVideoTracks()[0]);
    watch('input-screen', screen.getVideoTracks()[0]); watch('input-camera', camera.getVideoTracks()[0]);
  }
  let observationRetirement;
  const retireObservations = () => {
    if (observationRetirement) return observationRetirement;
    const requestedPageMs = performance.now();
    metrics.observationBoundary = { requestedPageMs };
    // onState runs before the synchronous recorder.stop loop. Begin after that loop.
    observationRetirement = Promise.resolve().then(async () => {
      metrics.observationBoundary.startedPageMs = performance.now();
      const high = observingReference ? metrics.clockCapability.converter.originIntervalMs[1] : undefined;
      // Include uncertainty-overlapping frames; never infer an origin for container tracks.
      const cutoff = high === undefined ? undefined : Math.ceil((metrics.observationBoundary.startedPageMs + high) * 1000);
      metrics.observationBoundary.nativeCutoffUs = cutoff ?? null;
      const retiredVideo = await Promise.allSettled([
        retireSourceObserver?.(cutoff), ...monitors.map(stop => stop(cutoff)),
      ]);
      for (const item of retiredVideo) if (item.status === 'rejected')
        metrics.observerErrors.push({ name: 'video-reference-retirement', message: String(item.reason), wallMs: performance.now() });
      if (suppliedReference) {
        const [low, upper] = metrics.clockCapability.converter.originIntervalMs;
        const opticalEnd = metrics.sourceObserverRetirement?.optical?.lastTimestamp;
        const bodyEndTimestampUs = Math.min(opticalEnd, metrics.frames['native-input'].lastTimestamp);
        const observationGuard = { schema: 'rushes.source-pcm-guard/1', bodyEndTimestampUs,
          targetPageMs: bodyEndTimestampUs / 1000 - (low + upper) / 2 + SOURCE_PCM_GUARD_MS };
        // The optical worker has retired and its tone input is held. Observe
        // actual PCM for the final edge; never extend video or feed a new ordinal.
        metrics.suppliedReference = { ...await suppliedReference.stop({ coverThroughPageMs: observationGuard.targetPageMs }),
          takeId: id, observationGuard };
      }
      metrics.observationBoundary.finishedPageMs = performance.now();
    }).catch(error => { metrics.observerErrors.push({ name: 'observation-retirement', message: String(error), wallMs: performance.now() }); });
    return observationRetirement;
  };
  // Source-only diagnostics share the actual observation retirement above.
  // They create no product session/store/preview and cannot satisfy product acceptance.
  if (sourceOnly) {
    const pauses = []; let startedAt = 0, pausedAt = 0, pausedMs = 0, stoppedAt = 0, stopping;
    const state = value => metrics.states.push({ state: value, wallMs: performance.now() });
    const elapsed = () => startedAt ? Math.max(0, (pausedAt || stoppedAt || performance.now()) - startedAt - pausedMs) : 0;
    const stopObservation = () => {
      if (stopping) return stopping;
      const now = performance.now();
      if (pausedAt) {
        pauses.push({ startMs: pausedAt - startedAt, endMs: now - startedAt });
        pausedMs += now - pausedAt; pausedAt = 0;
      }
      stoppedAt = now; state('stopping');
      stopping = retireObservations().then(() => state('observed'));
      return stopping;
    };
    const snapshot = () => structuredClone({ id, wallMs: performance.now(), elapsedMs: elapsed(), metrics,
      observation: { scope: 'source-only', durationMs: elapsed(), pauses },
      visibilityState: document.visibilityState, focused: document.hasFocus(), heap: performance.memory ? {
        used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null });
    const visibility = () => metrics.visibility.push({ wallMs: performance.now(), state: document.visibilityState, hasFocus: document.hasFocus() });
    document.addEventListener('visibilitychange', visibility); visibility();
    const observation = { id, metrics, session: { stop: stopObservation }, snapshot,
      start() {
        if (startedAt || stopping) throw new Error('This source-only observation has already been used');
        startedAt = performance.now(); state('observing');
      }, elapsed,
      pause() { if (!stopping) { pausedAt = performance.now(); state('paused'); } },
      resume() {
        if (stopping) return;
        const now = performance.now(); pauses.push({ startMs: pausedAt - startedAt, endMs: now - startedAt });
        pausedMs += now - pausedAt; pausedAt = 0; state('observing');
      },
      async finish() {
        try { await stopObservation(); }
        finally {
          for (const stream of [source, screen, camera, microphone, audio.stream]) stream.getTracks().forEach(track => track.stop());
          sourceObserverTrack?.stop(); sourceWorker?.terminate();
          try { await toneContext?.close(); }
          finally { document.removeEventListener('visibilitychange', visibility); globalThis.MediaRecorder = nativeRecorder; globalThis.Worker = nativeWorker; }
        }
        metrics.sourceOnlyStorageEntries = [];
        for await (const [name] of (await navigator.storage.getDirectory()).entries()) metrics.sourceOnlyStorageEntries.push(name);
        metrics.sourceOnlySourcesEnded = [source, screen, camera, microphone, audio.stream]
          .every(stream => stream.getTracks().every(track => track.readyState === 'ended'));
        return snapshot();
      },
      async downloadSourceReference() {
        const url = URL.createObjectURL(await suppliedReference.file()), link = document.createElement('a');
        link.href = url; link.download = 'source-reference.f32le'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      },
    };
    if (nativeEncoderFanout) {
      try { return await withNativeEncoderFanout(observation, source.getVideoTracks()[0], nativeRecorder, metrics, nativeEncoderFanout); }
      catch (error) {
        try { await observation.finish(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Raw encoder fanout attachment and source retirement failed'); }
        throw error;
      }
    }
    if (!nativeEncoderControl) return observation;
    try { return withNativeEncoderControl(observation, source.getVideoTracks()[0], nativeRecorder, metrics); }
    catch (error) {
      try { await observation.finish(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Raw encoder attachment and source retirement failed'); }
      throw error;
    }
  }
  if (startupObservation) {
    const { cameraSourceAlreadyBounded } = await import('/src/capture/camera-source-limits.ts');
    startup({ kind: 'source-limits-proof', screenEligible: cameraSourceAlreadyBounded(screen.getVideoTracks()[0]),
      cameraEligible: cameraSourceAlreadyBounded(camera.getVideoTracks()[0]) });
  }
  // Observe the same owned compositor messages; no extra reader or console traffic.
  metrics.compositionSpans = { samples: [], dropped: 0, missing: 0, invalid: 0, validation: 'envelope-only; numeric table reader required', beforeStop: null };
  const composingWorker = globalThis.Worker;
  globalThis.Worker = class extends composingWorker {
    constructor(...args) {
      super(...args);
      const requested = new URL(args[0], location.href);
      if (requested.origin !== location.origin || requested.username !== '' || requested.password !== ''
        || requested.pathname !== '/src/capture/composition.worker.ts') return;
      this.addEventListener('message', event => {
        if (!['ready', 'progress', 'error', 'stopped'].includes(event.data?.kind)) return;
        const spans = event.data?.compositionSpans;
        if (spans === undefined) { metrics.compositionSpans.missing++; return; }
        let encoded;
        try { encoded = JSON.stringify(spans); }
        catch { metrics.compositionSpans.invalid++; return; }
        if (!spans || spans.schema !== 'rushes.composition-local-spans/1' || typeof encoded !== 'string' || encoded.length > 16384) { metrics.compositionSpans.invalid++; return; }
        if (metrics.compositionSpans.samples.length >= 32) { metrics.compositionSpans.dropped++; return; }
        metrics.compositionSpans.samples.push({ kind: event.data.kind, frameCount: event.data.frameCount, spans });
      });
    }
  };
  const session = await createCaptureSession({ id, title: 'Independent synthetic M1', mode: 'screen-camera',
    screen, camera, microphone, store, persistent: false, backupFolder: backup,
    bubble: { x: 1030, y: 490, size: 180 }, onState: state => {
      const stateRecord = { state, wallMs: performance.now() }; metrics.states.push(stateRecord);
      if (state === 'stopping') {
        const spans = metrics.compositionSpans;
        if (spans.beforeStop === null) spans.beforeStop = { takeId: id, state: 'stopping', wallMs: stateRecord.wallMs,
          retained: spans.samples.length, lastRetainedIndex: spans.samples.length ? spans.samples.length - 1 : null,
          received: spans.samples.length + spans.dropped + spans.missing + spans.invalid,
          dropped: spans.dropped, missing: spans.missing, invalid: spans.invalid };
        void retireObservations();
      }
    },
    onWarning: (message, details) => {
      metrics.warnings.push(message);
      const audio = startupObservation ? audioFailureMetadata(details) : undefined;
      const encoder = startupObservation ? encoderStartMetadata(details) : undefined;
      if (startupObservation && details !== undefined && !audio && !encoder) metrics.audioFailureDetailsInvalid++;
      if ((audio || encoder) && audioFailureAt === undefined) audioFailureAt = performance.now();
      audioObserver?.flushDelivery();
      if (encoder) startup({ kind: 'encoder-timeout', detail: encoder });
      startup({ kind: 'warning', state: metrics.states.at(-1)?.state ?? 'ready', message: String(message).slice(0, 512),
        ...(audio ? { audio } : {}) });
    },
    onCheckpoint: manifest => { take.manifest = manifest; metrics.checkpoints.push({ wallMs: performance.now(),
      lastCheckpointMs: manifest.lastCheckpointMs, chunks: manifest.tracks.reduce((sum, track) => sum + track.chunks.length, 0) }); },
  });
  const player = document.createElement('video'); player.muted = true; player.playsInline = true;
  player.srcObject = session.preview; document.body.append(player); await player.play();
  if (!diagnostic) watch('output-composed', session.preview.getVideoTracks()[0]);
  const visibility = () => metrics.visibility.push({ wallMs: performance.now(), state: document.visibilityState, hasFocus: document.hasFocus() });
  document.addEventListener('visibilitychange', visibility); visibility();
  const nativeTrackStats = () => Object.fromEntries([['screen', screen], ['camera', camera]]
    .map(([role, stream]) => [role, inspectNativeTrackStats(stream.getVideoTracks()[0])]));
  const take = { id, session, store, rawStore, metrics, manifest: undefined, startedAt: 0,
    nativeTrackStats,
    pausedAt: 0, pausedMs: 0, sources: [screen, camera, microphone],
    elapsed() { return this.startedAt ? (this.pausedAt || performance.now()) - this.startedAt - this.pausedMs : 0; },
    async start() {
      startup({ kind: 'phase', phase: 'session-start-entered' }); await session.start();
      startup({ kind: 'phase', phase: 'session-start-resolved' });
      startup({ kind: 'phase', phase: 'journal-load-entered' }); this.manifest = await rawStore.load(id);
      startup({ kind: 'phase', phase: 'journal-load-resolved' }); this.startedAt = this.manifest.epochMs;
    },
    async pause() { this.pausedAt = performance.now(); await session.pause(); },
    async resume() { this.pausedMs += performance.now() - this.pausedAt; this.pausedAt = 0; await session.resume(); },
    snapshot() { return structuredClone({ id, wallMs: performance.now(), elapsedMs: this.elapsed(), manifest: this.manifest, metrics,
      visibilityState: document.visibilityState, focused: document.hasFocus(), heap: performance.memory ? {
        used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null }); },
    async finish() { let manifest;
      try { manifest = await session.stop(); }
      finally {
        await retireObservations();
        source.getTracks().forEach(track => track.stop());
        player.pause(); player.srcObject = null; player.remove();
        sourceObserverTrack?.stop(); sourceWorker?.terminate(); audio.stream.getTracks().forEach(track => track.stop());
        try { await toneContext?.close(); }
        finally {
          if (sourceElement) { sourceElement.pause(); sourceElement.removeAttribute('src'); sourceElement.load(); sourceElement.remove(); }
          document.removeEventListener('visibilitychange', visibility); globalThis.MediaRecorder = nativeRecorder; globalThis.Worker = nativeWorker;
        }
      }
      this.manifest = manifest; return this.snapshot(); },
    async downloadSourceReference() {
      if (!suppliedReference) throw new Error('No supplied-reference observation for this take');
      const url = URL.createObjectURL(await suppliedReference.file());
      const link = document.createElement('a'); link.href = url; link.download = 'source-reference.f32le'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    },
    async download(kind) { const url = URL.createObjectURL(await store.trackBlob(id, kind));
      const link = document.createElement('a'); link.href = url; link.download = `${kind}.webm`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000); },
  };
  return take;
}

export async function recoverMatrix(id) {
  const { createDraftStore } = await import('/src/capture/storage.ts');
  const store = await createDraftStore(), manifest = await store.load(id), chunks = [];
  for (const descriptor of manifest.tracks.flatMap(track => track.chunks)) {
    const blob = await store.readChunk(id, descriptor);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    chunks.push({ ...descriptor, actualBytes: blob.size, actualDigest: digest });
  }
  const root = await navigator.storage.getDirectory();
  const backup = await (await root.getDirectoryHandle('m1-closed-backup')).getDirectoryHandle(id);
  const backupChunks = [];
  for (const descriptor of manifest.tracks.flatMap(track => track.chunks)) {
    const name = `${descriptor.track}-${String(descriptor.sequence).padStart(5, '0')}.bin`;
    try {
      const file = await (await backup.getFileHandle(name)).getFile();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
      backupChunks.push({ track: descriptor.track, sequence: descriptor.sequence, bytes: file.size, digest });
    } catch (error) { backupChunks.push({ track: descriptor.track, sequence: descriptor.sequence, error: String(error) }); }
  }
  return { manifest, chunks, backupChunks, activeLocks: (await navigator.locks.query()).held,
    mediaDevicesWereRequested: (window.recoveryDeviceRequests || 0) > 0,
    recoveryDeviceRequestCount: window.recoveryDeviceRequests || 0 };
}

export function inspectNativeTrackStats(track) {
  try {
    const stats = track.stats;
    if (!stats) return { availability: 'absent', reason: 'Video track.stats is unavailable', readyState: track.readyState, muted: track.muted };
    const values = Object.fromEntries(['deliveredFrames', 'discardedFrames', 'totalFrames'].map(name => {
      const value = stats[name]; return [name, typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null];
    }));
    const complete = Object.values(values).every(value => value !== null);
    return { availability: complete ? 'available' : 'partial', ...values,
      reportedDroppedFrames: complete ? values.totalFrames - values.deliveredFrames - values.discardedFrames : null,
      readyState: track.readyState, muted: track.muted };
  } catch (error) { return { availability: 'error', message: String(error), readyState: track.readyState }; }
}
