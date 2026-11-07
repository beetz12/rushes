export type DraftState = 'saved' | 'pending' | 'saving' | 'failed';
export async function persistReviewDraft(
  request: (cmd: string, args: Record<string, unknown>) => Promise<unknown>,
  id: string,
  patch: Record<string, unknown>,
) {
  const { summary, ...fields } = patch;
  await request('edit.set', { id, ...fields });
  if (typeof summary === 'string')
    await request('meta.set', {
      id,
      summary,
      ...(typeof fields.title === 'string' ? { title: fields.title } : {}),
    });
}
export function refreshedMetadata(
  loaded: Record<string, unknown>,
  manualSummary: string | undefined,
) {
  return { ...loaded, ...(manualSummary === undefined ? {} : { summary: manualSummary }) };
}
export function sidebarDraft(document: any, fallbackTitle: string): Record<string, unknown> {
  const bubble = document.layout?.bubble;
  return {
    layout: document.layout?.preset ?? 'bubble',
    bubbleSize: bubble?.size ?? 0.22,
    bubbleX: bubble?.center?.[0] ?? 0.12,
    bubbleY: bubble?.center?.[1] ?? 0.82,
    bubbleVisible: bubble?.visible ?? true,
    shape: bubble?.shape ?? 'circle',
    mirror: bubble?.mirror ?? true,
    micGain: document.audio?.micGain ?? 1,
    noiseSuppression: document.audio?.noiseSuppression ?? false,
    systemGain: document.audio?.systemGain ?? 0.5,
    title: document.meta?.title ?? fallbackTitle,
    burnIn: document.captions?.burnIn ?? false,
    clickHighlight: document.clickHighlight === true,
  };
}
export class DraftAutosave<T> {
  private pending?: T;
  private timer?: ReturnType<typeof setTimeout>;
  private drain?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private persist: (value: T) => Promise<unknown>,
    private state: (value: DraftState) => void,
    private delay = 250,
  ) {}
  update(value: T) {
    this.pending = structuredClone(value);
    this.state('pending');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush().catch(() => {}), this.delay);
  }
  private enqueue<R>(action: () => Promise<R>): Promise<R> {
    const next = this.queue.then(action);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.drain) return this.drain;
    const operation = (async () => {
      await this.queue;
      while (this.pending !== undefined) {
        const value = this.pending;
        this.pending = undefined;
        this.state('saving');
        try {
          await this.enqueue(() => this.persist(value));
        } catch (error) {
          this.pending ??= value;
          this.state('failed');
          throw error;
        }
      }
      this.state('saved');
    })();
    this.drain = operation.finally(() => {
      this.drain = undefined;
    });
    return this.drain;
  }
  async run<R>(action: () => Promise<R>): Promise<R> {
    await this.flush();
    return this.enqueue(action);
  }
}
export type KeptClip = { id: string; sourceStartMs: number; sourceEndMs: number };
export type ZoomCue = {
  id: string;
  clipId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  scale: number;
  focus: [number, number];
  origin: 'auto' | 'manual';
};
export function validateZoomCue(cue: ZoomCue, clips: KeptClip[]): ZoomCue {
  const clip = clips.find((value) => value.id === cue.clipId);
  if (
    !clip ||
    !cue.id ||
    ![cue.sourceStartMs, cue.sourceEndMs, cue.scale, ...cue.focus].every(Number.isFinite) ||
    cue.sourceStartMs < clip.sourceStartMs ||
    cue.sourceEndMs > clip.sourceEndMs ||
    cue.sourceEndMs <= cue.sourceStartMs ||
    cue.scale < 1 ||
    cue.scale > 4 ||
    cue.focus.length !== 2 ||
    cue.focus.some((value) => value < 0 || value > 1)
  )
    throw Object.assign(
      new Error(
        'Keep the zoom range inside one kept clip, scale from 1 to 4, and focus from 0 to 1.',
      ),
      { code: 'invalid-zoom-cue' },
    );
  return { ...cue, origin: 'manual', focus: [...cue.focus] };
}
export function videoExportRequest(id: string, selection: string, path: string) {
  return {
    id,
    preset:
      selection === 'youtube-source' ? 'youtube' : selection === 'audio-wav' ? 'audio' : selection,
    path,
    ...(selection === 'youtube-source' ? { sourceSize: true } : {}),
  };
}
type TimelineClip = { sourceStartMs: number; sourceEndMs: number; speed?: number };
/** Maps a playhead in the source tracks to the edited (exported) timeline.
 * A playhead inside a removed range snaps to the next kept clip. */
export function editedTimeForSource(clips: TimelineClip[], sourceMs: number): number {
  let elapsed = 0,
    next: number | undefined;
  for (const clip of clips) {
    const speed = clip.speed || 1;
    if (sourceMs >= clip.sourceStartMs && sourceMs < clip.sourceEndMs)
      return elapsed + (sourceMs - clip.sourceStartMs) / speed;
    if (next === undefined && clip.sourceStartMs > sourceMs) next = elapsed;
    elapsed += (clip.sourceEndMs - clip.sourceStartMs) / speed;
  }
  return next ?? elapsed;
}
/** The current frame in edited-timeline milliseconds, for the share poster and
 * the thumbnail export. A rendered preview already plays the edited timeline.
 * The result stays one frame inside the edit, which the engine requires. */
export function posterTimeForPlayhead(
  clips: TimelineClip[],
  playheadSeconds: number,
  renderedPreview: boolean,
): number {
  const ms = Math.max(0, playheadSeconds * 1000);
  const edited = renderedPreview || !clips.length ? ms : editedTimeForSource(clips, ms);
  const total = clips.reduce(
    (sum, clip) => sum + (clip.sourceEndMs - clip.sourceStartMs) / (clip.speed || 1),
    0,
  );
  const last = total > 0 ? Math.max(0, Math.floor(total - 1000 / 30)) : Infinity;
  return Math.min(Math.round(edited), last);
}
