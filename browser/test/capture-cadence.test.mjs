import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const source = await readFile(new URL('../src/capture/cadence.ts', import.meta.url), 'utf8');
const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
const { createFrameCadence } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);

test('near30fps timestamp jitter retains the intended cadence rather than repeatedly dropping frames', () => {
  const admit = createFrameCadence(30); let timestamp = 12_345_678; const accepted = [];
  for (let frame = 0; frame < 300; frame++) {
    if (admit(timestamp)) accepted.push(timestamp);
    timestamp += frame % 2 ? 33_334 : 33_330;
  }
  assert.equal(accepted.length, 300);
  assert.ok(accepted.every((value, index) => !index || value > accepted[index - 1]));
});
test('60fps is decimated to one original timestamp per nominal30fps bucket, without duplicates or fabricated frames', () => {
  const admit = createFrameCadence(30), origin = 40_000_000; const input = [], output = [];
  for (let frame = 0; frame < 600; frame++) {
    const timestamp = origin + Math.round(frame * 1_000_000 / 60); input.push(timestamp);
    if (admit(timestamp)) output.push(timestamp);
  }
  const buckets = output.map(timestamp => Math.round((timestamp - origin) * 30 / 1_000_000));
  assert.ok(output.length >= 299 && output.length <= 301);
  assert.equal(new Set(buckets).size, output.length);
  assert.ok(output.every(timestamp => input.includes(timestamp)));
  assert.ok(output.every((timestamp, index) => !index || timestamp > output[index - 1]));
  assert.equal(admit(output.at(-1)), false); assert.equal(admit(NaN), false);
});
test('a long input gap admits only the next real frame rather than synthesizing a catch-up burst', () => {
  const admit = createFrameCadence(30);
  assert.equal(admit(0), true); assert.equal(admit(3_000_000), true);
  assert.equal(admit(3_000_001), false); assert.equal(admit(3_033_333), true);
});
