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
): { blockingReason?: string; tracks: string[]; voiceOff: boolean } {
  const screen = options.mode !== 'camera-only';
  const tracks = [
    ...(screen ? ['Screen'] : []),
    ...(options.camera !== 'none' ? ['Camera'] : []),
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
    blockingReason = 'Allow screen recording to continue.';
  else if (options.camera !== 'none' && permissions.camera !== 'granted')
    blockingReason = 'Allow camera access to continue.';
  else if (options.mic !== 'none' && permissions.microphone !== 'granted')
    blockingReason = 'Allow microphone access to continue.';
  else if (options.mode === 'window' && !options.source)
    blockingReason = 'Choose the window you want to record.';
  else if (options.mode === 'area' && !options.area)
    blockingReason = 'Select the area you want to record.';
  return { blockingReason, tracks, voiceOff: options.mic === 'none' };
}
