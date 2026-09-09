import { z } from "zod";

export const loanReviewArgsSchema = z.object({
  /** ISO 4217 code. NGN default for the Nigerian market. */
  currency: z
    .string()
    .length(3)
    .default("NGN")
    .describe("Three-letter currency code for the amounts on this document, e.g. NGN, USD, GBP."),
  /** Max debt-to-income ratio treated as comfortably affordable (approve threshold). */
  maxDebtToIncome: z
    .number()
    .min(0)
    .max(1)
    .default(0.4)
    .describe("The most of an applicant's income that may go to debt and still pass, as a fraction. 0.4 is 40%."),
});

export type LoanReviewArgs = z.infer<typeof loanReviewArgsSchema>;
