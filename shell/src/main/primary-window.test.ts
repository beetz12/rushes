import { describe, expect, it } from 'vitest';
import { PrimaryWindowGeometry, windowPresentation } from './primary-window';
import { primaryViews, windowKey } from '../shared/navigation';

describe('one primary window with compact and workspace presentations', () => {
  const area = { x: 0, y: 25, width: 1512, height: 900 };
  it('launches compact and keeps all primary routes in the same canonical window', () => {
    const geometry = new PrimaryWindowGeometry();
    const initial = geometry.select('recorder', undefined, [area]);
    expect(initial.bounds.width).toBe(420);
    expect(initial.bounds.height).toBe(620);
    expect(initial.minimum).toEqual({ width: 400, height: 600 });
    for (const view of primaryViews) expect(windowKey(view)).toBe('recorder');
    expect(windowPresentation('review')).toBe('compact');
    expect(windowPresentation('editor')).toBe('workspace');
    expect(windowKey('bubble')).toBe('bubble');
  });
  it('restores each presentation after drag and resize without losing its position', () => {
    const geometry = new PrimaryWindowGeometry();
    geometry.select('recorder', undefined, [area]);
    const compact = { x: 60, y: 80, width: 400, height: 600 };
    const full = geometry.select('library', compact, [area]);
    expect(full.bounds).toEqual({ x: 60, y: 80, width: 1120, height: 780 });
    const edited = { x: 170, y: 110, width: 1200, height: 800 };
    expect(geometry.select('review', edited, [area]).bounds).toEqual(compact);
    expect(geometry.select('editor', compact, [area]).bounds).toEqual(edited);
    const reloaded = new PrimaryWindowGeometry();
    reloaded.restore(geometry.snapshot());
    expect(reloaded.select('recorder', undefined, [area]).bounds).toEqual(compact);
  });
  it('clamps old monitor coordinates and corrupt state while keeping controls on screen', () => {
    const geometry = new PrimaryWindowGeometry();
    geometry.restore({ compact: { x: -1900, y: -300, width: 700, height: 1000 } });
    const small = { x: 0, y: 0, width: 400, height: 600 };
    expect(geometry.select('recorder', undefined, [small]).bounds).toEqual(small);
    const reset = new PrimaryWindowGeometry();
    reset.restore({ compact: { x: NaN, y: 0, width: -1, height: 1 } });
    expect(reset.select('recorder', undefined, [area]).bounds.width).toBe(420);
    const left = { x: -1920, y: -100, width: 1920, height: 1080 };
    reset.remember({ x: -1800, y: 0, width: 420, height: 620 });
    expect(reset.select('review', undefined, [area, left]).bounds.x).toBe(-1800);
  });
});
