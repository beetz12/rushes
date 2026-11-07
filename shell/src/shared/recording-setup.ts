import type { RecordingOptions } from './contracts';

export type CaptureIntent = 'screen-camera' | 'screen' | 'camera';
export type ScreenSelection = Pick<RecordingOptions, 'mode' | 'source' | 'area'>;

export function captureIntent(options: RecordingOptions): CaptureIntent {
  return options.mode === 'camera-only'
    ? 'camera'
    : options.camera === 'none'
      ? 'screen'
      : 'screen-camera';
}

export function captureIntentOptions(
  options: RecordingOptions,
  intent: CaptureIntent,
  camera: string,
  previousScreen?: ScreenSelection,
): RecordingOptions {
  const screen =
    options.mode === 'camera-only'
      ? (previousScreen ?? { mode: 'display' as const, source: 'main', area: undefined })
      : { mode: options.mode, source: options.source, area: options.area };
  return {
    ...options,
    source: screen.source,
    area: screen.area,
    mode: intent === 'camera' ? 'camera-only' : screen.mode,
    camera: intent === 'screen' ? 'none' : camera,
    systemAudio: intent === 'camera' ? false : options.systemAudio,
  };
}

export function recordingReadiness(
  options: RecordingOptions,
  permissions: Record<string, string>,
  engineState: string,
): {
  blockingReason?: string;
  tracks: string[];
  voiceOff: boolean;
  cameraSkipped: boolean;
  screenSkipped: boolean;
  notice?: string;
} {
  const wantsScreen = options.mode !== 'camera-only';
  // One missing permission never blocks the other input: without screen access a
  // chosen, allowed camera records alone, and without camera access the screen does.
  const screenSkipped =
    wantsScreen &&
    permissions.screen !== 'granted' &&
    options.camera !== 'none' &&
    permissions.camera === 'granted';
  const screen = wantsScreen && !screenSkipped;
  const cameraSkipped = screen && options.camera !== 'none' && permissions.camera !== 'granted';
  const tracks = [
    ...(screen ? ['Screen'] : []),
    ...(options.camera !== 'none' && !cameraSkipped ? ['Camera'] : []),
    ...(options.mic !== 'none' ? ['Microphone'] : []),
    ...(screen && options.systemAudio ? ['System audio'] : []),
  ];
  let blockingReason: string | undefined;
  if (engineState === 'loading' || engineState === 'offline')
    blockingReason =
      engineState === 'loading'
        ? 'Connecting to the recorder…'
        : 'Reconnect the recording engine to continue.';
  else if (!screen && options.camera === 'none')
    blockingReason = 'Choose a camera for a camera-only recording.';
  else if (screen && permissions.screen !== 'granted')
    blockingReason =
      options.camera === 'none'
        ? 'Allow screen recording to continue, or choose a camera.'
        : 'Allow screen recording or camera access to record.';
  else if (!screen && permissions.camera !== 'granted')
    blockingReason = 'Allow camera access to continue.';
  else if (options.mic !== 'none' && permissions.microphone !== 'granted')
    blockingReason = 'Allow microphone access to continue.';
  else if (options.mode === 'window' && !options.source)
    blockingReason = 'Choose the window you want to record.';
  else if (options.mode === 'area' && !options.area)
    blockingReason = 'Select the area you want to record.';
  return {
    blockingReason,
    tracks,
    voiceOff: options.mic === 'none',
    cameraSkipped,
    screenSkipped,
    notice: screenSkipped
      ? 'Ready to record your camera. Screen recording access is off, so the screen is left out.'
      : cameraSkipped
        ? 'Ready to record your screen. Camera access is off, so the camera is left out.'
        : undefined,
  };
}

export type AccessKind = 'screen' | 'camera' | 'microphone';
/** Whether Rushes can record at all, and which inputs still need access. */
export function permissionGate(permissions: Record<string, string | undefined>): {
  canRecord: boolean;
  missing: AccessKind[];
} {
  const kinds: AccessKind[] = ['screen', 'camera', 'microphone'];
  return {
    canRecord: permissions.screen === 'granted' || permissions.camera === 'granted',
    missing: kinds.filter((kind) => permissions[kind] !== 'granted'),
  };
}
