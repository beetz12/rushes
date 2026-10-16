// Synthetic calibration only: no device permission or real screen/camera input.
export async function fixture(mode = 'screen-camera', audioEnabled = true, calibration = false, cloudRecordingId, cameraDelayMs = 0) {
  const capture = await import('/src/capture/index.ts');
  const storage = await import('/src/capture/storage.ts');
  let clock = performance.now(), calibrationPause = 0;
  const calibrationElapsed = () => (calibrationPause || performance.now()) - clock;
  const canvases = [];
  const feeds = [];
  for (const name of ['screen', 'camera']) {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d');
    const stream = canvas.captureStream(0), track = stream.getVideoTracks()[0];
    const tick = () => {
      context.fillStyle = name === 'screen' ? '#2040e0' : '#e02020';
      context.fillRect(0, 0, canvas.width, canvas.height);
      // This synchronized marker changes every half second on both originals.
      context.fillStyle = Math.floor(calibrationElapsed() / 500) % 2 ? '#ffffff' : '#000000';
      context.fillRect(0, 0, 64, 64); track.requestFrame();
    };
    const source = { canvas, stream, timer: undefined, delay: undefined };
    const begin = () => { tick(); source.timer = setInterval(tick, 1000 / 30); };
    if (name === 'camera' && cameraDelayMs) source.delay = setTimeout(begin, cameraDelayMs);
    else begin();
    canvases.push(source); feeds.push(stream);
  }
  let context;
  const oscillators = [];
  if (audioEnabled) {
    context = new AudioContext(); await context.resume();
    for (const frequency of [440, 880]) {
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.frequency.value = frequency; gain.gain.value = 0.15;
      oscillator.connect(gain); gain.connect(destination); oscillator.start();
      oscillators.push({ oscillator, gain, destination });
    }
    feeds[0].addTrack(oscillators[1].destination.stream.getAudioTracks()[0]);
  }
  const store = await storage.createDraftStore();
  const id = crypto.randomUUID();
  const states = [], warnings = [], checkpoints = [];
  const session = await capture.createCaptureSession({ id, title: 'Synthetic capture calibration', mode,
    screen: mode === 'camera' ? undefined : feeds[0], camera: mode === 'screen' ? undefined : feeds[1],
    microphone: audioEnabled ? oscillators[0].destination.stream : undefined,
    store, persistent: false, backupFolder: false, ...(cloudRecordingId ? { cloudRecordingId } : {}), bubble: { x: 980, y: 500, size: 180 },
    onState: value => states.push(value), onWarning: value => warnings.push(value), onCheckpoint: value => checkpoints.push(value),
  });
  const pulseTimer = calibration && audioEnabled ? setInterval(() => {
    const white = Math.floor(calibrationElapsed() / 500) % 2;
    oscillators.forEach(({ gain }) => { gain.gain.value = white ? 0.15 : 0.03; });
  }, 10) : undefined;
  const cleanup = async () => {
    if (pulseTimer) clearInterval(pulseTimer);
    canvases.forEach(({ timer, delay, stream }) => { clearInterval(timer); clearTimeout(delay); stream.getTracks().forEach(track => track.stop()); });
    oscillators.forEach(({ oscillator }) => oscillator.stop()); await context?.close();
  };
  const pauseCalibration = () => { calibrationPause = performance.now(); };
  const resumeCalibration = () => { clock += performance.now() - calibrationPause; calibrationPause = 0; };
  return { session, store, id, feeds, states, warnings, checkpoints, cleanup, pauseCalibration, resumeCalibration };
}
export async function inspectVideo(blob, locations = [[600, 360]]) {
  const video = document.createElement('video'); video.muted = true;
  const url = URL.createObjectURL(blob); video.src = url;
  const wait = name => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out awaiting ${name}`)), 10000);
    function received() { clearTimeout(timer); resolve(); }
    video.addEventListener(name, received, { once: true });
    video.onerror = () => { clearTimeout(timer); reject(new Error('Synthetic video decode failed')); };
  });
  try {
    await wait('loadeddata');
    if (!Number.isFinite(video.duration)) { const seek = wait('seeked'); video.currentTime = 1e6; await seek; }
    const duration = video.duration;
    const samples = [];
    const canvas = document.createElement('canvas');
    Object.assign(canvas, { width: video.videoWidth, height: video.videoHeight });
    const context = canvas.getContext('2d');
    for (const seconds of [Math.min(0.15, duration / 4), duration / 2, Math.max(0.01, duration - 0.1)]) {
      const seek = wait('seeked'); video.currentTime = seconds; await seek;
      context.drawImage(video, 0, 0);
      samples.push(locations.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]));
    }
    return { duration, width: video.videoWidth, height: video.videoHeight, samples };
  } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}
export async function inspectAudio(blob) {
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const data = buffer.getChannelData(0), rate = buffer.sampleRate;
    const window = Math.min(rate, data.length);
    const powers = [440, 880].map(frequency => {
      let real = 0, imaginary = 0;
      for (let index = 0; index < window; index++) {
        real += data[index] * Math.cos(2 * Math.PI * frequency * index / rate);
        imaginary += data[index] * Math.sin(2 * Math.PI * frequency * index / rate);
      }
      return Math.sqrt(real * real + imaginary * imaginary) * 2 / window;
    });
    return { duration: buffer.duration, powers };
  } finally { await context.close(); }
}

export async function syncTransitions(blob, audioBlob = blob, videoOffsetMs = 0, audioOffsetMs = 0) {
  const context = new AudioContext();
  const decoded = await context.decodeAudioData(await audioBlob.arrayBuffer()); await context.close();
  const data = decoded.getChannelData(0), rate = decoded.sampleRate;
  const bin = Math.round(rate * 0.01), levels = [];
  for (let offset = 0; offset + bin < data.length; offset += bin) {
    let square = 0;
    for (let position = offset; position < offset + bin; position++) square += data[position] ** 2;
    levels.push(Math.sqrt(square / bin));
  }
  const threshold = (Math.max(...levels) + Math.min(...levels)) / 2;
  const transitions = [];
  for (let index = 3; index < levels.length - 3; index++) {
    const before = levels[index - 2] > threshold, after = levels[index + 2] > threshold;
    if (index * 0.01 >= 0.2 && before !== after && (!transitions.length || index * 0.01 - transitions.at(-1).time > 0.2))
      transitions.push({ time: index * 0.01, white: after });
  }
  const video = document.createElement('video'); video.muted = true;
  const url = URL.createObjectURL(blob); video.src = url;
  const awaitMedia = name => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Calibration ${name} timed out`)), 10000);
    function arrived() { clearTimeout(timer); resolve(); }
    video.addEventListener(name, arrived, { once: true });
  });
  try {
    await awaitMedia('loadeddata');
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const drawing = canvas.getContext('2d'); const drifts = [];
    // Independently decoded audio edges locate visual transitions near beginning,
    // middle and end. Six binary seeks resolve the edge to better than one frame.
    for (const index of [...new Set([0, Math.floor(transitions.length / 2), transitions.length - 1])]) {
      const edge = transitions[index]; if (!edge) throw new Error('Calibration tone has no edges.');
      const expected = edge.time + (audioOffsetMs - videoOffsetMs) / 1000;
      let lower = Math.max(0.001, expected - 0.18), upper = expected + 0.18;
      const isWhite = async seconds => {
        const waited = awaitMedia('seeked'); video.currentTime = seconds; await waited;
        drawing.drawImage(video, 0, 0); return drawing.getImageData(16, 16, 1, 1).data[0] > 128;
      };
      if (await isWhite(lower) === edge.white || await isWhite(upper) !== edge.white)
        throw new Error(`The decoded visual edge did not bracket the audio calibration at ${edge.time}s.`);
      for (let step = 0; step < 6; step++) {
        const middle = (lower + upper) / 2;
        if (await isWhite(middle) === edge.white) upper = middle; else lower = middle;
      }
      drifts.push({ audioSeconds: edge.time, videoSeconds: (lower + upper) / 2, driftMs: ((lower + upper) / 2 - edge.time) * 1000 + videoOffsetMs - audioOffsetMs });
    }
    return drifts.map(edge => ({ ...edge, audioEdges: transitions.map(value => value.time) }));
  } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}
