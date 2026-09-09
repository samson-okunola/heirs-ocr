import { EPSILON, approxEqualMinor, formatMinor, sumMinor, toMinor } from "../money";
import type { ExpenseClaimResult } from "./result";

/**
 * Deterministic post-validation, not LLM trust: line-item amounts sum ≈ subtotal,
 * and subtotal + tax ≈ total, within a small relative tolerance. On mismatch,
 * downgrade `confidence` to "low" and append warnings rather than failing. A missing
 * receipt on any line also raises a warning (a policy signal for reviewers).
 *
 * Sums are exact — minor units throughout (see ../money.ts).
 */
export { EPSILON };

export const reconcileExpenseClaim = (result: ExpenseClaimResult, epsilon = EPSILON): ExpenseClaimResult => {
  const warnings = [...result.warnings];
  let confidence: ExpenseClaimResult["confidence"] = "high";
  const money = (minor: number) => formatMinor(minor, result.currency);

  const withAmount = result.lineItems.filter((li) => li.amount != null);
  if (withAmount.length > 0 && result.subtotal != null) {
    const sum = sumMinor(withAmount.map((li) => li.amount));
    const subtotal = toMinor(result.subtotal);
    if (!approxEqualMinor(sum, subtotal, epsilon)) {
      confidence = "low";
      warnings.push(`Line items sum to ${money(sum)} but subtotal is ${money(subtotal)}.`);
    }
  }

  if ((result.subtotal != null || result.tax != null) && result.total != null) {
    const composed = sumMinor([result.subtotal, result.tax]);
    const total = toMinor(result.total);
    if (!approxEqualMinor(composed, total, epsilon)) {
      confidence = "low";
      warnings.push(`Subtotal + tax = ${money(composed)} but total is ${money(total)}.`);
    }
  }

  const missingReceipts = result.lineItems.filter((li) => !li.receiptAttached).length;
  if (missingReceipts > 0) {
    warnings.push(`${missingReceipts} line item(s) have no attached receipt.`);
  }

  return { ...result, confidence, warnings };
};
