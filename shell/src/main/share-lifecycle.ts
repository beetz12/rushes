import type { ShareFeedback } from '../shared/contracts';

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
export class ViewNotifications {
  private counts = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private stopped = false;
  constructor(
    private load: () => Promise<FeedbackSnapshot[]>,
    private emit: (event: Record<string, unknown>) => void,
    private notify: (title: string, message: string) => void,
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
  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const values = await this.load();
      if (this.stopped) return;
      for (const value of values) {
        const before = this.counts.get(value.key),
          current = value.feedback.views;
        // Baseline historical plays silently; count decreases never create phantom plays.
        this.counts.set(value.key, before === undefined ? current : Math.max(before, current));
        this.emit({ event: 'share-feedback', id: value.id, ...value.feedback });
        if (before !== undefined && current > before)
          this.notify(
            value.title,
            `${current - before} new ${current - before === 1 ? 'play' : 'plays'} · ${current} total`,
          );
      }
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
