import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { http, unwrap, type MfaChallengeRequired } from "@heirs/api-client";
import { tenantKeys } from "./query-keys";
import type { TenantSession } from "@/types/user";

export interface TenantLoginPayload {
  email: string;
  password: string;
}

export interface TenantRegisterPayload {
  email: string;
  password: string;
  name: string;
  organizationName: string;
  planId: string;
}

export interface TenantVerificationPayload {
  email: string;
  otp: string;
}

/**
 * A password POST either signs the user in or stops at the second factor. The
 * union is deliberate: nothing may treat the MFA branch as a session, because on
 * that branch no cookie was set (see src/auth/mfa-challenge.ts on the backend).
 * Narrow it with `isMfaChallenge` from @heirs/api-client.
 */
export type TenantLoginResult = TenantSession | MfaChallengeRequired;

export interface TenantMfaPayload {
  challenge: string;
  code: string;
}

const ME_KEY = tenantKeys.me;

/** Current tenant session, via the tenant BFF proxy. `null` when unauthenticated (401). */
export function useTenantMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async (): Promise<TenantSession | null> => {
      try {
        return await http.get<TenantSession>("/api/tenant/me").then(unwrap);
      } catch {
        return null;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}

export function useTenantRegister() {
  return useMutation({
    mutationKey: ["tenant-auth", "register"],
    mutationFn: (payload: TenantRegisterPayload) =>
      http.post<TenantLoginResult>("/api/tenant/register", payload).then(unwrap),
  });
}

export function useTenantVerification() {
  return useMutation({
    mutationKey: ["tenant-auth", "verification"],
    mutationFn: (payload: TenantVerificationPayload) =>
      http.post<TenantLoginResult>("/api/tenant/verification", payload).then(unwrap),
  });
}

export function useTenantLogin() {
  const qc = useQueryClient();

  return useMutation({
    mutationKey: ["tenant-auth", "login"],
    mutationFn: (payload: TenantLoginPayload) =>
      http.post<TenantLoginResult>("/api/tenant/login", payload).then(unwrap),
    // Only seed the session cache on the branch that actually established one.
    onSuccess: (result) => {
      if (!("mfaRequired" in result)) qc.setQueryData(ME_KEY, result);
    },
  });
}

/** Redeems a login challenge for a real session with a TOTP or recovery code. */
export function useTenantLoginMfa() {
  const qc = useQueryClient();

  return useMutation({
    mutationKey: ["tenant-auth", "login-mfa"],
    mutationFn: (payload: TenantMfaPayload) => http.post<TenantSession>("/api/tenant/login/mfa", payload).then(unwrap),
    onSuccess: (session) => qc.setQueryData(ME_KEY, session),
  });
}

export function useTenantLogout() {
  const qc = useQueryClient();

  return useMutation({
    mutationKey: ["tenant-auth", "logout"],
    mutationFn: () => http.post("/api/tenant/logout", {}).then(unwrap),
    onSuccess: () => {
      // Drop every cached response, not just the session. The cache holds this org's
      // documents, keys, team and billing; leaving it in place means whoever signs in
      // next on this browser sees the previous account's data rendered from cache
      // before (or instead of) their own arriving.
      qc.clear();
      qc.setQueryData(ME_KEY, null);
    },
  });
}
