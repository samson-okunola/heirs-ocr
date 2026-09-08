import type { NextRequest } from "next/server";

import type { Plan } from "@/types/plan";
import { requireEnv } from "./env";

/**
 * Server-side config for reaching the OCR backend from the Next proxy routes.
 * Read only in route handlers (never shipped to the browser).
 */

/**
 * Base URL of the OCR API, including the scheme — `fetch` cannot parse a bare
 * `host:port`. Required rather than defaulted: a silent fallback to localhost in a
 * deployed environment fails as a connection refused far from its cause, and
 * `src/instrumentation.ts` has already refused to start without it.
 */
export const ocrApiUrl = (): string => requireEnv("OCR_API_URL");

/**
 * The host to print in public documentation — what a customer types into their own
 * client, which is not necessarily what this app dials.
 *
 * Deliberately a separate variable rather than a fallback to {@link ocrApiUrl}:
 * that one is the server-to-server address and in a deployed environment is
 * typically an internal name (or `http://localhost:8080` in dev). Falling back to
 * it would publish an internal hostname on the marketing site the first time
 * someone forgot to set this. Unset means the docs keep the neutral placeholder,
 * which is wrong but harmless.
 *
 * Server-only, like the rest of this module — the docs pages that read it are
 * server components, and the value is baked in when they prerender.
 */
export const publicApiUrl = (): string => process.env.OCR_PUBLIC_API_URL ?? "https://api.heirs-ocr.example";

/** The tenant-portal session cookie (mirrors the backend's `tenant_session`). */
export const TENANT_SESSION_COOKIE = "tenant_session";

/**
 * Whether an *unauthenticated* caller may fall back to the shared `OCR_API_KEY`.
 *
 * Off unless explicitly opted in. `/api/ocr/*` is excluded from the proxy's auth
 * gate (the matcher skips `api`), so with an unconditional fallback any anonymous
 * caller on the internet could POST a document and have it run — and be billed and
 * rate-limited — against whichever tenant owns that key. The fallback exists only
 * for a local, keyless (`AUTH_ENABLED=false`) backend.
 */
const anonymousAllowed = (): boolean => process.env.OCR_ALLOW_ANONYMOUS === "true";

/**
 * Auth to attach to an upstream `/v1/ocr/*` call, or `null` when the caller is not
 * signed in and anonymous access is not enabled — the route must then 401 rather
 * than spend the shared key. In a multi-tenant deployment the caller is a signed-in
 * tenant, so we forward **their** `tenant_session` cookie and the backend resolves
 * it to that tenant, scoping usage and billing to them.
 */
export const ocrForwardAuth = (req: NextRequest): Record<string, string> | null => {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (token) return { cookie: `${TENANT_SESSION_COOKIE}=${token}` };

  if (!anonymousAllowed()) return null;
  const key = process.env.OCR_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
};

/** The backend's error envelope, so the client can parse proxy and API errors alike. */
export const ocrErrorResponse = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ error: { code, message, retryable: false } }), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Relay an upstream response verbatim. The content-type is carried over rather than
 * asserted as JSON: a gateway 502 with an HTML body would otherwise reach the client
 * labelled `application/json` and blow up in `res.json()` as a misleading
 * "network error" instead of the actual upstream failure.
 */
export const relayUpstream = async (res: Response): Promise<Response> =>
  new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });

/**
 * The self-serve plan catalog, read on the server for the public pricing section.
 *
 * Goes straight to the backend rather than through this app's own `/api/tenant`
 * proxy: that proxy exists so the *browser* can talk same-origin, and a server
 * component calling its own HTTP route would be a pointless extra hop.
 *
 * Returns `[]` rather than throwing when the API is unreachable. A marketing page
 * must render — but it must not render invented prices, so the caller shows a
 * fallback that says nothing about cost instead of stale numbers.
 */
export const fetchPublicPlans = async (): Promise<Plan[]> => {
  try {
    const res = await fetch(`${ocrApiUrl()}/tenant/api/plans?pageSize=100`, {
      // Plans change when an operator edits them, not per visitor.
      next: { revalidate: 300 },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: Plan[] };
    return body.items ?? [];
  } catch {
    return [];
  }
};
