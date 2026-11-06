import { describe, expect, it, vi } from 'vitest';
import { RecordingDefaults } from './recording-controls';

describe('recorder-level edit defaults after stop', () => {
  it('makes review and sharing wait until the default is applied', async () => {
    let release!: () => void;
    const apply = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const defaults = new RecordingDefaults(apply, vi.fn());
    void defaults.stopped('take-1', true);
    let shared = false;
    const share = defaults.ready('take-1').then(() => (shared = true));
    await Promise.resolve();
    expect(apply).toHaveBeenCalledWith('take-1');
    expect(shared).toBe(false);
    release();
    await share;
    expect(shared).toBe(true);
  });

  it('does nothing when the setting is off and never blocks on a failure', async () => {
    const apply = vi.fn(() => Promise.reject(new Error('engine busy')));
    const warn = vi.fn();
    const defaults = new RecordingDefaults(apply, warn);
    await defaults.stopped('off', false);
    expect(apply).not.toHaveBeenCalled();
    await expect(defaults.stopped('fails', true)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Error: engine busy');
    await expect(defaults.ready('fails')).resolves.toBeUndefined();
    await expect(defaults.ready('unknown')).resolves.toBeUndefined();
  });
});
