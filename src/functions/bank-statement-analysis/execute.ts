import type { BankStatementAnalysisResult } from "./result";
import { buildBankStatementAnalysisPrompt } from "./prompt";
import { bankStatementExtractionSchema } from "./result";
import type { BankStatementAnalysisArgs } from "./args";
import { approxEqualMinor, formatMinor, sumMinor, toMajor, toMinor } from "../money";
import type { OcrContext } from "../define";

/**
 * Parses a bank statement, then computes the credit/debit summary and a
 * reconciliation verdict deterministically from the extracted transactions — never
 * trusting the model's own totals (same split as RECEIPT_PARSING / LOAN_REVIEW).
 *
 * `pii`: the pipeline applies no-store + redacted logging from `sensitivity: "pii"`.
 */
export const executeBankStatementAnalysis = async (
  ctx: OcrContext,
  args: BankStatementAnalysisArgs,
): Promise<BankStatementAnalysisResult> => {
  const { system, user } = buildBankStatementAnalysisPrompt(ctx.doc.markdown, args);

  const { data } = await ctx.llm.complete({
    system,
    user,
    schema: bankStatementExtractionSchema,
    schemaName: "BANK_STATEMENT_ANALYSIS_extraction",
  });

  // Minor units for the whole reconciliation (see ../money.ts): a statement can run
  // to hundreds of transactions, and a float sum of that many amounts drifts far
  // enough to be reported as a discrepancy the statement does not have.
  const creditsMinor = sumMinor(data.transactions.map((t) => t.credit));
  const debitsMinor = sumMinor(data.transactions.map((t) => t.debit));
  const totalCredits = toMajor(creditsMinor);
  const totalDebits = toMajor(debitsMinor);
  const warnings: string[] = [];
  let confidence: BankStatementAnalysisResult["confidence"] = "high";
  const money = (minor: number) => formatMinor(minor, data.currency);

  // Reconcile: opening + credits − debits should land on the closing balance.
  if (data.openingBalance != null && data.closingBalance != null) {
    const derived = toMinor(data.openingBalance) + creditsMinor - debitsMinor;
    const closing = toMinor(data.closingBalance);
    if (!approxEqualMinor(derived, closing)) {
      confidence = "low";
      warnings.push(`Opening + credits − debits = ${money(derived)} but closing balance is ${money(closing)}.`);
    }
  } else {
    confidence = "low";
    warnings.push("Opening or closing balance missing — could not reconcile the statement.");
  }

  return {
    ...data,
    summary: {
      totalCredits,
      totalDebits,
      netFlow: toMajor(creditsMinor - debitsMinor),
      transactionCount: data.transactions.length,
    },
    confidence,
    warnings,
  };
};
