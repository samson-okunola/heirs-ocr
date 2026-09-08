import { approxEqualMinor, formatMinor, sumMinor, toMinor } from "../money";

/**
 * Deterministic payslip arithmetic check, mirroring receipt totals
 * reconciliation (`receipt-parsing/validate.ts`): never trust the model's own
 * sums. On mismatch, downgrade `confidence` to "low" and record a warning so
 * callers can route to human review rather than failing the request.
 *
 * Amounts are summed in minor units (see ../money.ts) so the check answers on the
 * figures as printed rather than on their float approximations.
 */
export type Reconciliation = { confidence: "high" | "low"; warnings: string[] };

/** Coerces an extracted value to a finite number, or null (fields arrive as `number | null`). */
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A payslip is a bag of loose fields; the currency rides along with it when present. */
const currencyOf = (fields: Record<string, unknown>): string | null =>
  typeof fields.currency === "string" ? fields.currency : null;

export const reconcilePayslip = (fields: Record<string, unknown>): Reconciliation => {
  const warnings: string[] = [];
  let confidence: Reconciliation["confidence"] = "high";
  const money = (minor: number) => formatMinor(minor, currencyOf(fields));

  const basicSalary = num(fields.basicSalary);
  const allowances = num(fields.allowances);
  const grossPay = num(fields.grossPay);
  const netPay = num(fields.netPay);
  const deductions = num(fields.deductions);
  const tax = num(fields.tax);
  const pension = num(fields.pension);

  // Gross ≈ basic + allowances (only checked when gross and at least one component are present).
  if (grossPay != null && (basicSalary != null || allowances != null)) {
    const composed = sumMinor([basicSalary, allowances]);
    const gross = toMinor(grossPay);
    if (!approxEqualMinor(composed, gross)) {
      confidence = "low";
      warnings.push(`Basic + allowances = ${money(composed)} but gross pay is ${money(gross)}.`);
    }
  }

  // Net ≈ gross − deductions − tax − pension. Payslips vary on whether `deductions`
  // is a grand total (already including tax/pension) or a separate line, so accept
  // either interpretation and only warn when neither reconciles.
  if (netPay != null && grossPay != null) {
    const gross = toMinor(grossPay);
    const net = toMinor(netPay);
    const itemised = gross - sumMinor([deductions, tax, pension]);
    const deductionsAsTotal = gross - sumMinor([deductions]);
    if (!approxEqualMinor(itemised, net) && !approxEqualMinor(deductionsAsTotal, net)) {
      confidence = "low";
      warnings.push(`Gross − deductions − tax − pension = ${money(itemised)} but net pay is ${money(net)}.`);
    }
  }

  return { confidence, warnings };
};
