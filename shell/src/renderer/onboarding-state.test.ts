import { describe, expect, it, vi } from 'vitest';
import {
  GuideSession,
  guideAllowed,
  guideCardPosition,
  visibleTourRect,
  type GuideRecord,
} from './onboarding-state';

describe('durable first-use choices', () => {
  it('shows an unseen guide, waits for dismissal storage, and stays dismissed on relaunch', async () => {
    let record: GuideRecord = { version: 1, status: 'unseen' };
    let save: (() => void) | undefined;
    const request = vi.fn(async (action) => {
      if (action === 'dismiss')
        await new Promise<void>((resolve) => {
          save = () => {
            record = { version: 1, status: 'dismissed' };
            resolve();
          };
        });
      return record;
    });
    const session = new GuideSession(request, () => {});
    await session.load();
    expect(session.state.open).toBe(true);
    const pending = session.persist('dismiss');
    expect(session.state).toMatchObject({ open: true, saving: true });
    save!();
    await pending;
    expect(session.state.open).toBe(false);
    const relaunched = new GuideSession(request, () => {});
    await relaunched.load();
    expect(relaunched.state.open).toBe(false);
    expect(request.mock.calls.map(([action]) => action)).toEqual(['get', 'dismiss', 'get']);
  });
  it('completion persists without issuing recording commands; explicit replay starts at welcome', async () => {
    let record: GuideRecord = { version: 1, status: 'unseen' };
    const request = vi.fn(async (action) => {
      if (action === 'complete') record = { version: 1, status: 'completed' };
      if (action === 'reset') record = { version: 1, status: 'unseen' };
      return record;
    });
    const session = new GuideSession(request, () => {});
    await session.load();
    session.move(6, 6);
    await session.persist('complete');
    await session.load();
    expect(session.state.open).toBe(false);
    await session.persist('reset');
    expect(session.state).toMatchObject({ open: true, step: 0, saving: false });
    expect(request.mock.calls.map(([action]) => action)).toEqual([
      'get',
      'complete',
      'get',
      'reset',
    ]);
  });
  it('keeps controls and the guide available when saving fails or acknowledges the wrong choice', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ version: 1, status: 'unseen' })
      .mockRejectedValueOnce(new Error('Disk unavailable'))
      .mockResolvedValueOnce({ version: 1, status: 'unseen' });
    const session = new GuideSession(request, () => {});
    await session.load();
    await session.persist('dismiss');
    expect(session.state).toMatchObject({ open: true, saving: false, error: 'Disk unavailable' });
    await session.persist('complete');
    expect(session.state.open).toBe(true);
    expect(session.state.error).toContain('could not save');
  });
  it('prevents a late startup read from reviving a successfully dismissed guide', async () => {
    let resolveRead: ((value: GuideRecord) => void) | undefined;
    const request = vi.fn((action) =>
      action === 'get'
        ? new Promise<GuideRecord>((resolve) => {
            resolveRead = resolve;
          })
        : Promise.resolve<GuideRecord>({ version: 1, status: 'dismissed' }),
    );
    const session = new GuideSession(request, () => {});
    const read = session.load();
    await session.persist('dismiss');
    resolveRead!({ version: 1, status: 'unseen' });
    await read;
    expect(session.state.open).toBe(false);
  });
});

describe('guide visibility and reachable layout', () => {
  it('cannot appear during warm-up, countdown, a take or finalization', () => {
    for (const state of ['preparing', 'armed', 'recording', 'paused', 'finishing'])
      expect(guideAllowed(state, null)).toBe(false);
    expect(guideAllowed('idle', 0)).toBe(false);
    expect(guideAllowed('idle', 3)).toBe(false);
    expect(guideAllowed('idle', null)).toBe(true);
    expect(guideAllowed('unknown', null)).toBe(false);
  });
  it('clips actual bounds after scrolling, and rejects missing or unusable targets', () => {
    expect(visibleTourRect({ left: -30, top: -20, width: 200, height: 80 }, 320, 480)).toEqual({
      left: 0,
      top: 0,
      width: 176,
      height: 66,
    });
    expect(visibleTourRect({ left: 400, top: 100, width: 30, height: 30 }, 320, 480)).toBeNull();
    expect(visibleTourRect(null, 320, 480)).toBeNull();
    expect(visibleTourRect({ left: NaN, top: 0, width: 30, height: 30 }, 320, 480)).toBeNull();
    expect(visibleTourRect({ left: 0, top: 0, width: 0, height: 30 }, 320, 480)).toBeNull();
  });
  it('keeps the guide card within narrow and resized windows, with safe fallback for missing targets', () => {
    const card = { left: 0, top: 0, width: 380, height: 290 };
    for (const viewport of [
      { left: 0, top: 0, width: 320, height: 480 },
      { left: 0, top: 0, width: 920, height: 730 },
    ]) {
      for (const target of [null, { left: 260, top: 450, width: 50, height: 30 }]) {
        const result = guideCardPosition(target, viewport, card);
        expect(result.left).toBeGreaterThanOrEqual(12);
        expect(result.top).toBeGreaterThanOrEqual(12);
        expect(result.left + Math.min(card.width, viewport.width - 24)).toBeLessThanOrEqual(
          viewport.width - 12,
        );
        expect(result.top + result.maxHeight).toBeLessThanOrEqual(viewport.height - 12);
      }
    }
  });
  it('shrinks to a scrollable card to leave a tall permission panel usable', () => {
    const target = { left: 250, top: 250, width: 500, height: 270 };
    const result = guideCardPosition(
      target,
      { left: 0, top: 0, width: 900, height: 730 },
      { left: 0, top: 0, width: 380, height: 350 },
    );
    expect(result.maxHeight).toBeLessThan(350);
    expect(result.top + result.maxHeight).toBeLessThan(target.top);
  });
});
