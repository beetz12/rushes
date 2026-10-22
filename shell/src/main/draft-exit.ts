/// <reference lib="es2024.promise" />
import { randomUUID } from 'node:crypto';

// One outstanding request; late renderer replies cannot approve a later Quit.
export class DraftExitRequests {
  private pending?: {
    token: string;
    promise: Promise<void>;
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  };
  constructor(
    private send: (token: string) => void,
    private deadlineMs = 5000,
  ) {}
  flush(): Promise<void> {
    if (this.pending) return this.pending.promise;
    const completion = Promise.withResolvers<void>(),
      token = randomUUID();
    const timer = setTimeout(
      () => this.reply(token, 'The editor did not confirm its draft save. Try Quit again.'),
      this.deadlineMs,
    );
    this.pending = { token, ...completion, timer };
    try {
      this.send(token);
    } catch (error) {
      this.reply(token, String(error));
    }
    return completion.promise;
  }
  reply(token: string, error?: string) {
    const pending = this.pending;
    if (!pending || pending.token !== token) return false;
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (error) pending.reject(Object.assign(new Error(error), { code: 'draft-save-failed' }));
    else pending.resolve();
    return true;
  }
}
