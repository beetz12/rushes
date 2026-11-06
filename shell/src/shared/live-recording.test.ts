import { describe, expect, it } from 'vitest';
import { defaultOptions, recordingOptionsSchema, recordingStartArguments } from './contracts';
import {
  bubbleSizeLabel,
  levelFraction,
  liveWarningText,
  nextBubbleSize,
  timeLimitIsNear,
  timeLimitRemainingMs,
} from './live-recording';

describe('live recording bar helpers', () => {
  it('cycles the live bubble through the three supported sizes', () => {
    expect(nextBubbleSize(160)).toBe(200);
    expect(nextBubbleSize(200)).toBe(280);
    expect(nextBubbleSize(280)).toBe(160);
    expect(nextBubbleSize(123)).toBe(160);
    expect([160, 200, 280].map(bubbleSizeLabel)).toEqual(['S', 'M', 'L']);
  });

  it('turns engine warnings into short plain text and keeps unknown messages readable', () => {
    expect(liveWarningText('mic-silent', 'microphone has been near digital silence')).toBe(
      'Mic is silent — check your microphone',
    );
    expect(liveWarningText('camera-lost')).toBe('Camera disconnected');
    expect(liveWarningText(undefined, 'Error: short problem')).toBe('short problem');
    const long = liveWarningText('codec-fallback', 'x'.repeat(200));
    expect(long.length).toBe(48);
    expect(long.endsWith('…')).toBe(true);
    expect(liveWarningText()).toBe('Recording warning');
  });

  it('reports remaining time against recorded media and warns near the end', () => {
    expect(timeLimitRemainingMs(0, 10_000)).toBeUndefined();
    expect(timeLimitRemainingMs(5, 60_000)).toBe(240_000);
    expect(timeLimitRemainingMs(5, 400_000)).toBe(0);
    expect(timeLimitIsNear(5, 3 * 60_000)).toBe(false);
    expect(timeLimitIsNear(5, 4 * 60_000 + 1)).toBe(true);
    expect(timeLimitIsNear(60, 58 * 60_000)).toBe(false);
    expect(timeLimitIsNear(60, 59 * 60_000)).toBe(true);
    expect(timeLimitIsNear(0, 10 ** 9)).toBe(false);
  });
});

describe('recording time limit option', () => {
  it('defaults to no limit for saved options written before the setting existed', () => {
    const { timeLimitMinutes, ...legacy } = defaultOptions;
    expect(timeLimitMinutes).toBe(0);
    expect(recordingOptionsSchema.parse(legacy).timeLimitMinutes).toBe(0);
    expect(recordingStartArguments(defaultOptions)).not.toHaveProperty('duration');
  });

  it('sends the limit to the engine as a media duration in seconds', () => {
    expect(recordingStartArguments({ ...defaultOptions, timeLimitMinutes: 15 })).toMatchObject({
      duration: 900,
      display: 'main',
    });
    expect(
      recordingStartArguments({
        ...defaultOptions,
        mode: 'camera-only',
        camera: 'cam',
        timeLimitMinutes: 5,
      }),
    ).toMatchObject({ duration: 300 });
  });

  it('rejects limits the settings menu does not offer', () => {
    expect(() =>
      recordingOptionsSchema.parse({ ...defaultOptions, timeLimitMinutes: 7 }),
    ).toThrow();
  });
});

describe('recording quality option', () => {
  it('sends a cap only for a lower quality and only for screen takes', () => {
    expect(recordingStartArguments(defaultOptions)).not.toHaveProperty('quality');
    expect(recordingStartArguments({ ...defaultOptions, quality: '4k' })).not.toHaveProperty(
      'quality',
    );
    expect(recordingStartArguments({ ...defaultOptions, quality: '1080p' })).toMatchObject({
      quality: '1080p',
    });
    expect(
      recordingStartArguments({
        ...defaultOptions,
        mode: 'camera-only',
        camera: 'cam',
        quality: '720p',
      }),
    ).not.toHaveProperty('quality');
    expect(() => recordingOptionsSchema.parse({ ...defaultOptions, quality: '8k' })).toThrow();
  });
});

describe('live level meter', () => {
  it('maps RMS onto a 60 dB scale and treats missing or silent input as empty', () => {
    expect(levelFraction(undefined)).toBe(0);
    expect(levelFraction(0)).toBe(0);
    expect(levelFraction(Number.NaN)).toBe(0);
    expect(levelFraction(1e-6)).toBe(0);
    expect(levelFraction(1)).toBe(1);
    expect(levelFraction(0.0316)).toBeCloseTo(0.5, 2);
  });
});
