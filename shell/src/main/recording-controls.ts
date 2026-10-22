import type { EngineEvent } from '../shared/contracts';
import { z } from 'zod';

const retainedTake = z.object({
  manifest: z.object({
    id: z.string(),
    status: z.enum(['complete', 'failed', 'recovered']),
    tracks: z.array(z.object({ present: z.boolean() })),
  }),
});

export function retainedFinishedTake(id: string, response: unknown): string | undefined {
  const parsed = retainedTake.safeParse(response);
  if (
    parsed.success &&
    parsed.data.manifest.id === id &&
    parsed.data.manifest.tracks.some((track) => track.present)
  )
    return id;
}

export async function recoverIdleRecorder(
  id: string | undefined,
  io: {
    current(): boolean;
    show(id: string): Promise<unknown>;
    open(id: string): void;
    rearm(): Promise<void>;
  },
) {
  let retained: string | undefined;
  if (id) {
    try {
      retained = retainedFinishedTake(id, await io.show(id));
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'status-superseded') return;
      if (code !== 'not-found') throw error;
    }
  }
  if (!io.current()) return;
  if (retained) io.open(retained);
  else await io.rearm();
}

export function recordingStoppedActions(event: EngineEvent) {
  const payload = event.result;
  const discard =
    !!payload &&
    typeof payload === 'object' &&
    'discardRequested' in payload &&
    payload.discardRequested === true;
  return { view: discard ? 'recorder' : 'review', autoShare: !discard } as const;
}

// A status read started before a take transition must not restore the old UI.
export class NativeStatusRequests {
  private revision = 0;
  changed() {
    ++this.revision;
  }
  async read<T>(request: () => Promise<T>): Promise<T> {
    const revision = this.revision;
    const result = await request();
    if (revision !== this.revision)
      throw Object.assign(new Error('Recording state changed while status was being read.'), {
        code: 'status-superseded',
      });
    return result;
  }
}

export class AppQuitGate {
  private phase: 'idle' | 'closing' | 'confirmed' = 'idle';
  request() {
    if (this.phase === 'confirmed') return 'exit';
    if (this.phase === 'closing') return 'wait';
    this.phase = 'closing';
    return 'begin';
  }
  confirm() {
    this.phase = 'confirmed';
  }
  failed() {
    this.phase = 'idle';
  }
}

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
