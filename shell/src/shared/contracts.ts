import { z } from 'zod';
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
      'close',
      'area',
      'drawing',
      'drawing-hide',
      'teleprompter',
      'cancel-area',
      'bubble-size',
      'move-bubble',
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
  mode: z.enum(['display', 'window', 'area']),
  source: z.string().max(300),
  camera: z.string().max(300),
  mic: z.string().max(300),
  systemAudio: z.boolean(),
  autoShare: z.boolean().default(false),
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
  countdownSeconds: 3,
  bubbleSize: 200,
};
export const cloudSettingsSchema = z.discriminatedUnion('provider', [
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
export interface RushesAPI {
  request(cmd: string, args?: Record<string, unknown>): Promise<any>;
  bootstrap(): Promise<{ options: RecordingOptions; enginePath: string; packaged: boolean }>;
  saveOptions(options: RecordingOptions): Promise<void>;
  presets(
    action: 'list' | 'save' | 'delete',
    name?: string,
    options?: RecordingOptions,
  ): Promise<Record<string, RecordingOptions>>;
  onEvent(listener: (event: EngineEvent) => void): () => void;
  window(action: string, value?: number, x?: number, y?: number): Promise<any>;
  exportFile(id: string, preset: string, atMs?: number): Promise<any>;
  previewFile(id: string): Promise<{ url: string; path: string; durationMs: number }>;
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
  }>;
  saveCloudSettings(settings: CloudSettings): Promise<void>;
  testCloud(): Promise<any>;
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
