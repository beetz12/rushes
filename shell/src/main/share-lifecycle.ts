import type { ShareFeedback } from '../shared/contracts';
import {
  FileSeenStore,
  type SeenShare,
  type SeenShares,
  type SeenStore,
} from './share-watch-store';

export class AutoShare {
  private stopped = new Set<string>();
  constructor(
    private share: (id: string) => Promise<{ url: string; state: string }>,
    private copy: (url: string) => void | Promise<void>,
    private emit: (event: Record<string, unknown>) => void,
    private now = () => Date.now(),
  ) {}
  async recordingStopped(id: string, enabled: boolean) {
    if (!enabled || this.stopped.has(id)) return;
    this.stopped.add(id);
    const began = this.now();
    try {
      const result = await this.share(id);
      await this.copy(result.url);
      this.emit({
        event: 'share-link-copied',
        id,
        url: result.url,
        elapsedMs: this.now() - began,
        state: result.state,
      });
    } catch {
      this.emit({
        event: 'warning',
        id,
        code: 'auto-share-failed',
        message:
          'Automatic sharing failed. Your local recording is kept. Use Copy share link to retry.',
      });
    }
  }
}

type FeedbackSnapshot = { key: string; id: string; title: string; feedback: ShareFeedback };
// `partial` marks a load that skipped shares after a transient failure, so their remembered
// state must not be pruned.
type FeedbackLoad = FeedbackSnapshot[] & { partial?: boolean };
type FeedbackComment = ShareFeedback['comments'][number];
const COMMENT_ID_CAP = 500;

function plural(count: number, word: string) {
  return `${count} new ${word}${count === 1 ? '' : 's'}`;
}
// Commenter text reaches a desktop notification: drop control and direction-override characters,
// collapse whitespace and cut on code points so a surrogate pair is never split.
export function shortText(value: string, limit: number) {
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(clean);
  return chars.length <= limit
    ? clean
    : `${chars
        .slice(0, limit - 1)
        .join('')
        .trimEnd()}…`;
}
function commentLine(fresh: FeedbackComment[]) {
  const latest = fresh.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  const name = shortText(latest.name, 40) || 'Someone';
  const excerpt = shortText(latest.body, 80);
  const quoted = excerpt ? `: “${excerpt}”` : '';
  return fresh.length === 1
    ? `${name} commented${quoted}`
    : `${plural(fresh.length, 'comment')}, latest from ${name}${quoted}`;
}
export function feedbackMessage(
  plays: number,
  total: number,
  fresh: FeedbackComment[],
  away: boolean,
) {
  const parts: string[] = [];
  if (plays > 0)
    parts.push(`${plural(plays, 'play')}${away ? ' while you were away' : ''} · ${total} total`);
  if (fresh.length) parts.push(commentLine(fresh));
  if (!parts.length) return;
  const message = parts.join(' · ');
  return away && plays === 0 ? `While you were away: ${message}` : message;
}
function remember(comments: FeedbackComment[], views: number, before?: SeenShare): SeenShare {
  const newest = [...comments].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const kept = newest.slice(0, COMMENT_ID_CAP);
  let floor = before?.commentFloor;
  if (newest.length > kept.length) {
    const oldest = kept[kept.length - 1].createdAt;
    if (!floor || oldest > floor) floor = oldest;
  }
  return {
    // Count decreases never create phantom plays later.
    views: before ? Math.max(before.views, views) : views,
    comments: kept.map((c) => c.id),
    ...(floor ? { commentFloor: floor } : {}),
  };
}

export class ViewNotifications {
  private seen?: Map<string, SeenShare>;
  // Shares restored from disk that this launch has not polled yet: their news is "while away".
  private restored = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private stopped = false;
  constructor(
    private load: () => Promise<FeedbackLoad>,
    private emit: (event: Record<string, unknown>) => void,
    private notify: (title: string, message: string) => void,
    private store: SeenStore = new FileSeenStore(),
  ) {}
  start() {
    if (this.timer) return;
    this.stopped = false;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 5 * 60 * 1000);
    this.timer.unref?.();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }
  private async restore() {
    if (this.seen) return this.seen;
    let loaded: SeenShares = {};
    try {
      loaded = await this.store.load();
    } catch {
      // Start fresh: every share gets a silent baseline.
    }
    this.seen = new Map(Object.entries(loaded));
    this.restored = new Set(this.seen.keys());
    return this.seen;
  }
  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const values = await this.load();
      if (this.stopped) return;
      const seen = await this.restore();
      if (this.stopped) return;
      const before = JSON.stringify([...seen]);
      for (const value of values) {
        const previous = seen.get(value.key),
          away = this.restored.delete(value.key),
          { views, comments } = value.feedback;
        seen.set(value.key, remember(comments, views, previous));
        this.emit({ event: 'share-feedback', id: value.id, ...value.feedback });
        // A share seen for the first time (including one just created here) is a silent baseline.
        if (!previous) continue;
        const known = new Set(previous.comments),
          floor = previous.commentFloor;
        const fresh = comments.filter(
          (c) => !known.has(c.id) && !(floor !== undefined && c.createdAt <= floor),
        );
        // One notification per share per poll, covering plays and comments together.
        const message = feedbackMessage(Math.max(0, views - previous.views), views, fresh, away);
        if (message) this.notify(value.title, message);
      }
      if (!values.partial) {
        const live = new Set(values.map((v) => v.key));
        for (const key of [...seen.keys()])
          if (!live.has(key)) {
            seen.delete(key);
            this.restored.delete(key);
          }
      }
      if (JSON.stringify([...seen]) !== before)
        await this.store.save(Object.fromEntries(seen)).catch(() => {});
    } catch {
      if (!this.stopped)
        this.emit({
          event: 'warning',
          code: 'share-feedback-poll-failed',
          message: 'Viewer feedback could not be refreshed. The last view count is kept.',
        });
    } finally {
      this.polling = false;
    }
  }
}
