import { z } from 'zod';
import { shareCommands, sharePolicyPatchSchema } from '../shared/contracts';
import type { SharingService } from './sharing';

export function createShareDispatcher(
  shares: SharingService,
  controls: {
    configuration(): Promise<unknown>;
    configure(value: unknown): Promise<unknown>;
    setup(): Promise<unknown>;
    copy(url: string): void | Promise<void>;
  },
) {
  return async (command: string, args: Record<string, unknown>) => {
    const parsed = z.enum(shareCommands).safeParse(command);
    if (!parsed.success)
      throw Object.assign(new Error('Unsupported sharing command'), { code: 'unknown-command' });
    const cmd = parsed.data;
    switch (cmd) {
      case 'share.configuration':
        return controls.configuration();
      case 'share.configure':
        return controls.configure(args);
      case 'share.setup':
        return controls.setup();
    }
    const id = z.string().min(1).max(200).parse(args.id);
    switch (cmd) {
      case 'share': {
        const wait = z.boolean().optional().parse(args.wait);
        const { id: _id, wait: _wait, ...values } = args;
        const policy = Object.keys(values).length
          ? sharePolicyPatchSchema.parse(values)
          : undefined;
        const result = await shares.share(id, wait === true, policy);
        await controls.copy(result.url);
        return result;
      }
      case 'share.status':
        return shares.status(id);
      case 'share.policy.get':
        return shares.getPolicy(id);
      case 'share.policy.set': {
        const { id: _id, ...policy } = args;
        return shares.updatePolicy(id, sharePolicyPatchSchema.parse(policy));
      }
      case 'share.feedback':
        return shares.feedback(id);
      case 'share.enrich':
        return shares.enrich(id);
      case 'unshare':
        return shares.unshare(id);
    }
  };
}
