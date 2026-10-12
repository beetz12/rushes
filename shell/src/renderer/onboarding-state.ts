export type GuideStatus = 'unseen' | 'dismissed' | 'completed';
export type GuideRecord = { version: 1; status: GuideStatus };
export type GuideAction = 'get' | 'dismiss' | 'complete' | 'reset';
export type GuideState = {
  open: boolean;
  step: number;
  saving: boolean;
  error: string;
};

// Only a successful durable write closes a guide or opens an explicit replay.
export class GuideSession {
  state: GuideState = { open: false, step: 0, saving: false, error: '' };
  private revision = 0;
  constructor(
    private request: (action: GuideAction) => Promise<GuideRecord>,
    private changed: (state: GuideState) => void,
  ) {}
  private update(change: Partial<GuideState>) {
    this.state = { ...this.state, ...change };
    this.changed(this.state);
  }
  async load() {
    if (this.state.saving) return;
    const revision = ++this.revision;
    try {
      const result = await this.request('get');
      if (revision !== this.revision) return;
      this.update({
        open: result.status === 'unseen',
        step: this.state.open ? this.state.step : 0,
        error: '',
      });
    } catch (error) {
      if (revision === this.revision) this.update({ error: String(error) });
    }
  }
  move(step: number, lastStep: number) {
    if (!this.state.saving) this.update({ step: Math.max(0, Math.min(lastStep, step)) });
  }
  // Called only for the main process's successful reset notification. An ordinary
  // focus refresh keeps progress, while explicit replay always returns to welcome.
  replaySaved() {
    this.update({ step: 0 });
    return this.load();
  }
  async persist(action: Exclude<GuideAction, 'get'>) {
    if (this.state.saving) return;
    ++this.revision;
    this.update({ saving: true, error: '' });
    try {
      const result = await this.request(action);
      const expected =
        action === 'reset' ? 'unseen' : action === 'dismiss' ? 'dismissed' : 'completed';
      if (result.version !== 1 || result.status !== expected)
        throw new Error('Rushes could not save the guide choice. Please try again.');
      this.update({ open: action === 'reset', step: 0, saving: false });
    } catch (error) {
      this.update({ saving: false, error: String(error).replace(/^Error: /, '') });
    }
  }
}

export function guideAllowed(state: string, countdown: number | null) {
  return (
    countdown === null && ['idle', 'complete', 'recovered', 'failed', 'offline'].includes(state)
  );
}

export type TourRect = { left: number; top: number; width: number; height: number };
export function visibleTourRect(
  rect: TourRect | null,
  width: number,
  height: number,
): TourRect | null {
  if (
    !rect ||
    ![rect.left, rect.top, rect.width, rect.height, width, height].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    width <= 0 ||
    height <= 0
  )
    return null;
  const left = Math.max(0, rect.left - 6),
    top = Math.max(0, rect.top - 6);
  const right = Math.min(width, rect.left + rect.width + 6);
  const bottom = Math.min(height, rect.top + rect.height + 6);
  return right > left && bottom > top
    ? { left, top, width: right - left, height: bottom - top }
    : null;
}

export function guideCardPosition(target: TourRect | null, viewport: TourRect, card: TourRect) {
  const margin = 12;
  const width = Math.min(card.width, Math.max(0, viewport.width - margin * 2));
  let height = Math.min(card.height, Math.max(0, viewport.height - margin * 2));
  const left = Math.min(
    Math.max(margin, target?.left ?? (viewport.width - width) / 2),
    Math.max(margin, viewport.width - width - margin),
  );
  let top = (viewport.height - height) / 2;
  if (target) {
    const below = target.top + target.height + margin;
    const above = target.top - height - margin;
    if (below + height <= viewport.height - margin) top = below;
    else if (above >= margin) top = above;
    else {
      const aboveSpace = Math.max(0, target.top - margin * 2);
      const belowSpace = Math.max(0, viewport.height - below - margin);
      // A scrollable card leaves the actual permission/device controls uncovered.
      if (Math.max(aboveSpace, belowSpace) >= Math.min(150, height)) {
        if (aboveSpace > belowSpace) {
          height = Math.min(height, aboveSpace);
          top = margin;
        } else {
          height = Math.min(height, belowSpace);
          top = below;
        }
      } else top = viewport.height - height - margin;
    }
  }
  return { left, top: Math.max(margin, top), maxHeight: height };
}
