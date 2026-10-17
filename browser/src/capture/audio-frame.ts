// Chromium's audio transform API is not yet declared in TypeScript's DOM library.
export type PCMFrame = {
  readonly timestamp: number; readonly sampleRate: number; readonly numberOfChannels: number; readonly numberOfFrames: number;
  copyTo(destination: Float32Array, options: { planeIndex: number; format: 'f32-planar' }): void; close(): void;
};
export type AudioTransformAPIs = {
  AudioData: new (options: { format: 'f32-planar'; sampleRate: number; numberOfChannels: number; numberOfFrames: number; timestamp: number; data: Float32Array }) => PCMFrame;
  MediaStreamTrackProcessor: new (options: { track: MediaStreamTrack; maxBufferSize: number }) => { readable: ReadableStream<PCMFrame> };
  MediaStreamTrackGenerator: new (options: { kind: 'audio' }) => MediaStreamTrack & { writable: WritableStream<PCMFrame> };
};
