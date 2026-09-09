/**
 * Money arithmetic and presentation for the analysis functions.
 *
 * Every one of these functions reconciles printed totals — line items against a
 * subtotal, credits and debits against a closing balance — and each did it by
 * summing IEEE doubles. That is wrong twice over:
 *
 *  - **The sum drifts.** `0.1 + 0.2` is `0.30000000000000004`, and the error grows
 *    with the number of lines. On a long receipt the drift was reported as a real
 *    discrepancy, downgrading `confidence` on a document that adds up perfectly.
 *  - **The warning contradicted itself.** Both sides were rendered with
 *    `toFixed(2)`, so a mismatch of 4e-15 printed as "Line items sum to 20.00 but
 *    subtotal is 20.00" — a reviewer's time spent on a difference that does not
 *    exist at the precision money is written in.
 *
 * The fix is the standard one: hold money as an integer count of **minor units**
 * (kobo, cents) for the duration of the arithmetic, and convert back only to report.
 * Two-decimal currencies are the only ones this catalog handles; a three-decimal
 * currency (KWD, BHD) would need a per-currency exponent rather than a fixed 100.
 */

/** Relative tolerance, with a small absolute floor, for "these two totals agree". */
export const EPSILON = 0.02;

/** Whole minor units for a major-unit amount. `19.995` → `2000` (round half away from zero). */
export const toMinor = (amount: number): number => Math.round(amount * 100);

/** Back to major units for reporting. */
export const toMajor = (minor: number): number => minor / 100;

/**
 * Exact sum of major-unit amounts, in minor units. Each value is rounded to the
 * cent *before* being added, so the result is the sum of what was printed rather
 * than the sum of what a float approximated.
 */
export const sumMinor = (values: readonly (number | null | undefined)[]): number =>
  values.reduce<number>((total, value) => total + (value == null ? 0 : toMinor(value)), 0);

/**
 * Whether two minor-unit amounts agree within {@link EPSILON} — a relative tolerance
 * so it holds for a ₦300 corner-shop receipt and a ₦3,000,000 invoice alike, with an
 * absolute floor so tiny totals still get some slack.
 */
export const approxEqualMinor = (a: number, b: number, epsilon: number = EPSILON): boolean =>
  Math.abs(a - b) <= Math.max(toMinor(epsilon), epsilon * Math.abs(b));

/** ISO 4217 is three letters; anything else came from the document, not a standard. */
const isCurrencyCode = (currency: string | null | undefined): currency is string =>
  typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency);

/**
 * A minor-unit amount as a person reads it: grouped thousands, always two decimals,
 * and the symbol for the currency the document was parsed in — `₦1,234,567.89`,
 * `$1,234,567.89`.
 *
 * `currency` is whatever the run resolved (the `currency` arg, or what was printed
 * on the document), so it can be missing or nonsense. Anything that isn't a
 * three-letter code degrades to the bare grouped number; a well-formed but
 * unassigned code is left to `Intl`, which prints it verbatim as the unit
 * (`ZZZ 1,234,567.89`) — more use to a reader than silently dropping it.
 */
export const formatMinor = (minor: number, currency?: string | null): string => {
  const amount = toMajor(minor);
  const options: Intl.NumberFormatOptions = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

  if (isCurrencyCode(currency)) {
    try {
      return new Intl.NumberFormat("en-NG", {
        ...options,
        style: "currency",
        currency: currency.toUpperCase(),
        currencyDisplay: "narrowSymbol",
      }).format(amount);
    } catch {
      // A well-formed but unassigned code (e.g. "ZZZ") — fall through to plain digits.
    }
  }
  return new Intl.NumberFormat("en-NG", options).format(amount);
};

/** {@link formatMinor} for a value still in major units. */
export const formatAmount = (amount: number, currency?: string | null): string =>
  formatMinor(toMinor(amount), currency);
