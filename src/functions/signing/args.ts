import { z } from "zod";

export const signingArgsSchema = z.object({
  /** When true, return only detected block geometry and skip the vision judgment (no LLM). */
  geometryOnly: z
    .boolean()
    .default(false)
    .describe("Only report where signature blocks are, without judging whether they were actually signed. Faster."),
  /** Signature-block cue phrases to correlate against nearby image blocks. */
  signatureCues: z
    .array(z.string())
    .default(["Signature", "Signed by", "For and on behalf of", "Witness", "Director"])
    .describe(
      "Wording that marks a place to sign in your documents. Replace these if your contracts word it differently.",
    ),
  /**
   * Page budget for the whole-page vision fallback, which runs one vision call per
   * page and is therefore far costlier than the cropped path. Only consulted when
   * extraction came from a provider without `seals`; the region path ignores it.
   * Pages carrying a cue phrase are preferred, latest first (execution pages sit at
   * the end of a contract).
   */
  maxVisionPages: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe("How many pages to inspect closely when signatures can't be located from the text. Higher costs more."),
});

export type SigningArgs = z.infer<typeof signingArgsSchema>;
