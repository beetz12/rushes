import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { copyOpticalRegion, decodeOpticalRegion } from './native-optical-roi.mjs';

function barcode(ordinal, fullRange = false) {
  const offset = 17, stride = 288, bytes = new Uint8Array(offset + stride * 32);
  bytes.fill(fullRange ? 0 : 16);
  for (let bit = 0; bit < 16; bit++) if (ordinal & (1 << bit))
    bytes[offset + 16 * stride + 8 + 16 * bit] = fullRange ? 255 : 235;
  return { bytes, layout: [{ offset, stride }] };
}

test('native optical bytes preserve all barcode bits with full/limited luma and padded returned layout', () => {
  for (const ordinal of [0, 1, 63, 64, 127, 128, 32768, 65535]) for (const fullRange of [false, true]) {
    const value = barcode(ordinal, fullRange);
    assert.equal(decodeOpticalRegion(value.bytes, value.layout), ordinal);
  }
  const value = barcode(0); value.bytes[17 + 16 * 288 + 8] = 100;
  assert.throws(() => decodeOpticalRegion(value.bytes, value.layout), /contrast/);
  for (const layout of [[{ offset: -1, stride: 288 }], [{ offset: 17, stride: 255 }], [{ offset: 999999, stride: 288 }]])
    assert.throws(() => decodeOpticalRegion(value.bytes, layout), /layout/);
});

function controlledFrame(format = 'NV12') {
  let closes = 0;
  const frame = { format, timestamp: 123456789, codedWidth: 1280, codedHeight: 720,
    displayWidth: 1280, displayHeight: 720, visibleRect: { x: 0, y: 0, width: 1280, height: 720 },
    allocationSize(options) { assert.deepEqual(options, { rect: { x: 80, y: 8, width: 256, height: 32 } }); return 12288; },
    async copyTo(bytes, options) {
      assert.equal(options.format, undefined); bytes.fill(16); bytes[16 * 256 + 8 + 16 * 15] = 235;
      return [{ get offset() { assert.equal(closes, 1, 'native frame closes before any decoder layout access'); return 0; }, stride: 256 }];
    }, close() { closes++; } };
  return { frame, closes: () => closes };
}

test('ROI observation copies native format and preserves the raw timestamp after closing before decoding', async () => {
  for (const format of ['NV12', 'I420']) {
    const value = controlledFrame(format), result = await copyOpticalRegion(value.frame);
    assert.equal(result.ordinal, 32768); assert.equal(result.timestamp, 123456789); assert.equal(result.format, format);
    assert.equal(value.closes(), 1); assert.ok(result.copyMs >= 0 && result.nativeLeaseMs >= 0);
  }
});

test('invalid metadata and failed native copies still close their frame exactly once', async () => {
  for (const change of [frame => { frame.format = null; }, frame => { frame.codedWidth = 640; },
    frame => { frame.visibleRect.x = 2; }, frame => { frame.timestamp = NaN; },
    frame => { frame.allocationSize = () => 65537; }, frame => { frame.copyTo = async () => { throw new Error('deliberate optical copy failure'); }; }]) {
    const value = controlledFrame(); change(value.frame);
    await assert.rejects(copyOpticalRegion(value.frame)); assert.equal(value.closes(), 1);
  }
});
