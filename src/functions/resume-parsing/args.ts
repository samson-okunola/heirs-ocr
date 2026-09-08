import { z } from "zod";

export const resumeParsingArgsSchema = z.object({
  /** Normalize dates to ISO 8601 in the output. */
  normalizeDates: z
    .boolean()
    .default(true)
    .describe("Rewrite every date in the same YYYY-MM-DD form. Turn off to keep the wording used on the CV."),
});

export type ResumeParsingArgs = z.infer<typeof resumeParsingArgsSchema>;
