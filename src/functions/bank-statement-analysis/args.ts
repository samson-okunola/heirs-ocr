import { z } from "zod";

export const bankStatementAnalysisArgsSchema = z.object({
  /** ISO 4217 code. NGN default for the Nigerian market. */
  currency: z
    .string()
    .length(3)
    .default("NGN")
    .describe("Three-letter currency code for the amounts on this document, e.g. NGN, USD, GBP."),
});

export type BankStatementAnalysisArgs = z.infer<typeof bankStatementAnalysisArgsSchema>;
