import type { NextRequest } from "next/server";

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

/** The tenant-portal session cookie (mirrors the backend's `tenant_session`). */
export const TENANT_SESSION_COOKIE = "tenant_session";

/**
 * Auth to attach to an upstream `/v1/ocr/*` call. In a multi-tenant deployment the
 * caller is a signed-in tenant, so we forward **their** `tenant_session` cookie —
 * the backend resolves it to that tenant, scoping usage/billing to them (never a
 * single shared key). `OCR_API_KEY` remains only as a **dev fallback** for a
 * keyless/`AUTH_ENABLED=false` setup or an unauthenticated probe.
 */
export const ocrForwardAuth = (req: NextRequest): Record<string, string> => {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (token) return { cookie: `${TENANT_SESSION_COOKIE}=${token}` };
  const key = process.env.OCR_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
};
