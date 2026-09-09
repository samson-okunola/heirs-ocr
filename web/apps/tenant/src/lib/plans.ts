import { formatMinorCurrency } from "@heirs/ui";

import type { Feature, Plan } from "@/types/plan";

/**
 * How a plan from the catalog is described to someone who does not have an account
 * yet — on the landing page's pricing cards and in the register form's picker.
 *
 * Shared so the two cannot drift. They already had: the landing page carried
 * hand-written prices that were wrong on every paid tier (pay-as-you-go was
 * advertised at ₦150 a document against a real ₦25, and Business at ₦75,000 for
 * 2,000 documents against a real ₦120,000 for 15,000). Prices are data — a plan is
 * edited in the admin console, not in a deploy — so nothing here restates them.
 */

/** The headline figure and the unit it is charged in. */
export type PlanPrice = { amount: string; period?: string };

export const planPrice = (plan: Plan): PlanPrice => {
  switch (plan.billing.kind) {
    case "trial":
      return { amount: "Free", period: trialWindow(plan) };
    case "per_document":
      return {
        amount: formatMinorCurrency(plan.billing.unitPrice.amountMinor, plan.billing.unitPrice.currency, "compact"),
        period: "/ document",
      };
    case "monthly":
      return {
        amount: formatMinorCurrency(plan.billing.basePrice.amountMinor, plan.billing.basePrice.currency, "compact"),
        period: "/ month",
      };
  }
};

/** "14 days" — the free window, when the plan bounds one by time. */
const trialWindow = (plan: Plan): string | undefined =>
  plan.trial?.durationDays ? `${plan.trial.durationDays} days` : undefined;

/** One line for a select option: "Starter — ₦25K / month". */
export const planOptionLabel = (plan: Plan): string => {
  const { amount, period } = planPrice(plan);
  return `${plan.name} — ${period ? `${amount} ${period}` : amount}`;
};

const FEATURE_LABELS: Record<Feature, string> = {
  async_jobs: "Async job queue",
  pii_functions: "PII functions",
  batch_upload: "Batch upload",
  webhooks: "Webhooks",
  priority_processing: "Priority processing",
  custom_form_schemas: "Custom form schemas",
  extended_retention: "Extended data retention",
  sla_support: "SLA support",
};

const count = (n: number): string => n.toLocaleString("en-NG");

/** The document allowance, wherever the plan happens to express it. */
const allowance = (plan: Plan): string => {
  if (plan.billing.kind === "monthly") {
    return plan.billing.includedDocuments === null
      ? "Unlimited documents"
      : `${count(plan.billing.includedDocuments)} documents / month`;
  }
  if (plan.billing.kind === "per_document") return "No monthly minimum";
  const included = plan.trial?.includedDocuments ?? plan.entitlements.limits.documentsPerPeriod;
  return included === null || included === undefined ? "Unlimited documents" : `${count(included)} documents included`;
};

/**
 * The bullet list under a pricing card, in the order a buyer compares on: how much
 * they get, what it costs beyond that, how big a file may be, then capabilities.
 *
 * Capped at six — a card that scrolls is a card nobody reads, and the tiers are
 * distinguished by their first few lines anyway.
 */
export const planFeatures = (plan: Plan, limit = 6): string[] => {
  const lines: string[] = [allowance(plan)];

  if (plan.billing.kind === "monthly" && plan.billing.overageUnitPrice) {
    const { amountMinor, currency } = plan.billing.overageUnitPrice;
    lines.push(`Then ${formatMinorCurrency(amountMinor, currency, "compact")} per extra document`);
  }

  const pages = plan.entitlements.limits.maxPagesPerDocument;
  if (pages !== null) lines.push(`Up to ${count(pages)} pages per document`);

  lines.push(
    plan.entitlements.maxSensitivity === "standard" ? "Standard functions" : "PII functions (ID, loan, bank statement)",
  );

  for (const feature of plan.entitlements.features) {
    // `pii_functions` is already implied by the sensitivity line above.
    if (feature === "pii_functions") continue;
    lines.push(FEATURE_LABELS[feature] ?? feature);
  }

  lines.push(`${count(plan.entitlements.limits.dataRetentionDays)}-day data retention`);

  return lines.slice(0, limit);
};

/**
 * Which card wears the "Most popular" ribbon. The catalog has no such flag — it is a
 * marketing choice, not plan data — so it is pinned to the entry paid tier here
 * rather than invented per render.
 */
export const isFeaturedPlan = (plan: Plan): boolean => plan.tier === "starter";
