import { describe, expect, it } from 'vitest';
import { defaultOptions, recordingStartArguments } from './contracts';
import {
  captureIntent,
  captureIntentOptions,
  permissionGate,
  recordingReadiness,
} from './recording-setup';

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
  it('records the screen alone when camera access is missing instead of blocking', () => {
    const withCamera = { ...defaultOptions, camera: 'cam' };
    for (const camera of ['not-determined', 'denied', undefined]) {
      const readiness = recordingReadiness(withCamera, { ...granted, camera } as any, 'idle');
      expect(readiness.blockingReason).toBeUndefined();
      expect(readiness.cameraSkipped).toBe(true);
      expect(readiness.tracks).toEqual(['Screen']);
      expect(readiness.notice).toContain('camera is left out');
    }
    expect(
      recordingReadiness(withCamera, { ...granted, camera: 'granted' }, 'idle').cameraSkipped,
    ).toBe(false);
    const cameraOnly = { ...withCamera, mode: 'camera-only' as const };
    expect(recordingReadiness(cameraOnly, { ...granted, camera: 'denied' }, 'idle')).toMatchObject({
      blockingReason: 'Allow camera access to continue.',
      cameraSkipped: false,
    });
  });
  it('records the camera alone when screen access is missing', () => {
    const withCamera = { ...defaultOptions, camera: 'cam' };
    const readiness = recordingReadiness(withCamera, { ...granted, screen: 'denied' }, 'idle');
    expect(readiness).toMatchObject({
      screenSkipped: true,
      cameraSkipped: false,
      tracks: ['Camera'],
    });
    expect(readiness.blockingReason).toBeUndefined();
    expect(readiness.notice).toContain('screen is left out');
    expect(
      recordingReadiness(withCamera, { microphone: 'granted' }, 'idle').blockingReason,
    ).toContain('screen recording or camera');
    expect(
      recordingReadiness(defaultOptions, { camera: 'granted' }, 'idle').blockingReason,
    ).toContain('or choose a camera');
  });
  it('lets Rushes continue when either screen or camera access exists', () => {
    expect(permissionGate({})).toEqual({
      canRecord: false,
      missing: ['screen', 'camera', 'microphone'],
    });
    expect(permissionGate({ camera: 'granted' })).toEqual({
      canRecord: true,
      missing: ['screen', 'microphone'],
    });
    expect(permissionGate(granted)).toEqual({ canRecord: true, missing: [] });
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
