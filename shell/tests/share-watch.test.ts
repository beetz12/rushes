import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ViewNotifications, feedbackMessage, shortText } from '../src/main/share-lifecycle';
import { FileSeenStore } from '../src/main/share-watch-store';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function storePath() {
  const root = await mkdtemp(join(tmpdir(), 'rushes-share-watch-'));
  roots.push(root);
  return join(root, 'share-watch.json');
}
type Comment = { id: string; name: string; body: string; timestampMs: number; createdAt: string };
const comment = (id: string, name: string, body: string, minute = 0): Comment => ({
  id,
  name,
  body,
  timestampMs: 1000,
  createdAt: `2026-11-06T12:${String(minute).padStart(2, '0')}:00Z`,
});
function feed(shares: Record<string, { views: number; comments?: Comment[] }>) {
  return Object.entries(shares).map(([key, value]) => ({
    key,
    id: `rec-${key}`,
    title: `Video ${key}`,
    feedback: { views: value.views, comments: value.comments ?? [], reactions: [] },
  }));
}
function poller(path: string, load: () => Promise<any>) {
  const notify = vi.fn(),
    emit = vi.fn();
  return {
    notify,
    emit,
    watch: new ViewNotifications(load, emit, notify, new FileSeenStore(path)),
  };
}

describe('viewer feedback notifications across launches', () => {
  it('records a silent baseline the first time a share is seen, including a just-created one', async () => {
    const path = await storePath();
    const first = poller(path, async () =>
      feed({ a: { views: 9, comments: [comment('c1', 'Ana', 'Hi')] } }),
    );
    await first.watch.poll();
    expect(first.notify).not.toHaveBeenCalled();
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.shares.a).toEqual({ views: 9, comments: ['c1'] });
  });

  it('reports plays and comments that arrived while the app was closed, once', async () => {
    const path = await storePath();
    let current = feed({ a: { views: 4 }, b: { views: 2 } });
    const before = poller(path, async () => current);
    await before.watch.poll();
    before.watch.stop();
    current = feed({
      a: { views: 7 },
      b: { views: 2, comments: [comment('c9', 'Bo', 'Nice walkthrough', 5)] },
    });
    const after = poller(path, async () => current);
    await after.watch.poll();
    expect(after.notify.mock.calls).toEqual([
      ['Video a', '3 new plays while you were away · 7 total'],
      ['Video b', 'While you were away: Bo commented: “Nice walkthrough”'],
    ]);
    await after.watch.poll();
    expect(after.notify).toHaveBeenCalledTimes(2);
    current = feed({ a: { views: 8 }, b: { views: 2 } });
    await after.watch.poll();
    expect(after.notify).toHaveBeenLastCalledWith('Video a', '1 new play · 8 total');
  });

  it('coalesces new plays and several comments into one notification per share per poll', async () => {
    const path = await storePath();
    let current = feed({ a: { views: 1 } });
    const { watch, notify } = poller(path, async () => current);
    await watch.poll();
    current = feed({
      a: {
        views: 3,
        comments: [comment('x', 'Ana', 'First', 1), comment('y', 'Cy', 'Second one', 2)],
      },
    });
    await watch.poll();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      'Video a',
      '2 new plays · 3 total · 2 new comments, latest from Cy: “Second one”',
    );
  });

  it('writes commenter text safely: no control characters, truncated on code points', () => {
    const body = `Line one\n‮flipped ${'😀'.repeat(100)}`;
    const text = shortText(body, 20);
    expect(Array.from(text)).toHaveLength(20);
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toMatch(/[\n‮]/);
    expect(text).not.toMatch(/[\ud800-\udbff]…$/);
    expect(feedbackMessage(0, 5, [comment('z', '   ', '')], false)).toBe('Someone commented');
    expect(feedbackMessage(0, 5, [], false)).toBeUndefined();
  });

  it('starts fresh from a corrupt or malformed file without crashing or notifying', async () => {
    for (const content of ['{not json', JSON.stringify({ schema: 'other', shares: {} })]) {
      const path = await storePath();
      await writeFile(path, content);
      const { watch, notify, emit } = poller(path, async () => feed({ a: { views: 50 } }));
      await watch.poll();
      expect(notify).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'warning' }));
      expect(JSON.parse(await readFile(path, 'utf8')).shares.a.views).toBe(50);
    }
    const path = await storePath();
    await writeFile(
      path,
      JSON.stringify({
        schema: 'rushes.share-watch/1',
        shares: { a: { views: -1, comments: [] }, b: { views: 2, comments: ['k'] } },
      }),
    );
    expect(await new FileSeenStore(path).load()).toEqual({ b: { views: 2, comments: ['k'] } });
  });

  it('prunes unshared or deleted shares, but keeps them after a partial load', async () => {
    const path = await storePath();
    let current: any = feed({ a: { views: 1 }, b: { views: 1 } });
    const { watch, notify } = poller(path, async () => current);
    await watch.poll();
    current = Object.defineProperty(feed({ a: { views: 1 } }), 'partial', { value: true });
    await watch.poll();
    expect(Object.keys(JSON.parse(await readFile(path, 'utf8')).shares)).toEqual(['a', 'b']);
    current = feed({ a: { views: 1 } });
    await watch.poll();
    expect(Object.keys(JSON.parse(await readFile(path, 'utf8')).shares)).toEqual(['a']);
    // A share that comes back after pruning is a new baseline, not a burst of old plays.
    current = feed({ a: { views: 1 }, b: { views: 40 } });
    await watch.poll();
    expect(notify).not.toHaveBeenCalled();
  });
});
