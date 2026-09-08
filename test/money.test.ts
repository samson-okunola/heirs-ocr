import { describe, expect, it } from "vitest";

import { approxEqualMinor, formatAmount, formatMinor, sumMinor, toMajor, toMinor } from "../src/functions/money";
import { reconcileTotals } from "../src/functions/receipt-parsing/validate";
import type { ReceiptParsingResult } from "../src/functions/receipt-parsing/result";

describe("minor-unit arithmetic", () => {
  it("sums exactly where floats drift", () => {
    // The canonical case: 0.1 + 0.2 !== 0.3 in IEEE 754.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumMinor([0.1, 0.2])).toBe(30);
    expect(toMajor(sumMinor([0.1, 0.2]))).toBe(0.3);
  });

  it("stays exact over a long receipt", () => {
    const lines = Array.from({ length: 1000 }, () => 0.07);
    expect(lines.reduce((a, b) => a + b, 0)).not.toBe(70);
    expect(toMajor(sumMinor(lines))).toBe(70);
  });

  it("treats null and undefined entries as zero", () => {
    expect(sumMinor([10, null, 5, undefined])).toBe(1500);
    expect(sumMinor([])).toBe(0);
  });

  it("rounds to the nearest minor unit", () => {
    expect(toMinor(19.994)).toBe(1999);
    expect(toMinor(19.995)).toBe(2000);
    expect(toMinor(-1.005)).toBe(-100); // round-half-up, matching Math.round
  });

  it("compares with a relative tolerance and an absolute floor", () => {
    expect(approxEqualMinor(toMinor(100), toMinor(100.02))).toBe(true);
    expect(approxEqualMinor(toMinor(100), toMinor(102.5))).toBe(false);
    // Tiny totals still get the floor rather than a vanishing relative window.
    expect(approxEqualMinor(toMinor(0.5), toMinor(0.51))).toBe(true);
  });
});

describe("money formatting", () => {
  it("groups thousands and always shows two decimals", () => {
    expect(formatMinor(123456789, "USD")).toBe("$1,234,567.89");
    expect(formatMinor(123456700, "USD")).toBe("$1,234,567.00");
  });

  it("uses the symbol for the currency the document was parsed in", () => {
    expect(formatMinor(123456789, "NGN")).toBe("₦1,234,567.89");
    expect(formatMinor(123456789, "ngn")).toBe("₦1,234,567.89");
  });

  it("degrades to a bare number when there is no usable currency", () => {
    // The code is whatever the run resolved — it can be missing or prose.
    expect(formatMinor(123456789, null)).toBe("1,234,567.89");
    expect(formatMinor(123456789, undefined)).toBe("1,234,567.89");
    expect(formatMinor(123456789, "Naira")).toBe("1,234,567.89");
  });

  it("prints an unassigned but well-formed code as its own unit", () => {
    // More useful than dropping it: the reader still learns what the figure counts.
    // `Intl` separates a code-as-symbol with a non-breaking space, so normalise it.
    expect(formatMinor(123456789, "ZZZ").replace(/\u00a0/g, " ")).toBe("ZZZ 1,234,567.89");
  });

  it("formats major-unit amounts the same way", () => {
    expect(formatAmount(1234567.89, "USD")).toBe("$1,234,567.89");
  });
});

/** A receipt that adds up exactly, expressed in amounts a float sum cannot hold. */
const receipt = (over: Partial<ReceiptParsingResult> = {}): ReceiptParsingResult =>
  ({
    merchant: { name: "Corner Shop", address: null, taxId: null },
    date: null,
    currency: "NGN",
    lineItems: [
      { description: "a", quantity: 1, unitPrice: 0.1, total: 0.1 },
      { description: "b", quantity: 1, unitPrice: 0.2, total: 0.2 },
    ],
    subtotal: 0.3,
    tax: null,
    tip: null,
    total: 0.3,
    paymentMethod: null,
    confidence: "high",
    warnings: [],
    ...over,
  }) as ReceiptParsingResult;

describe("receipt reconciliation", () => {
  it("does not invent a discrepancy out of float drift", () => {
    const result = reconcileTotals(receipt());
    expect(result.confidence).toBe("high");
    expect(result.warnings).toEqual([]);
  });

  it("still catches a real mismatch, and quotes both sides in the receipt's currency", () => {
    const result = reconcileTotals(receipt({ subtotal: 5, total: 5 }));
    expect(result.confidence).toBe("low");
    expect(result.warnings[0]).toBe("Line items sum to ₦0.30 but subtotal is ₦5.00.");
  });

  it("reports large amounts grouped, not as bare digits", () => {
    const result = reconcileTotals(
      receipt({
        currency: "USD",
        lineItems: [{ description: "consulting", quantity: 1, unitPrice: 1234567.89, total: 1234567.89 }],
        subtotal: 1,
        total: 1,
      }) as ReceiptParsingResult,
    );
    expect(result.warnings[0]).toContain("$1,234,567.89");
  });
});
