/**
 * Every React Query key used by the tenant portal, in one place.
 *
 * Two reasons this is a registry rather than a string literal at each call site:
 *
 *  1. **Invalidation is prefix-based.** `invalidateQueries({ queryKey: ["tenant"] })`
 *     only reaches a query whose key actually *starts* with `["tenant"]`. When keys
 *     are written by hand they drift — the portal previously had `["tenant-auth",
 *     "me"]` and `["tenant-security", "mfa"]` sitting outside the `tenant` root, so a
 *     blanket invalidation silently skipped them. Rooting everything here makes that
 *     class of miss impossible.
 *  2. **One mutation usually affects several screens.** Running a document changes
 *     the document list, the usage counters behind billing, and the job queue. The
 *     set of things it touches belongs next to the keys, not scattered across the
 *     components that happen to trigger it — see {@link tenantInvalidations}.
 *
 * Keys are hierarchical, so a parent invalidates all of its children: invalidating
 * `documents` covers both the paginated list and every report window.
 */

const root = ["tenant"] as const;

export const tenantKeys = {
  /** The whole portal. Used on sign-out to drop the previous session's cache. */
  all: root,

  auth: [...root, "auth"] as const,
  /** The signed-in user. */
  me: [...root, "auth", "me"] as const,

  /** Subscription + lifetime usage counters. */
  billing: [...root, "billing"] as const,

  documents: [...root, "documents"] as const,
  documentList: (params?: unknown) => [...root, "documents", "list", params] as const,
  documentReport: (days: number) => [...root, "documents", "report", days] as const,

  /** Async OCR jobs for this org. */
  jobs: [...root, "jobs"] as const,

  /** API request history. */
  logs: [...root, "logs"] as const,

  /** What a data export would contain. */
  backup: [...root, "backup"] as const,

  webhooks: [...root, "webhooks"] as const,
  /** The delivery log; nested so any endpoint change refreshes it too. */
  webhookDeliveries: [...root, "webhooks", "deliveries"] as const,

  keys: [...root, "keys"] as const,
  keyList: (params?: unknown) => [...root, "keys", "list", params] as const,

  team: [...root, "team"] as const,
  teamList: (params?: unknown) => [...root, "team", "list", params] as const,

  security: [...root, "security"] as const,
  /** Second-factor status for the signed-in user. */
  mfa: [...root, "security", "mfa"] as const,
  /** Live sign-ins for the signed-in user. */
  sessions: [...root, "security", "sessions"] as const,
  /** The org's sign-in IP restrictions. */
  ipAllowlist: [...root, "security", "ip-allowlist"] as const,

  /** The self-serve plan catalog shown on the register form. */
  planList: (params?: unknown) => [...root, "plans", params] as const,
} as const;

/**
 * What each kind of change makes stale.
 *
 * Written as data so the answer to "what else does this affect?" lives in one
 * reviewable list. A mutation hook spreads the relevant entry rather than deciding
 * for itself, which is what keeps a new screen from quietly going stale when someone
 * adds a mutation elsewhere.
 */
export const tenantInvalidations = {
  /**
   * A document was processed (sync result or a queued job that finished).
   *
   * It lands a row in the document registry, meters against the subscription, and —
   * on the async path — moves a job to `completed`. All three are visible on
   * different screens, and none of them refresh on their own.
   */
  ocrRun: [tenantKeys.documents, tenantKeys.billing, tenantKeys.jobs],

  /** API keys changed. Nothing else reads them. */
  keys: [tenantKeys.keys],

  /** Team membership changed. */
  team: [tenantKeys.team],

  /**
   * Second-factor state changed. `me` rides along because the session's own view of
   * the account is what the header renders.
   */
  security: [tenantKeys.mfa, tenantKeys.me],
} satisfies Record<string, readonly (readonly unknown[])[]>;

/**
 * Invalidates several key prefixes at once.
 *
 * Returns the combined promise so a caller that needs the refetch to have landed
 * (a redirect, a toast that reports counts) can await it; mutation `onSuccess`
 * handlers normally just let it run.
 */
export const invalidate = (
  qc: import("@tanstack/react-query").QueryClient,
  keys: readonly (readonly unknown[])[],
): Promise<unknown> => Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })));
