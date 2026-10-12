import { z } from 'zod';

export const onboardingActionSchema = z.enum(['get', 'dismiss', 'complete', 'reset']);
export const onboardingRecordSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(['unseen', 'dismissed', 'completed']),
  })
  .strict();
export type OnboardingAction = z.infer<typeof onboardingActionSchema>;
export type OnboardingRecord = z.infer<typeof onboardingRecordSchema>;
