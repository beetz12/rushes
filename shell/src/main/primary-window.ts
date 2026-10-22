import { z } from 'zod';
import type { Rectangle } from 'electron';
import type { PrimaryView } from '../shared/navigation';

export type WindowBounds = Rectangle;
export type WindowPresentation = 'compact' | 'workspace';

export class PrimaryNavigation {
  private view: PrimaryView = 'recorder';
  private revision = 0;
  select(view: PrimaryView) {
    if (view !== this.view) ++this.revision;
    this.view = view;
  }
  checkpoint() {
    const revision = this.revision;
    return () => revision === this.revision;
  }
}
const bounds = z.object({
  x: z.number().finite().min(-100_000).max(100_000),
  y: z.number().finite().min(-100_000).max(100_000),
  width: z.number().finite().positive().max(16_384),
  height: z.number().finite().positive().max(16_384),
});
const saved = z.object({ compact: bounds.optional(), workspace: bounds.optional() });
export function windowPresentation(view: PrimaryView): WindowPresentation {
  return view === 'recorder' || view === 'review' ? 'compact' : 'workspace';
}
export function primaryMinimum(mode: WindowPresentation, workArea: WindowBounds) {
  return {
    width: Math.min(mode === 'compact' ? 400 : 800, workArea.width),
    height: Math.min(600, workArea.height),
  };
}
export class PrimaryWindowGeometry {
  private values: Partial<Record<WindowPresentation, WindowBounds>> = {};
  mode: WindowPresentation = 'compact';
  restore(value: unknown) {
    const parsed = saved.safeParse(value);
    if (parsed.success) this.values = parsed.data;
  }
  snapshot() {
    return { ...this.values };
  }
  remember(value: WindowBounds) {
    if (bounds.safeParse(value).success) this.values[this.mode] = { ...value };
  }
  select(view: PrimaryView, current: WindowBounds | undefined, workAreas: WindowBounds[]) {
    if (!workAreas.length) throw new Error('No screen is available for the Rushes window.');
    const next = windowPresentation(view);
    if (current) this.remember(current);
    const proposed = this.values[next] ?? {
      width: next === 'compact' ? 420 : 1120,
      height: next === 'compact' ? 620 : 780,
      x:
        current?.x ?? workAreas[0].x + (workAreas[0].width - (next === 'compact' ? 420 : 1120)) / 2,
      y:
        current?.y ?? workAreas[0].y + (workAreas[0].height - (next === 'compact' ? 620 : 780)) / 2,
    };
    const overlap = (area: WindowBounds) =>
      Math.max(
        0,
        Math.min(proposed.x + proposed.width, area.x + area.width) - Math.max(proposed.x, area.x),
      ) *
      Math.max(
        0,
        Math.min(proposed.y + proposed.height, area.y + area.height) - Math.max(proposed.y, area.y),
      );
    const workArea = [...workAreas].sort((a, b) => overlap(b) - overlap(a))[0];
    const minimum = primaryMinimum(next, workArea);
    const width = Math.min(workArea.width, Math.max(minimum.width, proposed.width));
    const height = Math.min(workArea.height, Math.max(minimum.height, proposed.height));
    const selected = {
      width: Math.round(width),
      height: Math.round(height),
      x: Math.round(
        Math.max(workArea.x, Math.min(proposed.x, workArea.x + workArea.width - width)),
      ),
      y: Math.round(
        Math.max(workArea.y, Math.min(proposed.y, workArea.y + workArea.height - height)),
      ),
    };
    this.mode = next;
    this.values[next] = selected;
    return { bounds: selected, minimum, mode: next };
  }
}
