import { describe, it, expect } from 'vitest';
import { normalizedPointer, bubbleForCapture, globalCaptureArea } from '../src/shared/geometry';
import { countdownFromSelection } from '../src/shared/contracts';
describe('composition pointer geometry', () => {
  it('uses actual parent bounds and clamps outside coordinates', () => {
    const bounds = { left: 40, top: 20, width: 400, height: 200 };
    expect(normalizedPointer({ x: 240, y: 120 }, bounds)).toEqual([0.5, 0.5]);
    expect(normalizedPointer({ x: -400, y: 900 }, bounds)).toEqual([0, 1]);
  });
  it('rejects detached, collapsed and nonfinite inputs without mutating geometry', () => {
    expect(normalizedPointer({ x: 0, y: 0 }, null)).toBeUndefined();
    expect(
      normalizedPointer({ x: 0, y: 0 }, { left: 0, top: 0, width: 0, height: 200 }),
    ).toBeUndefined();
    expect(
      normalizedPointer({ x: NaN, y: 0 }, { left: 0, top: 0, width: 400, height: 200 }),
    ).toBeUndefined();
    expect(
      normalizedPointer({ x: 0, y: 0 }, { left: 0, top: 0, width: 400, height: Infinity }),
    ).toBeUndefined();
  });
});
describe('validated countdown choices', () => {
  it('accepts only the named supported seconds', () => {
    expect(['0', '3', '5'].map(countdownFromSelection)).toEqual([0, 3, 5]);
    expect(countdownFromSelection('')).toBeUndefined();
    expect(countdownFromSelection('05')).toBeUndefined();
    expect(countdownFromSelection('7')).toBeUndefined();
  });
});

describe('capture-relative bubble geometry', () => {
  it('preserves a 160pt bubble on a 3840pt display without a minimum fraction', () => {
    const value = bubbleForCapture(
      { x: 3400, y: 1700, size: 160 },
      { x: 0, y: 0, width: 3840, height: 2160 },
    );
    expect(value?.sizeFraction).toBeCloseTo(160 / 3840, 12);
    expect(value?.bounds.width).toBe(160);
  });
  it('uses cropped content and negative global display origins', () => {
    const value = bubbleForCapture(
      { x: -1550, y: 300, size: 200 },
      { x: -1600, y: 200, width: 800, height: 600 },
    );
    expect(value?.center).toEqual([0.1875, 1 / 3]);
    expect(value?.sizeFraction).toBe(0.25);
    const resized = bubbleForCapture(
      { x: 1000, y: 1000, size: 280 },
      { x: 40, y: 20, width: 150, height: 100 },
    );
    expect(resized?.bounds).toEqual({ x: 90, y: 20, width: 100, height: 100 });
    expect(resized?.sizeFraction).toBeCloseTo(2 / 3);
  });
  it('refuses missing, vanished and invalid capture rectangles', () => {
    expect(bubbleForCapture({ x: 0, y: 0, size: 200 }, null)).toBeUndefined();
    expect(
      bubbleForCapture({ x: 0, y: 0, size: 200 }, { x: NaN, y: 0, width: 800, height: 600 }),
    ).toBeUndefined();
    expect(
      bubbleForCapture({ x: 0, y: 0, size: 200 }, { x: 0, y: 0, width: 0, height: 600 }),
    ).toBeUndefined();
  });
});

describe('area selector screen coordinates', () => {
  it('converts local pointer selections to negative secondary-display coordinates and clips edges', () => {
    const display = { x: -1728, y: -100, width: 1728, height: 1117 };
    expect(globalCaptureArea({ x: 40, y: 80, width: 600, height: 400 }, display)).toEqual({
      x: -1688,
      y: -20,
      width: 600,
      height: 400,
    });
    expect(globalCaptureArea({ x: -20, y: 1000, width: 500, height: 400 }, display)).toEqual({
      x: -1728,
      y: 900,
      width: 480,
      height: 117,
    });
    expect(globalCaptureArea({ x: 1800, y: 80, width: 600, height: 400 }, display)).toBeUndefined();
  });
});
