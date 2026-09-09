import { describe, expect, it } from "vitest";

import { isFeaturedPlan, planFeatures, planOptionLabel, planPrice } from "../web/apps/tenant/src/lib/plans";
import type { Plan } from "../web/apps/tenant/src/types/plan";
import { publicPlans } from "../src/billing/plans";

/**
 * What the landing page and the register picker say about money.
 *
 * The pricing section used to carry hand-written figures, and every paid tier had
 * drifted from the catalog — pay-as-you-go advertised at ₦150 a document against a
 * real ₦25, Business at ₦75,000 for 2,000 documents against a real ₦120,000 for
 * 15,000. Driving the copy off the catalog is the fix; this asserts the derivation,
 * against the real seed plans rather than fixtures, so a plan shape the presenter
 * cannot describe fails here.
 */
const plans = publicPlans() as unknown as Plan[];
const byId = (id: string): Plan => {
  const plan = plans.find((p) => p.id === id);
  if (!plan) throw new Error(`No self-serve plan '${id}'`);
  return plan;
};

/** `Intl` separates a symbol from its digits with a non-breaking space. */
const flat = (s: string): string => s.replace(/ /g, " ");

describe("headline price", () => {
  it("reads a per-document plan off its unit price", () => {
    expect(planPrice(byId("payg"))).toEqual({ amount: "₦25", period: "/ document" });
  });

  it("reads a monthly plan off its base price", () => {
    expect(planPrice(byId("starter"))).toEqual({ amount: "₦25K", period: "/ month" });
    expect(planPrice(byId("business"))).toEqual({ amount: "₦120K", period: "/ month" });
  });

  it("shows a trial as free, with the window it runs for", () => {
    expect(planPrice(byId("free_trial"))).toEqual({ amount: "Free", period: "14 days" });
  });

  it("describes every self-serve plan without falling through", () => {
    for (const plan of plans) expect(planPrice(plan).amount).toBeTruthy();
  });
});

describe("plan picker label", () => {
  it("puts the name and the price on one line", () => {
    expect(flat(planOptionLabel(byId("payg")))).toBe("Pay As You Go — ₦25 / document");
    expect(flat(planOptionLabel(byId("free_trial")))).toBe("Free Trial — Free 14 days");
  });
});

describe("pricing card bullets", () => {
  it("leads with the allowance, in the terms each plan expresses it", () => {
    expect(planFeatures(byId("free_trial"))[0]).toBe("50 documents included");
    expect(planFeatures(byId("payg"))[0]).toBe("No monthly minimum");
    expect(planFeatures(byId("starter"))[0]).toBe("2,000 documents / month");
    expect(planFeatures(byId("business"))[0]).toBe("15,000 documents / month");
  });

  it("quotes the overage price on a plan that has one", () => {
    expect(planFeatures(byId("starter")).map(flat)).toContain("Then ₦15 per extra document");
    expect(planFeatures(byId("payg")).some((f) => f.startsWith("Then "))).toBe(false);
  });

  it("distinguishes the tier that unlocks PII functions", () => {
    expect(planFeatures(byId("starter"))).toContain("Standard functions");
    expect(planFeatures(byId("business"))).toContain("PII functions (ID, loan, bank statement)");
  });

  it("names entitlements in words rather than flag ids", () => {
    const business = planFeatures(byId("business"), 20);
    expect(business).toContain("Async job queue");
    expect(business).toContain("Webhooks");
    expect(business.join(" ")).not.toContain("_");
  });

  it("keeps a card short enough to read", () => {
    for (const plan of plans) expect(planFeatures(plan).length).toBeLessThanOrEqual(6);
  });

  it("never renders an empty or undefined bullet", () => {
    for (const plan of plans) {
      for (const line of planFeatures(plan)) expect(line.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("the featured card", () => {
  it("marks exactly one plan as most popular", () => {
    expect(plans.filter(isFeaturedPlan)).toHaveLength(1);
    expect(plans.find(isFeaturedPlan)?.id).toBe("starter");
  });
});
