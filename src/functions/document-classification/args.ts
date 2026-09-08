import { z } from "zod";

export const documentClassificationArgsSchema = z.object({
  candidateLabels: z
    .array(z.string())
    .optional()
    .describe("The document types to choose between, e.g. invoice, receipt, contract. Omit to let it decide."),
  allowUnknown: z
    .boolean()
    .default(true)
    .describe(
      "Answer 'unknown' rather than guess when nothing fits well. Leave on unless you need a label every time.",
    ),
  minConfidence: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("How sure it must be before committing to a label. 0 accepts anything, 1 accepts almost nothing."),
  /** Cost control: classify from page 1 only unless the caller opts in. */
  fullDocument: z
    .boolean()
    .default(false)
    .describe("Read every page instead of just the first. Slower and costlier, better on long mixed documents."),
});

export type DocumentClassificationArgs = z.infer<typeof documentClassificationArgsSchema>;
