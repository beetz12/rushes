import { z } from 'zod';

// Guided sharing setup: shared between the main process and the renderer wizard.
export const CLOUDFLARE_TOKEN_PAGE = 'https://dash.cloudflare.com/profile/api-tokens';
export const CLOUDFLARE_R2_PAGE = 'https://dash.cloudflare.com/?to=/:account/r2/overview';
export const REQUIRED_TOKEN_PERMISSIONS = [
  'Account → Workers Scripts → Edit',
  'Account → Workers R2 Storage → Edit',
  'Account → D1 → Edit',
  'Account → Account Settings → Read',
] as const;
export const SHARE_SETUP_NAMES = {
  workerName: 'rushes-share',
  bucketName: 'rushes-media',
  databaseName: 'rushes-share',
} as const;

const resourceName = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
export const shareSetupTokenSchema = z
  .string()
  .trim()
  .min(20, 'Paste the whole Cloudflare API token.')
  .max(512)
  .regex(/^[\x21-\x7e]+$/, 'Paste the token only, without spaces.');
export const shareSetupAccountsInputSchema = z.object({ token: shareSetupTokenSchema });
export const shareSetupRunInputSchema = z.object({
  token: shareSetupTokenSchema,
  accountId: z.string().regex(/^[a-f0-9]{32}$/, 'Choose a Cloudflare account.'),
  subdomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(resourceName, 'Use 3 to 63 lowercase letters, numbers or dashes.')
    .optional(),
});
export type ShareSetupRunInput = z.infer<typeof shareSetupRunInputSchema>;

export interface CloudflareAccount {
  id: string;
  name: string;
  /** The account's existing workers.dev subdomain, or null when it has none yet. */
  subdomain: string | null;
}
export const shareSetupSteps = [
  'check',
  'storage',
  'database',
  'upload',
  'publish',
  'health',
  'save',
  'test',
] as const;
export type ShareSetupStep = (typeof shareSetupSteps)[number];
export const shareSetupStepLabels: Record<ShareSetupStep, string> = {
  check: 'Check the account',
  storage: 'Create video storage (R2)',
  database: 'Create the database (D1)',
  upload: 'Upload the share Worker',
  publish: 'Turn on the public address',
  health: 'Wait for the Worker to answer',
  save: 'Save settings securely',
  test: 'Test the connection',
};
export type ShareSetupProgress = {
  event: 'share-setup-progress';
  step: ShareSetupStep;
  status: 'active' | 'done';
};
export interface ShareSetupResult {
  workerURL: string;
  accountId: string;
  subdomain: string;
  verified: boolean;
}
