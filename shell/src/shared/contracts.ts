import { z } from 'zod';
import type { OnboardingAction, OnboardingRecord } from './onboarding';
import type { PrimaryView } from './navigation';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const commands = [
  'ping',
  'version',
  'guide',
  'status',
  'targets',
  'record.start',
  'record.stop',
  'record.pause',
  'record.resume',
  'record.restart',
  'record.discard',
  'record.cancel',
  'record.mute',
  'record.bubble',
  'record.geometry',
  'permissions.check',
  'permissions.request',
  'permissions.settings',
  'camera.preview.start',
  'camera.preview.stop',
  'camera.preview.subscribe',
  'capture.preflight.start',
  'capture.preflight.stop',
  'capture.preflight.snapshot',
  'list',
  'show',
  'verify',
  'layout.frames',
  'edit.get',
  'edit.set',
  'edit.cut',
  'edit.split',
  'edit.undo',
  'edit.redo',
  'edit.save',
  'edit.discard',
  'export',
  'thumbnail',
  'transcript.get',
  'transcript.run',
  'transcript.edit-plan',
  'transcript.correct',
  'meta.get',
  'chapters.export',
  'captions.export',
  'meta.generate',
  'meta.set',
  'diagnostics',
  'teleprompter.set',
  'teleprompter.get',
  'camera.blur.set',
  'camera.blur.get',
  'mcp.enable',
  'mcp.disable',
  'mcp.status',
  'url.open',
  'library.refresh',
  'library.trash',
  'library.undoTrash',
  'jobs.list',
  'jobs.retry',
  'jobs.cancel',
  'teleprompter.start',
  'teleprompter.stop',
] as const;
export const requestSchema = z
  .object({ cmd: z.enum(commands), args: z.record(z.string(), z.json()).default({}) })
  .strict();
export const windowSchema = z
  .object({
    action: z.enum([
      'library',
      'settings',
      'recorder',
      'review',
      'editor',
      'close',
      'minimize',
      'maximize',
      'window-state',
      'area',
      'drawing',
      'drawing-hide',
      'teleprompter',
      'cancel-area',
      'bubble-size',
      'move-bubble',
      'hide-bubble',
      'relaunch',
      'acknowledgements',
      'quit',
    ]),
    value: z.number().finite().optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
  })
  .strict();
const anchorSchema = z.object({
  displayId: z.number().int(),
  horizontal: z.enum(['left', 'right']),
  vertical: z.enum(['top', 'bottom']),
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
});
export const countdownSecondsSchema = z.union([z.literal(0), z.literal(3), z.literal(5)]);
export type CountdownSeconds = z.infer<typeof countdownSecondsSchema>;
export const countdownChoices: ReadonlyArray<{ seconds: CountdownSeconds; label: string }> = [
  { seconds: 0, label: 'None' },
  { seconds: 3, label: '3 seconds' },
  { seconds: 5, label: '5 seconds' },
];
export function countdownFromSelection(value: string): CountdownSeconds | undefined {
  const selection = z.enum(['0', '3', '5']).safeParse(value);
  if (!selection.success) return;
  return countdownSecondsSchema.parse(Number(selection.data));
}
export const recordingOptionsSchema = z.object({
  mode: z.enum(['display', 'window', 'area', 'camera-only']),
  source: z.string().max(300),
  camera: z.string().max(300),
  mic: z.string().max(300),
  systemAudio: z.boolean(),
  autoShare: z.boolean().default(false),
  editorCommandTemplate: z.string().max(10000).default(''),
  countdownSeconds: countdownSecondsSchema,
  bubbleSize: z.union([z.literal(160), z.literal(200), z.literal(280)]),
  cursor: z.enum(['baked', 'data']).optional(),
  bubbleAnchor: anchorSchema.optional(),
  barAnchor: anchorSchema.optional(),
  area: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .optional(),
});
export type RecordingOptions = z.infer<typeof recordingOptionsSchema>;
export const defaultOptions: RecordingOptions = {
  mode: 'display',
  source: 'main',
  camera: 'none',
  mic: 'none',
  systemAudio: false,
  autoShare: false,
  editorCommandTemplate: '',
  countdownSeconds: 3,
  bubbleSize: 200,
};
// The native engine represents camera-only with an absent screen target.
export function recordingStartArguments(raw: RecordingOptions): Record<string, unknown> {
  const options = recordingOptionsSchema.parse(raw);
  if (options.mode === 'camera-only' && options.camera === 'none')
    throw new Error('Choose a camera for a camera-only recording.');
  const args: Record<string, unknown> = {
    camera: options.camera,
    mic: options.mic,
    systemAudio: options.mode === 'camera-only' ? false : options.systemAudio,
    countdownSeconds: options.countdownSeconds,
  };
  if (options.mode === 'camera-only') return args;
  args.cursor = options.cursor ?? 'baked';
  if (options.mode === 'window') {
    if (!options.source) throw new Error('Choose a window to record.');
    args.window = options.source;
  } else args.display = options.source;
  if (options.mode === 'area') {
    if (!options.area) throw new Error('Select a recording area first.');
    args.area = options.area;
  }
  return args;
}
export const exportPresetSchema = z.enum([
  'share',
  'full',
  'youtube',
  'youtube-source',
  'audio',
  'audio-wav',
  'editor-tracks',
  'srt',
  'vtt',
  'txt',
  'thumbnail',
  'diagnostics',
  'chapters',
]);
export type ExportPreset = z.infer<typeof exportPresetSchema>;
export type ExportOutput = 'combined' | 'separate';
export function selectedExportPreset(output: ExportOutput, format: ExportPreset): ExportPreset {
  return output === 'separate' ? 'editor-tracks' : format;
}
export const cloudSettingsSchema = z.discriminatedUnion('provider', [
  z.object({provider: z.literal('hosted'), serviceURL: z.url()}),
  z.object({ provider: z.literal('none') }),
  z.object({
    provider: z.literal('bucket'),
    endpoint: z.url(),
    region: z.string().min(1),
    bucket: z.string().min(1),
    publicBaseURL: z.url(),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    sessionToken: z.string().optional(),
  }),
  z.object({
    provider: z.literal('worker'),
    workerURL: z.url(),
    token: z.string().min(1),
    accountId: z.string().min(1).optional(),
  }),
]);
export type CloudSettings = z.infer<typeof cloudSettingsSchema>;
export const shareCommands = [
  'share',
  'share.setup',
  'unshare',
  'share.enrich',
  'share.configure',
  'share.configuration',
  'share.status',
  'share.policy.get',
  'share.policy.set',
  'share.feedback',
] as const;
export type ShareCommand = (typeof shareCommands)[number];
export const sharePolicySchema = z.object({
  protected: z.boolean(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
});
export const sharePolicyPatchSchema = z
  .object({
    password: z.string().min(8).max(1024).nullable().optional(),
    expiresAt: z.iso
      .datetime({ offset: true })
      .refine((value) => Date.parse(value) > Date.now(), 'Expiry must be in the future')
      .nullable()
      .optional(),
  })
  .strict();
export const shareFeedbackSchema = z.object({
  views: z.number().int().nonnegative(),
  comments: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      body: z.string(),
      timestampMs: z.number().nonnegative(),
      createdAt: z.string(),
    }),
  ),
  reactions: z.array(
    z.object({
      kind: z.enum(['like', 'love', 'celebrate']),
      count: z.number().int().nonnegative(),
    }),
  ),
});
export type SharePolicy = z.infer<typeof sharePolicySchema>;
export type SharePolicyPatch = z.infer<typeof sharePolicyPatchSchema>;
export type ShareFeedback = z.infer<typeof shareFeedbackSchema>;
export type ShareStatus = {
  id: string;
  state: 'not-shared' | 'processing' | 'ready' | 'failed' | 'unshared';
  url?: string;
  providerMatches?: boolean;
};
export type EngineEvent = { event: string; [key: string]: unknown };
export const preflightAcknowledgmentSchema = z.object({
  previewToken: z.uuid(),
  selectionToken: z.uuid(),
  selectionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  microphone: z.string().max(300).nullable(),
  source: z.string().max(300).nullable(),
});
export type PreflightAcknowledgment = z.infer<typeof preflightAcknowledgmentSchema>;
const levelIdentity = {
  previewToken: z.uuid(),
  microphone: z.string().min(1).max(300),
  measuredAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
export const microphoneLevelSchema = z.discriminatedUnion('available', [
  z.object({
    ...levelIdentity,
    available: z.literal(true),
    rms: z.number().finite().nonnegative(),
    peak: z.number().finite().nonnegative(),
    clipping: z.boolean(),
    frames: z.number().int().positive().max(1_000_000),
  }),
  z.object({ ...levelIdentity, available: z.literal(false) }),
]);
export type MicrophoneLevel = z.infer<typeof microphoneLevelSchema>;
export const screenPreviewSchema = z.object({
  previewToken: z.uuid(),
  source: z.string().min(1).max(300),
  jpeg: z
    .string()
    .min(4)
    .max(349_528)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .refine((value) => value.length % 4 === 0),
  mime: z.literal('image/jpeg'),
  width: z.number().int().positive().max(640),
  height: z.number().int().positive().max(640),
});
export type ScreenPreview = z.infer<typeof screenPreviewSchema>;
export function preflightArguments(
  options: RecordingOptions,
  selectionToken: string,
  selectionRevision: number,
) {
  z.uuid().parse(selectionToken);
  return {
    selectionToken,
    selectionRevision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(selectionRevision),
    ...preflightInputs(options),
  };
}
export function preflightInputs(options: RecordingOptions) {
  const value: Record<string, unknown> = { mic: options.mic };
  if (options.mode === 'camera-only') return value;
  if (options.mode === 'window') value.window = options.source;
  else if (options.mode !== 'area' || options.area) {
    value.display = options.source;
    if (options.mode === 'area') value.area = options.area;
  }
  return value;
}
export const previewAcknowledgmentSchema = z.object({ previewToken: z.string().min(1).max(200) });
export type PreviewAcknowledgment = z.infer<typeof previewAcknowledgmentSchema>;
export function previewAcknowledgment(raw: unknown): PreviewAcknowledgment {
  const value = previewAcknowledgmentSchema.safeParse(raw);
  if (!value.success)
    throw Object.assign(
      new Error(
        'Camera preview could not be confirmed. Reopen Rushes to reconnect to its native engine.',
      ),
      { code: 'preview-token-invalid' },
    );
  return value.data;
}
export type AppUpdateStatus = {status: 'disabled' | 'idle' | 'checking' | 'downloading' | 'downloaded' | 'restarting' | 'error'; version?: string; transferred?: number; total?: number; deferred?: boolean; nativeHoldPending?: boolean; reason?: 'development' | 'unavailable' | 'failed'};
export interface RushesAPI {
  openRecording(id: string): Promise<void>;
  restorePrimaryView(view: PrimaryView): Promise<void>;
  draftFlushed(token: string, error?: string): Promise<void>;
  onboarding(action: OnboardingAction): Promise<OnboardingRecord>;
  request(cmd: string, args?: Record<string, unknown>): Promise<any>;
  bootstrap(): Promise<{
    options: RecordingOptions;
    enginePath: string;
    packaged: boolean;
    primaryView?: string;
    reviewId?: string;
    inputPreflight?: PreflightAcknowledgment;
  }>;
  saveOptions(options: RecordingOptions): Promise<void>;
  presets(
    action: 'list' | 'save' | 'delete',
    name?: string,
    options?: RecordingOptions,
  ): Promise<Record<string, RecordingOptions>>;
  onEvent(listener: (event: EngineEvent) => void): () => void;
  window(action: string, value?: number, x?: number, y?: number): Promise<any>;
  exportFile(id: string, preset: string, atMs?: number): Promise<any>;
  openEditor(
    id: string,
  ): Promise<{ canceled?: boolean; revealed?: boolean; started?: boolean; path?: string }>;
  previewFile(id: string): Promise<{ url: string; path: string; durationMs: number }>;
  copyVideoFile(id: string): Promise<{ copied: boolean }>;
  media(path: string): Promise<string>;
  selectArea(area: { x: number; y: number; width: number; height: number }): Promise<void>;
  reveal(path: string): Promise<void>;
  confirm(message: string): Promise<boolean>;
  cloudSettings(): Promise<{
    provider: string;
    configured: boolean;
    encrypted: boolean;
    publicBaseURL?: string;
    workerURL?: string;
    serviceURL?: string;
  }>;
  hostedAccount(input: {action: 'status' | 'cancel' | 'disconnect'} | {action: 'connect'; serviceURL: string}): Promise<{connected: boolean; pending: boolean; saving: boolean; serviceURL?: string; email?: string; name?: string; expiresAt?: string; error?: string}>;
  saveCloudSettings(settings: CloudSettings): Promise<void>;
  testCloud(): Promise<any>;
  updates(action: 'status' | 'check' | 'restart' | 'recover'): Promise<AppUpdateStatus>;
  share(id: string, policy?: SharePolicyPatch): Promise<{ url: string; state?: string }>;
  shareStatus(id: string): Promise<ShareStatus>;
  getSharePolicy(id: string): Promise<SharePolicy>;
  setSharePolicy(id: string, policy: SharePolicyPatch): Promise<SharePolicy>;
  shareFeedback(id: string): Promise<ShareFeedback>;
  copyLink(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  drawing(
    action: 'tool' | 'undo' | 'clear' | 'pause',
    options?: { tool?: string; color?: string; paused?: boolean },
  ): Promise<void>;
}
declare global {
  interface Window {
    rushes: RushesAPI;
  }
}
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
