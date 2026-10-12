// Test-only native-frame observer: no interval or animation source clock.
// Sixteen preencoded optical bits identify each phase. The same ordinal reaches the
// AudioWorklet through a transferred port, avoiding Window background callbacks.
onmessage = async event => {
  const { input, audioPort } = event.data;
  const reader = input.getReader();
  const canvas = new OffscreenCanvas(16, 1), drawing = canvas.getContext('2d', { willReadFrequently: true });
  let previousOrdinal = -1, frames = 0;
  audioPort.onmessage = reply => postMessage({ kind: 'audio-anchor', ...reply.data });
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      const frame = item.value;
      drawing.drawImage(frame, 80, 8, 256, 32, 0, 0, 16, 1);
      const bytes = drawing.getImageData(0, 0, 16, 1).data;
      let ordinal = 0;
      for (let bit = 0; bit < 16; bit++) {
        if (bytes[bit * 4] > 128) ordinal |= 1 << bit;
      }
      if (ordinal !== previousOrdinal) {
        previousOrdinal = ordinal; audioPort.postMessage({ ordinal });
        postMessage({ kind: 'input-anchor', ordinal, timestamp: frame.timestamp,
          globalWallMs: performance.timeOrigin + performance.now() });
      }
      frame.close();
      frames++;
      if (frames === 1) postMessage({ kind: 'ready' });
    }
  } finally { reader.releaseLock(); }
};
