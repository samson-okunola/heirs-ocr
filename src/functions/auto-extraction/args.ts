import { z } from "zod";

export const autoExtractionArgsSchema = z.object({
  /** Below this classifier confidence the document is reported as `unknown` (no guessed routing). */
  minConfidence: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("How sure it must be about what the document is before extracting. Below this it reports 'unknown'."),
  /** Classify from the whole document rather than page 1 only (costlier, more robust for multi-page). */
  fullDocument: z
    .boolean()
    .default(false)
    .describe("Identify the document from all its pages instead of the first. Slower, better for long documents."),
  /** Default currency passed through to the receipt parser when a receipt is detected (ISO 4217). */
  currency: z
    .string()
    .length(3)
    .default("NGN")
    .describe("Three-letter currency code to assume for money amounts, e.g. NGN, USD, GBP."),
});

export type AutoExtractionArgs = z.infer<typeof autoExtractionArgsSchema>;
