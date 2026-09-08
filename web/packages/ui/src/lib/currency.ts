/**
 * Money formatting, kept out of `utils.ts` because that module is the `cn`/clsx
 * helper and pulls in Tailwind's class merger — these two functions need nothing but
 * `Intl`, and separating them lets the money rules be exercised on their own.
 */

/**
 * An amount with its currency symbol.
 *
 * `"compact"` is for glanceable tiles — `₦1.2M` — and deliberately carries no
 * decimals; a compact figure is an order of magnitude, not a balance. `"full"` is
 * for anywhere a number is meant to be *read as money* and always shows both
 * decimal places: `₦1,234,567.89`. Rendering an exact amount as `₦1,234,568`
 * silently disagrees with the receipt it came from, and a column where some rows
 * show cents and others don't cannot be scanned down.
 */
export function formatCurrency(amount = 0, currency = "NGN", display: "compact" | "full" = "compact") {
  const compact = display === "compact";
  return new Intl.NumberFormat("en-NG", {
    currency,
    currencyDisplay: "narrowSymbol",
    style: "currency",
    maximumFractionDigits: compact ? 0 : 2,
    minimumFractionDigits: compact ? 0 : 2,
    ...(compact ? { notation: "compact", compactDisplay: "short" } : { notation: "standard" }),
  }).format(amount);
}

/** A plan/invoice amount held in minor units (kobo, cents), rendered as money. */
export function formatMinorCurrency(amountMinor = 0, currency = "NGN", display: "compact" | "full" = "full") {
  return formatCurrency(amountMinor / 100, currency, display);
}
