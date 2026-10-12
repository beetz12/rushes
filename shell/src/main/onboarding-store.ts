import { lstat, readFile } from 'node:fs/promises';
import { atomicJSON } from './atomic';
import {
  onboardingActionSchema,
  onboardingRecordSchema,
  type OnboardingRecord,
} from '../shared/onboarding';

export class OnboardingStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private path: string) {}

  action(value: unknown): Promise<OnboardingRecord> {
    const action = onboardingActionSchema.parse(value);
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        if (action === 'get') return this.read();
        // A corrupt saved choice must not silently turn a dismissed guide into a first run.
        await this.read();
        const result: OnboardingRecord = {
          version: 1,
          status:
            action === 'dismiss' ? 'dismissed' : action === 'complete' ? 'completed' : 'unseen',
        };
        await atomicJSON(this.path, result);
        return result;
      });
    this.pending = operation;
    return operation;
  }

  private async read(): Promise<OnboardingRecord> {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.uid !== process.getuid?.() || info.size > 1024)
        throw new Error('Unsafe guide preferences file');
      return onboardingRecordSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, status: 'unseen' };
      throw Object.assign(
        new Error(
          'Could not read your saved recording guide choice. Your recording settings are unchanged.',
        ),
        {
          code: 'onboarding-store-invalid',
          cause: error,
        },
      );
    }
  }
}
