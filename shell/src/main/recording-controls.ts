import type { EngineEvent } from '../shared/contracts';

// Countdown sounds follow native steps, rather than a second renderer timer.
export class CountdownSignals {
  private id?: string;
  private last = Infinity;
  private armed = false;
  cancel() {
    this.armed = false;
    this.id = undefined;
    this.last = Infinity;
  }
  current(event: EngineEvent) {
    return this.armed && event.recordingId === this.id;
  }
  event(event: EngineEvent): number | undefined {
    if (event.event === 'state-changed' && event.state === 'armed') {
      this.armed = true;
      this.id = typeof event.recordingId === 'string' ? event.recordingId : undefined;
      this.last = Infinity;
    }
    if (
      ['recording-started', 'recording-stopped', 'engine-reconnected'].includes(event.event) ||
      (event.event === 'state-changed' &&
        ['idle', 'finishing', 'failed'].includes(String(event.state)))
    )
      this.cancel();
    if (event.event !== 'countdown' || !this.armed || event.recordingId !== this.id) return;
    const remaining = Number(
      (event.result as { remaining?: unknown })?.remaining ?? event.remaining,
    );
    if (!Number.isInteger(remaining) || remaining < 0 || remaining > 10) return;
    if (remaining === 0) {
      this.cancel();
      return;
    }
    if (remaining >= this.last) return;
    this.last = remaining;
    return remaining;
  }
}

export type StartupAttempt = { canceled: boolean; issued: boolean };
export class RecordingStartup {
  private pending?: StartupAttempt;
  begin(): StartupAttempt {
    if (this.pending)
      throw Object.assign(new Error('A recording is already starting.'), { code: 'wrong-state' });
    return (this.pending = { canceled: false, issued: false });
  }
  get canceling() {
    return this.pending?.canceled === true;
  }
  cancelBeforeIssue() {
    if (!this.pending) return false;
    this.pending.canceled = true;
    return !this.pending.issued;
  }
  issue(attempt: StartupAttempt) {
    if (this.pending !== attempt || attempt.canceled)
      throw Object.assign(new Error('Recording startup canceled.'), { code: 'cancelled' });
    attempt.issued = true;
  }
  finish(attempt: StartupAttempt) {
    if (this.pending === attempt) this.pending = undefined;
  }
}

export class RecordingWindowLifecycle {
  private lastId?: string;
  event(event: EngineEvent, minimize: () => void): boolean {
    if (event.event !== 'recording-started') return false;
    const id = event.recordingId;
    if (typeof id !== 'string' || !id || id === this.lastId) return false;
    this.lastId = id;
    minimize();
    return true;
  }
}
