import { z } from 'zod';

export const draftOutputSchema = z.object({
  should_draft: z.boolean(),
  draft_text: z.string(),
  confidence_label: z.enum(['high', 'mid', 'low']),
  abstain_reason: z.string().nullable(),
});

export type DraftOutput = z.infer<typeof draftOutputSchema>;
