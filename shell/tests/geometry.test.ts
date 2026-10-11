import { describe, it, expect } from 'vitest';
import { normalizedPointer } from '../src/shared/geometry';
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
