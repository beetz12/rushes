import { afterEach, describe, expect, it, vi } from 'vitest';
import { CountdownAudio } from './countdown-audio';
afterEach(() => vi.unstubAllGlobals());
function rig() {
  const oscillators: any[] = [],
    gains: any[] = [];
  const context = {
    currentTime: 12,
    destination: {},
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    createOscillator: vi.fn(() => {
      const node = {
        type: '',
        frequency: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: undefined as undefined | (() => void),
      };
      oscillators.push(node);
      return node;
    }),
    createGain: vi.fn(() => {
      const node = {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(node);
      return node;
    }),
  };
  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        return context;
      }
    },
  );
  return { audio: new CountdownAudio(), context, oscillators, gains };
}
describe('original countdown audio', () => {
  it('synthesizes a short soft tone per step, with a higher last tone and no zero-step sound', async () => {
    const r = rig();
    await r.audio.prepare();
    await r.audio.tick(3);
    await r.audio.tick(1);
    await r.audio.tick(0);
    expect(r.oscillators).toHaveLength(2);
    expect(r.oscillators.map((node) => [node.type, node.frequency.value])).toEqual([
      ['sine', 660],
      ['sine', 880],
    ]);
    expect(r.oscillators[0].start).toHaveBeenCalledWith(12);
    expect(r.oscillators[0].stop).toHaveBeenCalledWith(12.075);
    expect(r.gains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.08, 12.008);
    r.oscillators[0].onended();
    expect(r.oscillators[0].disconnect).toHaveBeenCalled();
    expect(r.gains[0].disconnect).toHaveBeenCalled();
    r.audio.cancel();
    expect(r.oscillators[1].stop).toHaveBeenCalledTimes(2);
  });
  it('does not play a late AudioContext grant after cancellation and closes on unmount', async () => {
    const r = rig();
    let resume!: () => void;
    r.context.resume.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resume = done;
        }),
    );
    const pending = r.audio.tick(3);
    r.audio.cancel();
    resume();
    await pending;
    expect(r.context.createOscillator).not.toHaveBeenCalled();
    r.audio.close();
    expect(r.context.close).toHaveBeenCalledTimes(1);
  });
});
