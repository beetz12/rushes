// Browser-safe contracts for the separate Rushes commercial service.
export const BROWSER_LIMITS = {
  maxTakeSeconds: 600, width: 1280, height: 720, fps: 30,
  monthlyUploadSeconds: 6000, retainedSeconds: 18000, deliverySeconds: 60000,
  activeRawBytes: 2 * 1024 ** 3, rawRetentionDays: 7, monthlyPriceUSD: 15,
} as const;
export type CaptureMode = 'screen' | 'camera' | 'screen-camera';
export type TrackKind = 'screen' | 'camera' | 'microphone' | 'tab-audio' | 'composed';
// Composed 1280x720 pixels: top-left x/y and bubble diameter; clamp inside the frame.
export type BubblePlacement = { x: number; y: number; size: number };
export type CaptureState = 'ready' | 'recording' | 'paused' | 'stopping' | 'complete' | 'interrupted' | 'failed';
export type ChunkDescriptor = {
  track: TrackKind; sequence: number; bytes: number; sha256: string; mimeType: string;
  checkpointMs: number;
};
export type TrackManifest = {
  kind: TrackKind; mimeType: string; startOffsetMs: number; chunks: ChunkDescriptor[];
  // Legacy field name: startOffsetMs measures the DOM start-event callback after
  // epochMs. It is readiness telemetry, never a sample-alignment correction.
  // An absent basis in an older manifest means unknown, not a media origin.
  startOffsetTimeBasis?: 'media-recorder-start-event' | 'unknown';
  bytes: number;
};
export type DraftManifest = {
  schema: 'rushes.browser-recording/1'; id: string; title: string; createdAt: string;
  mode: CaptureMode; state: CaptureState; durationMs: number; epochMs: number;
  tracks: TrackManifest[]; pauses: { startMs: number; endMs: number }[];
  events: { timeMs: number; kind: string; message?: string }[];
  bubble: BubblePlacement; lastCheckpointMs: number; persistent: boolean;
  backupFolder: boolean; recoveryNote?: string; cloudRecordingId?: string;
  upload?: { url: string; uid: string; offset: number; expiresAt: string };
};
export type DraftSnapshot = {
  manifest: DraftManifest; tracks: Map<TrackKind, Blob>;
  read: { queueWaitMs: number; integrityMs: number; assemblyMs: number; chunks: number; bytes: number };
};
export type DraftStore = {
  create(manifest: DraftManifest): Promise<void>;
  save(manifest: DraftManifest): Promise<void>;
  load(id: string): Promise<DraftManifest>;
  list(): Promise<DraftManifest[]>;
  append(id: string, track: TrackKind, sequence: number, blob: Blob, checkpointMs: number): Promise<ChunkDescriptor>;
  readChunk(id: string, chunk: ChunkDescriptor): Promise<Blob>;
  trackBlob(id: string, track: TrackKind): Promise<Blob>;
  readSnapshot(id: string): Promise<DraftSnapshot>;
  remove(id: string): Promise<void>;
};
export type AudioFailureDetails = Readonly<{
  schema: 1; edge: 'before-wait' | 'timer' | 'late-wake' | 'other';
  input: readonly [number, number, number] | null;
  pending: readonly [number, number]; posted: readonly [number, number]; consumed: readonly [number, number];
  waitMs: number | null; messages: number;
  lastKind: 'consumed' | 'packet' | 'ready' | 'timing' | 'error' | 'stopped' | 'unknown' | null;
  lastAgeMs: number | null;
  output: readonly [number, number | null, number, number];
  writing: boolean; writeAgeMs: number | null; readied: boolean; quiesced: boolean; closed: boolean;
}>;
export type AudioTransportStatus = Omit<AudioFailureDetails, 'schema' | 'edge' | 'input' | 'waitMs'>;
export type EncoderStartFailureDetails = Readonly<{
  type: 'encoder-start'; schema: 1; role: TrackKind; atMs: number; elapsedMs: number; released: boolean;
  encoders: readonly (readonly [TrackKind, 'inactive' | 'recording' | 'paused', number, number, number, number, number, number])[];
  tracks: readonly (readonly [string, MediaStreamTrackState, boolean, boolean])[];
  audio: AudioTransportStatus | null;
}>;
export type WarningDetails = AudioFailureDetails | EncoderStartFailureDetails;
export type CaptureInputs = {
  id: string; title: string; mode: CaptureMode; screen?: MediaStream; camera?: MediaStream;
  microphone?: MediaStream; store: DraftStore; persistent: boolean; backupFolder: boolean;
  cloudRecordingId?: string;
  bubble?: BubblePlacement; onState?: (state: CaptureState) => void;
  onWarning?: (message: string, details?: WarningDetails) => void; onCheckpoint?: (manifest: DraftManifest) => void;
};
export type CaptureSession = {
  readonly preview: MediaStream;
  start(): Promise<void>; pause(): Promise<void>; resume(): Promise<void>;
  stop(): Promise<DraftManifest>; cancel(): Promise<void>; setBubble(value: BubblePlacement): void;
};
export type BrowserConfig = {
  revision: string; googleConfigured: boolean; billingConfigured: boolean; streamConfigured: boolean;
  billingMode: 'test' | 'live' | 'unconfigured';
  captureEnabled: boolean; hostingEnabled: boolean; signupEnabled: boolean;
  priceUSD: number; limits: typeof BROWSER_LIMITS;
};
export type Account = { id: string; email: string; name: string; tenantId: string };
export type SessionResponse = { user: Account | null; csrfToken: string | null };
export type Subscription = {
  status: 'none' | 'active' | 'past_due' | 'canceled' | 'suspended';
  paidThrough: string | null; graceThrough: string | null; canUpload: boolean;
};
export type Usage = {
  uploadSeconds: number; reservedSeconds: number; retainedSeconds: number;
  deliverySeconds: number; rawBytes: number; reservedRawBytes: number;
  periodStart: string; subscription: Subscription;
};
export type RecordingState = 'draft' | 'uploading' | 'processing' | 'ready' | 'failed' | 'deleting' | 'deleted';
export type RecordingSummary = {
  id: string; title: string; createdAt: string; mode: CaptureMode; state: RecordingState;
  durationMs: number; bytes: number; error: string | null;
  shareId: string | null; shareURL: string | null;
};
export type RecordingDetail = RecordingSummary & { manifest: DraftManifest | null; chunks: ChunkDescriptor[] };
export type ApiError = { error: { code: string; message: string } };
export type LibraryResponse = { recordings: RecordingSummary[]; usage: Usage; nextCursor?: string | null };
export type CreateRecordingInput = { clientId: string; title: string; mode: CaptureMode };
export type ChunkGrantInput = Omit<ChunkDescriptor, 'checkpointMs'>;
export type ChunkGrant = { url: string; token: string; expiresAt: string; acknowledged: boolean };
export type FinalizeInput = {
  manifest: DraftManifest; composed: { bytes: number; sha256: string; mimeType: string };
};
export type UploadGrant = { uid: string; url: string; expiresAt: string };
export type ShareInput = { password?: string; expiresAt?: string };
export type PlaybackGrant = { url: string; expiresAt: string };
export type ExportGrant = { status: 'processing' } | { status: 'ready'; url: string; expiresAt: string };
