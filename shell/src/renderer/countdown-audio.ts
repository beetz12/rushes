// Original synthesized 70 ms sine chirps, with a soft envelope and modest gain.
// No sound assets, timers, or audio sources from other applications are used.
export class CountdownAudio {
  private context?: AudioContext;
  private generation = 0;
  private playing = new Set<OscillatorNode>();
  private audioContext() {
    return (this.context ??= new AudioContext());
  }
  async prepare() {
    await this.audioContext().resume();
  }
  async tick(remaining: number) {
    if (!Number.isInteger(remaining) || remaining <= 0) return;
    const generation = this.generation;
    const context = this.audioContext();
    await context.resume();
    if (generation !== this.generation) return;
    const oscillator = context.createOscillator(),
      gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = remaining === 1 ? 880 : 660;
    const now = context.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    oscillator.connect(gain);
    gain.connect(context.destination);
    this.playing.add(oscillator);
    oscillator.onended = () => {
      this.playing.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(now);
    oscillator.stop(now + 0.075);
  }
  cancel() {
    ++this.generation;
    for (const oscillator of this.playing) {
      try {
        oscillator.stop();
      } catch {}
    }
    this.playing.clear();
  }
  close() {
    this.cancel();
    void this.context?.close();
    this.context = undefined;
  }
}
