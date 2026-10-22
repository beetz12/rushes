// Generated native test frames only. Copies the original optical region; no clock fit.
export async function copyOpticalRegion(frame) {
  const begun = performance.now();
  let bytes, layout, format, timestamp, closedAtMs, copyMs;
  try {
    format = frame.format; timestamp = frame.timestamp;
    const visible = frame.visibleRect;
    if (!['NV12', 'I420'].includes(format) || !Number.isSafeInteger(timestamp)
      || frame.codedWidth !== 1280 || frame.codedHeight !== 720
      || frame.displayWidth !== 1280 || frame.displayHeight !== 720
      || visible?.x !== 0 || visible?.y !== 0 || visible.width !== 1280 || visible.height !== 720)
      throw new Error('Optical reference requires a full unscaled native8bit YUV fixture');
    const options = { rect: { x: 80, y: 8, width: 256, height: 32 } };
    const size = frame.allocationSize(options);
    if (!Number.isSafeInteger(size) || size <= 0 || size > 65536) throw new Error('Invalid optical region allocation');
    bytes = new Uint8Array(size);
    const copying = performance.now(); layout = await frame.copyTo(bytes, options);
    copyMs = performance.now() - copying;
  } finally { frame.close(); closedAtMs = performance.now(); }
  const ordinal = decodeOpticalRegion(bytes, layout);
  return { ordinal, timestamp, format, copyMs, closedAtMs, nativeLeaseMs: closedAtMs - begun,
    observationMs: performance.now() - begun };
}

export function decodeOpticalRegion(bytes, layout) {
  const plane = layout?.[0];
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(plane?.offset) || plane.offset < 0
    || !Number.isSafeInteger(plane.stride) || plane.stride < 256
    || plane.offset + 31 * plane.stride + 255 >= bytes.length)
    throw new Error('Invalid optical region plane layout');
  let ordinal = 0;
  for (let bit = 0; bit < 16; bit++) {
    const value = bytes[plane.offset + 16 * plane.stride + 8 + bit * 16];
    if (value > 48 && value < 208) throw new Error('Optical reference bit lacks black/white contrast');
    if (value > 128) ordinal |= 1 << bit;
  }
  return ordinal;
}
