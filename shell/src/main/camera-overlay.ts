// Invalidates camera warm-up and take lookup callbacks when their window/take ends.
// The recorder owns camera acquisition; hiding an overlay never stops an active writer.
export class CameraOverlayLifecycle {
  private generation = 0;
  private visible = false;

  begin() {
    this.visible = true;
    return ++this.generation;
  }
  hide() {
    this.visible = false;
    return ++this.generation;
  }
  sameGeneration(token: number) {
    return token === this.generation;
  }
  newTake(previousState: string, nextState: string) {
    if (previousState !== 'idle' || !['preparing', 'armed'].includes(nextState)) return false;
    this.hide();
    return true;
  }
  current(token: number) {
    return this.visible && token === this.generation;
  }
  async showWhenReady<T>(
    prepare: (current: () => boolean) => Promise<T>,
    show: (result: T) => void,
    token = this.begin(),
  ): Promise<T> {
    const result = await prepare(() => this.current(token));
    if (this.current(token)) show(result);
    return result;
  }
}

export function recoveredBubbleHidden(
  previousId: string | undefined,
  nextId: string | undefined,
  state: string,
  hidden: boolean,
) {
  return (
    hidden &&
    !!previousId &&
    previousId === nextId &&
    ['armed', 'recording', 'paused', 'finishing'].includes(state)
  );
}
