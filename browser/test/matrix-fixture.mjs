// Independent M1 instrumentation. Native Chrome fake media is supplied by the
// runner; this page never requests a real screen or uses a timer as its video source.
export async function prepareMatrix({ backup = true, diagnostic = false } = {}) {
  const { createCaptureSession } = await import('/src/capture/index.ts');
  const { createDraftStore } = await import('/src/capture/storage.ts');
  const nativeRecorder = globalThis.MediaRecorder;
  const nativeWorker = globalThis.Worker;
  const metrics = { recorderKinds: [], chunks: [], pendingBytes: 0, peakPendingBytes: 0,
    peakConcurrentAppends: 0, activeAppends: 0, appends: [], visibility: [], states: [],
    warnings: [], checkpoints: [], frames: {}, workerEvents: [], observerErrors: [], extraProcessorReaders: diagnostic ? 0 : 5 };
  globalThis.matrixObserverErrors = metrics.observerErrors;
  if (diagnostic) globalThis.Worker = class extends nativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', event => metrics.workerEvents.push({ ...event.data, wallMs: performance.now() }));
      this.addEventListener('error', event => metrics.observerErrors.push({ name: 'production-worker-event', message: event.message, wallMs: performance.now() }));
    }
  };
  const kinds = ['screen', 'camera', 'microphone', 'tab-audio', 'composed'];
  globalThis.MediaRecorder = class extends nativeRecorder {
    constructor(...args) {
      super(...args);
      const kind = kinds[metrics.recorderKinds.length]; metrics.recorderKinds.push(kind);
      this.addEventListener('dataavailable', event => {
        if (!event.data.size) return;
        metrics.pendingBytes += event.data.size;
        metrics.peakPendingBytes = Math.max(metrics.peakPendingBytes, metrics.pendingBytes);
        metrics.chunks.push({ kind, bytes: event.data.size, wallMs: performance.now() });
      });
    }
  };
  const source = await navigator.mediaDevices.getUserMedia({
    video: { width: { exact: 1280 }, height: { exact: 720 }, frameRate: { exact: 30 } }, audio: false,
  });
  // Native fake microphone supplied silence on this Mac. A rendering AudioWorklet
  // supplies two frequencies encoding a unique phase ordinal instead. This is
  // calibration media rather than physical microphone proof.
  const toneContext = new AudioContext({ sampleRate: 48000 });
  const moduleURL = URL.createObjectURL(new Blob([`
    class MatrixTone extends AudioWorkletProcessor {
      constructor() { super(); this.ordinal = 0; this.port.onmessage = event => {
        this.ordinal = event.data.ordinal; this.port.postMessage({ ordinal: this.ordinal, audioFrame: currentFrame });
      }; }
      process(_inputs, outputs) { const channel = outputs[0][0];
        const low = 500 + this.ordinal % 64 * 40, high = 4000 + Math.floor(this.ordinal / 64) * 80;
        for (let index = 0; index < channel.length; index++) {
          const seconds = (currentFrame + index) / sampleRate;
          channel[index] = 0.15 * (Math.sin(seconds * 2 * Math.PI * low) + Math.sin(seconds * 2 * Math.PI * high));
        }
        return true;
      }
    }
    registerProcessor('matrix-tone', MatrixTone);
  `], { type: 'text/javascript' }));
  await toneContext.audioWorklet.addModule(moduleURL); URL.revokeObjectURL(moduleURL);
  const tone = new AudioWorkletNode(toneContext, 'matrix-tone'), audio = toneContext.createMediaStreamDestination();
  tone.connect(audio); await toneContext.resume(); metrics.calibrationInputEdges = []; metrics.calibrationAudioEdges = [];
  let sourceObserverTrack, sourceWorker;
  if (!diagnostic) {
    sourceObserverTrack = source.getVideoTracks()[0].clone();
    const processor = new MediaStreamTrackProcessor({ track: sourceObserverTrack, maxBufferSize: 1 });
    sourceWorker = new Worker(new URL('./matrix-source.worker.mjs', import.meta.url), { type: 'module' });
    const ready = new Promise((resolve, reject) => {
      sourceWorker.onerror = error => { metrics.observerErrors.push({ name: 'source-anchor', message: error.message, wallMs: performance.now() }); reject(new Error(error.message)); };
      sourceWorker.onmessage = event => {
        if (event.data.kind === 'ready') resolve();
        if (event.data.kind === 'input-anchor') metrics.calibrationInputEdges.push(event.data);
        if (event.data.kind === 'audio-anchor') metrics.calibrationAudioEdges.push(event.data);
        if (event.data.kind === 'observer-error') { metrics.observerErrors.push(event.data); reject(new Error(event.data.message)); }
      };
    });
    sourceWorker.postMessage({ input: processor.readable, audioPort: tone.port }, [processor.readable, tone.port]); await ready;
  }
  const screen = new MediaStream([source.getVideoTracks()[0].clone(), audio.stream.getAudioTracks()[0].clone()]);
  const camera = new MediaStream([source.getVideoTracks()[0].clone()]);
  const microphone = new MediaStream([audio.stream.getAudioTracks()[0].clone()]);
  const id = crypto.randomUUID();
  const root = await navigator.storage.getDirectory();
  const backupDirectory = backup ? await root.getDirectoryHandle('m1-closed-backup', { create: true }) : undefined;
  const rawStore = await createDraftStore(backupDirectory);
  const store = { ...rawStore, append: async (...args) => {
    const begun = performance.now(); metrics.activeAppends++;
    metrics.peakConcurrentAppends = Math.max(metrics.peakConcurrentAppends, metrics.activeAppends);
    try {
      const descriptor = await rawStore.append(...args);
      metrics.appends.push({ kind: args[1], sequence: args[2], bytes: args[3].size,
        milliseconds: performance.now() - begun, checkpointMs: args[4] });
      return descriptor;
    } finally { metrics.activeAppends--; metrics.pendingBytes -= args[3].size; }
  } };
  const monitors = [];
  const watch = (name, track) => {
    const clone = track.clone(), reader = new MediaStreamTrackProcessor({ track: clone, maxBufferSize: 1 }).readable.getReader();
    const info = { count: 0, firstTimestamp: null, lastTimestamp: null, maxTimestampGapUs: 0,
      maxWallGapMs: 0, buckets: {}, samples: [], settings: track.getSettings() };
    metrics.frames[name] = info;
    let lastWall = null, stop = false, settled = false;
    const task = (async () => {
      try {
        while (!stop) {
          const item = await reader.read(); if (item.done) break;
          const frame = item.value;
          try {
            const now = performance.now(), timestamp = frame.timestamp;
            info.count++; info.firstTimestamp ??= timestamp;
            if (info.lastTimestamp !== null) info.maxTimestampGapUs = Math.max(info.maxTimestampGapUs, timestamp - info.lastTimestamp);
            if (lastWall !== null) info.maxWallGapMs = Math.max(info.maxWallGapMs, now - lastWall);
            info.lastTimestamp = timestamp; lastWall = now; info.lastWallMs = now;
            const bucket = Math.floor(now / 1000); info.buckets[bucket] = (info.buckets[bucket] || 0) + 1;
            if (info.count % 30 === 1) info.samples.push({ count: info.count, timestamp, wallMs: now });
          } finally { frame.close(); }
        }
      } catch (error) { metrics.observerErrors.push({ name, message: String(error), wallMs: performance.now() }); }
      finally { settled = true; reader.releaseLock(); }
    })();
    monitors.push(async () => { stop = true; if (!settled) await reader.cancel(); clone.stop(); await task; });
  };
  if (!diagnostic) {
    watch('native-input', source.getVideoTracks()[0]);
    watch('input-screen', screen.getVideoTracks()[0]); watch('input-camera', camera.getVideoTracks()[0]);
  }
  const session = await createCaptureSession({ id, title: 'Independent synthetic M1', mode: 'screen-camera',
    screen, camera, microphone, store, persistent: false, backupFolder: backup,
    bubble: { x: 1030, y: 490, size: 180 }, onState: state => metrics.states.push({ state, wallMs: performance.now() }),
    onWarning: message => metrics.warnings.push(message),
    onCheckpoint: manifest => { take.manifest = manifest; metrics.checkpoints.push({ wallMs: performance.now(),
      lastCheckpointMs: manifest.lastCheckpointMs, chunks: manifest.tracks.reduce((sum, track) => sum + track.chunks.length, 0) }); },
  });
  const player = document.createElement('video'); player.muted = true; player.playsInline = true;
  player.srcObject = session.preview; document.body.append(player); await player.play();
  if (!diagnostic) watch('output-composed', session.preview.getVideoTracks()[0]);
  const visibility = () => metrics.visibility.push({ wallMs: performance.now(), state: document.visibilityState, hasFocus: document.hasFocus() });
  document.addEventListener('visibilitychange', visibility); visibility();
  const take = { id, session, store, rawStore, metrics, manifest: undefined, startedAt: 0,
    pausedAt: 0, pausedMs: 0, sources: [screen, camera, microphone],
    elapsed() { return this.startedAt ? (this.pausedAt || performance.now()) - this.startedAt - this.pausedMs : 0; },
    async start() { await session.start(); this.manifest = await rawStore.load(id); this.startedAt = this.manifest.epochMs; },
    async pause() { this.pausedAt = performance.now(); await session.pause(); },
    async resume() { this.pausedMs += performance.now() - this.pausedAt; this.pausedAt = 0; await session.resume(); },
    snapshot() { return structuredClone({ id, wallMs: performance.now(), elapsedMs: this.elapsed(), manifest: this.manifest, metrics,
      visibilityState: document.visibilityState, focused: document.hasFocus(), heap: performance.memory ? {
        used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null }); },
    async finish() { const manifest = await session.stop(); source.getTracks().forEach(track => track.stop());
      player.pause(); player.srcObject = null; player.remove();
      sourceObserverTrack?.stop(); sourceWorker?.terminate(); audio.stream.getTracks().forEach(track => track.stop()); await toneContext.close();
      await Promise.all(monitors.map(stop => stop()));
      document.removeEventListener('visibilitychange', visibility); globalThis.MediaRecorder = nativeRecorder; globalThis.Worker = nativeWorker;
      this.manifest = manifest; return this.snapshot(); },
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
