import { randomBytes } from "crypto";

import { createSubscriptionFromPlan, putSubscription } from "../billing/subscriptions";
import { generateApiKey, listKeysForTenant, putTenant, type Tenant } from "./tenants";
import type { SubscriptionPlan } from "../types/subscription";
import { createTenantUser } from "./tenant-users";
import { logger } from "../observability/logger";
import type { TenantUser } from "../types/user";

/**
 * Turning an approved signup into a working organisation.
 *
 * Three records have to exist before a new customer can do anything: the API-key
 * row that *is* the org (src/auth/tenants.ts), an owner who can sign into the
 * portal, and a subscription, without which every OCR call is refused by the
 * entitlement middleware. Admin provisioning creates them through three separate
 * endpoints; self-serve signup has no operator in the loop, so the sequence lives
 * here and both paths can share it.
 *
 * There is no transaction spanning the three stores. The order below is chosen so
 * that a failure part-way leaves something an operator can finish or clean up by
 * hand, rather than something a *customer* is stuck inside: the org and its key come
 * first, then the subscription, and the owner login — the thing that makes the org
 * reachable — last. A half-provisioned org with no owner is invisible and harmless;
 * an owner who can sign in to an org with no subscription would see every request
 * rejected with a billing error they cannot fix.
 */

/** A tenant id derived from the org name: readable in logs, unique by construction. */
const slugify = (name: string): string => {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining marks so "Ọ̀ṣun" slugs as "osun" rather than dropping the vowel.
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug || "org";
};

/**
 * Picks an unused tenant id for an organisation name.
 *
 * The suffix is random rather than a counter: `acme-2` tells the world Acme was the
 * second org to claim that name, and a counter needs a read-modify-write that races
 * anyway. Three bytes is 16M values against a handful of collisions per name, and the
 * loop covers the rest.
 */
export const allocateTenantId = async (organizationName: string, attempts = 5): Promise<string> => {
  const base = slugify(organizationName);
  for (let i = 0; i < attempts; i++) {
    const candidate = `${base}-${randomBytes(3).toString("hex")}`;
    if ((await listKeysForTenant(candidate)).length === 0) return candidate;
  }
  throw new Error(`Could not allocate a tenant id for '${organizationName}' after ${attempts} attempts`);
};

export type ProvisionTenantInput = {
  organizationName: string;
  plan: SubscriptionPlan;
  /** Credential passed straight through to {@link createTenantUser} — plaintext or a hash. */
  owner: { email: string; name: string } & (
    | { password: string; passwordHash?: undefined }
    | { passwordHash: string; password?: undefined }
  );
};

export type ProvisionedTenant = {
  tenant: Tenant;
  /** The raw API key. Shown to the customer once and never recoverable afterwards. */
  apiKey: string;
  user: TenantUser;
};

/**
 * Creates an org, its first API key, its subscription and its owner login.
 *
 * `actor` names who caused this in the audit stream — an admin's user id, or
 * `"self-signup"` when the customer did it themselves.
 */
export const provisionTenant = async (
  input: ProvisionTenantInput,
  actor = "self-signup",
): Promise<ProvisionedTenant> => {
  const tenantId = await allocateTenantId(input.organizationName);

  const tenant: Tenant = {
    tenantId,
    name: input.organizationName,
    createdAt: new Date().toISOString(),
  };
  const apiKey = generateApiKey();
  await putTenant(apiKey, tenant, { actor });

  // The plan is snapshotted into the subscription, so a later catalog edit never
  // re-prices this org (see `createSubscriptionFromPlan`).
  await putSubscription(createSubscriptionFromPlan(tenantId, input.plan));

  const user = await createTenantUser({ tenantId, role: "owner", ...input.owner }, actor);

  logger.info("tenant.provisioned.self_serve", { tenantId, planId: input.plan.id, userId: user.id, actor });
  return { tenant, apiKey, user };
};
