import { describe, expect, it } from 'vitest';
import { defaultOptions, recordingStartArguments } from './contracts';
import { captureIntent, captureIntentOptions, recordingReadiness } from './recording-setup';

const granted = { screen: 'granted', camera: 'granted', microphone: 'granted' };

describe('recording setup choices', () => {
  it('maps three visible modes to native inputs, preserving the selected screen and camera', () => {
    const selected = {
      ...defaultOptions,
      mode: 'window' as const,
      source: 'window-42',
      camera: 'usb-camera',
      mic: 'mic-1',
      systemAudio: true,
    };
    const camera = captureIntentOptions(selected, 'camera', 'usb-camera');
    expect(captureIntent(camera)).toBe('camera');
    expect(recordingStartArguments(camera)).not.toHaveProperty('display');
    expect(camera.systemAudio).toBe(false);
    const screen = captureIntentOptions(camera, 'screen', 'usb-camera', selected);
    expect(screen).toMatchObject({
      mode: 'window',
      source: 'window-42',
      camera: 'none',
      mic: 'mic-1',
    });
    expect(captureIntent(screen)).toBe('screen');
    const both = captureIntentOptions(screen, 'screen-camera', 'usb-camera');
    expect(both).toMatchObject({ mode: 'window', source: 'window-42', camera: 'usb-camera' });
    expect(captureIntent(both)).toBe('screen-camera');
  });
  it('restores only screen selection without reviving earlier sharing or device settings', () => {
    const earlier = {
      ...defaultOptions,
      mode: 'window' as const,
      source: 'window-42',
      autoShare: true,
      mic: 'old-mic',
      countdownSeconds: 5 as const,
    };
    const current = {
      ...defaultOptions,
      mode: 'camera-only' as const,
      autoShare: false,
      mic: 'new-mic',
      countdownSeconds: 0 as const,
    };
    const restored = captureIntentOptions(current, 'screen', 'camera', earlier);
    expect(restored).toMatchObject({
      mode: 'window',
      source: 'window-42',
      autoShare: false,
      mic: 'new-mic',
      countdownSeconds: 0,
    });
  });
  it('requires only permissions for enabled inputs and explains missing selections', () => {
    const camera = { ...defaultOptions, mode: 'camera-only' as const, camera: 'usb-camera' };
    expect(
      recordingReadiness(camera, { camera: 'granted' }, 'idle').blockingReason,
    ).toBeUndefined();
    expect(
      recordingReadiness({ ...camera, camera: 'none' }, granted, 'idle').blockingReason,
    ).toContain('Choose a camera');
    expect(recordingReadiness(defaultOptions, {}, 'idle').blockingReason).toContain('Allow screen');
    expect(
      recordingReadiness({ ...camera, mic: 'mic' }, { camera: 'granted' }, 'idle').blockingReason,
    ).toContain('Allow microphone');
    expect(
      recordingReadiness({ ...defaultOptions, mode: 'area' }, granted, 'idle').blockingReason,
    ).toContain('Select the area');
    expect(
      recordingReadiness({ ...defaultOptions, mode: 'window', source: '' }, granted, 'idle')
        .blockingReason,
    ).toContain('Choose the window');
    expect(recordingReadiness(defaultOptions, granted, 'offline').blockingReason).toContain(
      'Reconnect',
    );
  });
  it('describes only originals actually enabled, with an explicit voice-off warning', () => {
    expect(recordingReadiness(defaultOptions, granted, 'idle')).toMatchObject({
      tracks: ['Screen'],
      voiceOff: true,
    });
    expect(
      recordingReadiness(
        { ...defaultOptions, camera: 'cam', mic: 'mic', systemAudio: true },
        granted,
        'idle',
      ),
    ).toMatchObject({
      tracks: ['Screen', 'Camera', 'Microphone', 'System audio'],
      voiceOff: false,
    });
  });
});
