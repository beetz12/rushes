import { describe, expect, it } from 'vitest';
import { createNativeAPI } from './native-api';
import { unwrapNativeResponse } from '../shared/native-result';

describe('native bridge data errors', () => {
  it('rejects a raw window-smoke failure instead of accepting an error as a value', () => {
    expect(() =>
      unwrapNativeResponse({
        __rushesError: { code: 'camera-unavailable', message: 'camera startup failed' },
      }),
    ).toThrow('camera startup failed');
  });
  it('reconstructs cancellation and connection codes after the bridge copies plain data', async () => {
    for (const code of ['cancelled', 'engine-disconnected', 'status-superseded']) {
      const bridge = Object.freeze({
        request: async () => ({ __rushesError: { code, message: 'native detail: ' + code } }),
      });
      const client = createNativeAPI(bridge);
      await expect(client.request()).rejects.toMatchObject({
        code,
        message: 'native detail: ' + code,
      });
    }
  });
  it('preserves successful values and synchronous event unsubscribe', async () => {
    let unsubscribed = false;
    const value = { state: 'idle' };
    const client = createNativeAPI({
      request: async () => value,
      saveOptions: async () => undefined,
      onEvent: () => () => {
        unsubscribed = true;
      },
    });
    expect(await client.request()).toBe(value);
    expect(await client.saveOptions()).toBeUndefined();
    const off = client.onEvent();
    expect(typeof off).toBe('function');
    off();
    expect(unsubscribed).toBe(true);
  });
  it('does not mistake a user preset named __rushesError for a failure', () => {
    const presets = { __rushesError: { camera: 'none', mic: 'none' } };
    expect(unwrapNativeResponse(presets)).toBe(presets);
  });
});
