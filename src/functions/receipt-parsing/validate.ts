import { EPSILON, approxEqualMinor, formatMinor, sumMinor, toMinor } from "../money";
import type { ReceiptParsingResult } from "./result";

/**
 * Deterministic post-validation, not LLM trust: line items sum ≈
 * subtotal, and subtotal + tax + tip ≈ total, within a small epsilon. On
 * mismatch don't fail — downgrade `confidence` to "low" and append warnings so
 * callers can route to human review.
 *
 * The arithmetic runs in minor units (see ../money.ts): summing the printed lines
 * as floats drifted, and the drift was reported as a real discrepancy on receipts
 * that balance exactly.
 */
export { EPSILON };

export const reconcileTotals = (result: ReceiptParsingResult, epsilon = EPSILON): ReceiptParsingResult => {
  const warnings = [...result.warnings];
  let confidence: ReceiptParsingResult["confidence"] = "high";
  const money = (minor: number) => formatMinor(minor, result.currency);

  const itemsWithTotal = result.lineItems.filter((li) => li.total != null);
  if (itemsWithTotal.length > 0 && result.subtotal != null) {
    const lineSum = sumMinor(itemsWithTotal.map((li) => li.total));
    const subtotal = toMinor(result.subtotal);
    if (!approxEqualMinor(lineSum, subtotal, epsilon)) {
      confidence = "low";
      warnings.push(`Line items sum to ${money(lineSum)} but subtotal is ${money(subtotal)}.`);
    }
  }

  const hasComponents = result.subtotal != null || result.tax != null || result.tip != null;
  if (hasComponents && result.total != null) {
    const composed = sumMinor([result.subtotal, result.tax, result.tip]);
    const total = toMinor(result.total);
    if (!approxEqualMinor(composed, total, epsilon)) {
      confidence = "low";
      warnings.push(`Subtotal + tax + tip = ${money(composed)} but total is ${money(total)}.`);
    }
  }

  return { ...result, confidence, warnings };
};
