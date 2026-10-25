import { randomUUID } from 'node:crypto';
import type { NativeUpdateHold } from './engine';
import type { UpdateSnapshot } from './updater';
export type UpdateRestartDependencies = {
  snapshot(): UpdateSnapshot;
  recordingBusy(): boolean;
  flush(): Promise<void>;
  acquire(token: string): Promise<NativeUpdateHold>;
  release(hold: NativeUpdateHold): Promise<void>;
  restart(): UpdateSnapshot;
  committed(): boolean;
  preparing(value: boolean): void;
};
// The native hold owns admission across the async idle/flush/install boundary.
// An install that has reached the native updater cannot be cancelled safely.
export class UpdateRestartGate {
  private running?: Promise<UpdateSnapshot>;
  #uncertainHold?: NativeUpdateHold;
  constructor(private dependencies: UpdateRestartDependencies) {}
  run(): Promise<UpdateSnapshot> {
    if (this.running) return this.running;
    const operation = this.perform().finally(() => {if (this.running === operation) this.running = undefined;});
    this.running = operation; return operation;
  }
  recover(): Promise<UpdateSnapshot> {
    if (this.running) return this.running;
    const operation = this.performRecovery().finally(() => {if (this.running === operation) this.running = undefined;});
    this.running = operation; return operation;
  }
  private async performRecovery(): Promise<UpdateSnapshot> {
    const hold = this.#uncertainHold;
    if (!hold) return this.dependencies.snapshot();
    this.dependencies.preparing(true);
    try {await this.dependencies.release(hold); this.#uncertainHold = undefined; return this.dependencies.snapshot();}
    finally {this.dependencies.preparing(false);}
  }
  private async perform() {
    const d = this.dependencies;
    if (this.#uncertainHold) throw Error('Recover the update connection before restarting or recording.');
    if (d.snapshot().status !== 'downloaded') return d.snapshot();
    if (d.recordingBusy()) throw Error('Finish recording and any account connection before installing the update.');
    let hold: NativeUpdateHold | undefined;
    d.preparing(true);
    try {
      await d.flush();
      if (d.recordingBusy()) throw Error('Recording activity changed. The update is still available after Stop.');
      const token = randomUUID();
      try {hold = await d.acquire(token);}
      catch (error) {
        const value = error as {code?: string; hold?: NativeUpdateHold};
        if (value.code === 'update-hold-cleanup-unknown' && value.hold?.token === token && Number.isSafeInteger(value.hold.pid) && value.hold.pid > 1) this.#uncertainHold = value.hold;
        throw error;
      }
      return d.restart();
    } finally {
      try {if (hold && !d.committed()) {try {await d.release(hold);} catch (error) {this.#uncertainHold = hold; throw error;}}}
      finally {d.preparing(false);}
    }
  }
}
