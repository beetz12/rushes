import { randomUUID } from 'node:crypto';
import {
  preflightAcknowledgmentSchema,
  microphoneLevelSchema,
  screenPreviewSchema,
  type PreflightAcknowledgment,
  type MicrophoneLevel,
  type ScreenPreview,
} from '../shared/contracts';

// One desired selection, one serialized native acquisition/drain sequence and
// one screenshot request. Hiding invalidates publication before awaiting native
// cleanup; an obsolete stop carries its originating selection token.
export class IdleCapturePreflight {
  private generation = 0;
  private issued?: { token: string; revision: number };
  private closing?: { token: string; promise: Promise<unknown> };
  private key?: string;
  private acknowledgment?: PreflightAcknowledgment;
  private queue: Promise<unknown> = Promise.resolve();
  private warming?: Promise<unknown>;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private actions: {
      allowed(): boolean;
      start(
        selectionToken: string,
        selectionRevision: number,
        args: Record<string, unknown>,
      ): Promise<unknown>;
      stop(selectionToken: string, selectionRevision: number): Promise<unknown>;
      snapshot(previewToken: string): Promise<unknown>;
      clear(): void;
      ready(value: PreflightAcknowledgment): void;
      image(value: ScreenPreview): void;
      error(error: unknown): void;
    },
  ) {}
  get currentAcknowledgment() {
    return this.actions.allowed() ? this.acknowledgment : undefined;
  }

  select(args: Record<string, unknown>): Promise<unknown> {
    const key = JSON.stringify(args);
    if (key === this.key && (this.acknowledgment || this.warming))
      return this.warming ?? Promise.resolve();
    const previous = this.invalidate();
    const generation = this.generation;
    const selection = randomUUID();
    this.key = key;
    // Stop can cancel an acquisition before its acknowledgment arrives.
    const cleanup = this.closeIssued(previous);
    void cleanup.catch(() => {});
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        try {
          await cleanup;
          if (!this.current(generation)) return;
          this.issued = { token: selection, revision: generation };
          const raw = await this.actions.start(selection, generation, args);
          if (!this.current(generation)) return;
          const value = preflightAcknowledgmentSchema.parse(raw);
          if (value.selectionToken !== selection || value.selectionRevision !== generation)
            throw new Error('Input preview selection did not match.');
          this.acknowledgment = value;
          this.actions.ready(value);
          if (value.source) void this.poll(generation, value);
        } catch (error) {
          if (generation === this.generation) {
            this.acknowledgment = undefined;
            this.actions.clear();
            await this.closeIssued(this.issued).catch(() => {});
          }
          throw error;
        }
      });
    this.queue = operation;
    this.warming = operation;
    void operation
      .catch((error) => {
        if (generation === this.generation) {
          this.key = undefined;
          this.acknowledgment = undefined;
          this.actions.error(error);
          if (this.actions.allowed() && (error as { code?: string })?.code === 'preflight-busy')
            this.timer = setTimeout(() => void this.select(args).catch(() => {}), 1000);
        }
      })
      .finally(() => {
        if (this.warming === operation) this.warming = undefined;
      });
    return operation;
  }

  acceptsLevel(raw: unknown): raw is MicrophoneLevel {
    if (!this.actions.allowed() || !this.acknowledgment) return false;
    const level = microphoneLevelSchema.safeParse(raw);
    return (
      level.success &&
      level.data.previewToken === this.acknowledgment.previewToken &&
      level.data.microphone === this.acknowledgment.microphone
    );
  }

  invalidate() {
    const previous = this.issued;
    ++this.generation;
    this.key = undefined;
    this.acknowledgment = undefined;
    this.warming = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.actions.clear();
    return previous;
  }

  stop(): Promise<unknown> {
    const previous = this.invalidate();
    const cleanup = this.closeIssued(previous);
    void cleanup.catch(() => {});
    const operation = this.queue.catch(() => {}).then(() => cleanup);
    this.queue = operation;
    return operation;
  }

  private closeIssued(
    selection: { token: string; revision: number } | undefined,
  ): Promise<unknown> {
    if (!selection) return Promise.resolve();
    if (this.closing?.token === selection.token) return this.closing.promise;
    let request: Promise<unknown>;
    try {
      request = this.actions.stop(selection.token, selection.revision);
    } catch (error) {
      request = Promise.reject(error);
    }
    const operation = request.then((value) => {
      if (this.issued?.token === selection.token) this.issued = undefined;
      return value;
    });
    this.closing = { token: selection.token, promise: operation };
    void operation
      .finally(() => {
        if (this.closing?.promise === operation) this.closing = undefined;
      })
      .catch(() => {});
    return operation;
  }

  private current(generation: number) {
    return generation === this.generation && this.actions.allowed();
  }

  private async poll(generation: number, acknowledgment: PreflightAcknowledgment) {
    if (!this.current(generation)) return;
    try {
      const raw = await this.actions.snapshot(acknowledgment.previewToken);
      if (!this.current(generation)) return;
      const image = screenPreviewSchema.parse(raw);
      if (
        image.previewToken !== acknowledgment.previewToken ||
        image.source !== acknowledgment.source
      )
        throw new Error('Screen preview source did not match.');
      this.actions.image(image);
    } catch (error) {
      if (this.current(generation)) this.actions.error(error);
    } finally {
      if (this.current(generation))
        this.timer = setTimeout(() => void this.poll(generation, acknowledgment), 1000);
    }
  }
}
