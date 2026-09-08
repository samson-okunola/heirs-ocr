import { z } from "zod";

export const expenseClaimArgsSchema = z.object({
  /** ISO 4217 code. NGN default for the Nigerian market. */
  currency: z
    .string()
    .length(3)
    .default("NGN")
    .describe("Three-letter currency code for the amounts on this document, e.g. NGN, USD, GBP."),
  /** Expected VAT rate for the deterministic post-validation. Nigeria: 7.5%. */
  expectedTaxRate: z
    .number()
    .min(0)
    .max(1)
    .default(0.075)
    .describe("The VAT rate to check the claim against, as a decimal fraction. Nigeria's 7.5% is 0.075."),
});

export type ExpenseClaimArgs = z.infer<typeof expenseClaimArgsSchema>;
