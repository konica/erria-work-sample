import { z } from 'zod';

export const classificationOutputSchema = z.object({
  fires: z.boolean(),
  rule: z
    .enum([
      'pricing_question',
      'technical_compliance_question',
      'negative_sentiment',
      'relationship_conflict',
    ])
    .nullable(),
  confidence: z.enum(['high', 'mid', 'low']),
  language_detected: z.string(),
  rationale: z.string(),
});

export type ClassificationOutput = z.infer<typeof classificationOutputSchema>;
