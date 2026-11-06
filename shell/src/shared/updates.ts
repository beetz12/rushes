import { z } from 'zod';

// Settings > Updates talks to the main process with these actions only.
export const updateActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get') }).strict(),
  z.object({ action: z.literal('check') }).strict(),
  z.object({ action: z.literal('set-automatic'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('open-release') }).strict(),
]);
export type UpdateAction = z.infer<typeof updateActionSchema>;

export interface UpdateRelease {
  version: string;
  pageURL: string;
  assetURL?: string;
  prerelease: boolean;
}

export type UpdateResult =
  | { state: 'up-to-date'; checkedAt: number }
  | { state: 'available'; checkedAt: number; release: UpdateRelease }
  | { state: 'error'; checkedAt: number; message: string };

export interface UpdateStatus {
  automatic: boolean;
  current: string;
  channel?: 'stable' | 'preview';
  checking: boolean;
  last?: UpdateResult;
}

export function describeUpdateResult(result: UpdateResult | undefined): string {
  if (!result) return '';
  if (result.state === 'up-to-date') return "You're up to date.";
  if (result.state === 'available') return `Version ${result.release.version} is available.`;
  return "Couldn't check for updates. Try again later.";
}
