// Native camera warm-up cannot overlap another warm-up. Keep selections in order,
// but invalidate their UI/frame callbacks immediately when a newer choice wins.
export class IdleCameraPreview {
  private generation = 0;
  private camera?: string;
  private frames = false;
  private queue: Promise<unknown> = Promise.resolve();
  private warming?: Promise<unknown>;
  constructor(
    private actions: {
      allowed(): boolean;
      start(camera: string): Promise<unknown>;
      stop(): Promise<unknown>;
      clear(): void;
      show(): void;
    },
  ) {}
  get acceptsFrames() {
    return this.frames && this.actions.allowed();
  }
  select(camera: string): Promise<unknown> {
    if (camera === this.camera && (this.frames || this.warming))
      return this.warming ?? Promise.resolve();
    const generation = ++this.generation;
    this.camera = camera;
    this.frames = false;
    this.actions.clear();
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        if (generation !== this.generation || !this.actions.allowed()) return;
        await this.actions.stop();
        if (generation !== this.generation || !this.actions.allowed()) return;
        try {
          const result = await this.actions.start(camera);
          if (generation === this.generation && this.actions.allowed()) {
            this.frames = true;
            this.actions.show();
          }
          return result;
        } catch (error) {
          if (generation === this.generation) {
            this.camera = undefined;
            throw error;
          }
        }
      });
    this.queue = operation;
    this.warming = operation;
    void operation
      .finally(() => {
        if (this.warming === operation) this.warming = undefined;
      })
      .catch(() => {});
    return operation;
  }
  invalidate() {
    ++this.generation;
    this.camera = undefined;
    this.frames = false;
    this.warming = undefined;
    this.actions.clear();
  }
  stop(): Promise<unknown> {
    this.invalidate();
    const operation = this.queue.catch(() => {}).then(() => this.actions.stop());
    this.queue = operation;
    return operation;
  }
}
