import { EPSILON, approxEqualMinor, formatMinor, sumMinor, toMinor } from "../money";
import type { BudgetAnalysisResult } from "./result";

/**
 * Deterministic post-validation, not LLM trust: the planned (and actual) line items
 * must sum to the reported totals within a small relative tolerance. On mismatch we
 * don't fail — downgrade `confidence` to "low" and append warnings so a caller can
 * route to human review. Mirrors `receipt-parsing/validate.ts`, minor units included.
 */
export { EPSILON };

export const reconcileBudget = (result: BudgetAnalysisResult, epsilon = EPSILON): BudgetAnalysisResult => {
  const warnings = [...result.warnings];
  let confidence: BudgetAnalysisResult["confidence"] = "high";
  const money = (minor: number) => formatMinor(minor, result.currency);

  const check = (label: string, lineValues: (number | null)[], total: number | null): void => {
    const present = lineValues.filter((v) => v != null);
    if (present.length === 0 || total == null) return;
    const sum = sumMinor(present);
    const expected = toMinor(total);
    if (!approxEqualMinor(sum, expected, epsilon)) {
      confidence = "low";
      warnings.push(`${label} line items sum to ${money(sum)} but total ${label} is ${money(expected)}.`);
    }
  };

  check(
    "planned",
    result.lineItems.map((l) => l.planned),
    result.totals.planned,
  );
  check(
    "actual",
    result.lineItems.map((l) => l.actual),
    result.totals.actual,
  );

  return { ...result, confidence, warnings };
};
