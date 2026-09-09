import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Self-serve signup coverage.
 *
 * The pending-signup store (src/auth/signup.ts) is where the security of the whole
 * flow lives: nothing may be created before a code comes back, neither secret may be
 * held in the clear, and a six-digit code must not be brute-forceable. Those are the
 * properties asserted here, against a fake Redis that models TTLs — a store that
 * silently ignored `EX` would let every one of these tests pass while the real
 * signup leaked codes that never expire.
 *
 * `provisionTenant` runs against pg-mem so the three-store sequence (org → subscription
 * → owner) is exercised end to end rather than mocked into a tautology.
 */
const { query, resetDb, fakeRedis, store } = vi.hoisted(() => {
  const { newDb } = require("pg-mem") as typeof import("pg-mem");

  const DDL = `
    CREATE TABLE IF NOT EXISTS tenants (
      key_hash text PRIMARY KEY,
      tenant_id text NOT NULL,
      name text,
      disabled boolean NOT NULL DEFAULT false,
      rate_limit integer,
      allowed_origins jsonb,
      allowed_functions jsonb,
      expires_at timestamptz,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tenant_users (
      id uuid PRIMARY KEY,
      tenant_id text NOT NULL,
      email text NOT NULL UNIQUE,
      name text NOT NULL,
      role text NOT NULL,
      password_hash text NOT NULL,
      disabled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      tenant_id text PRIMARY KEY,
      plan_id text NOT NULL,
      status text NOT NULL,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `;

  let mem = newDb();
  let pool = new (mem.adapters.createPg().Pool)();

  const query = vi.fn((text: string, params?: unknown[]) => pool.query(text, params));
  const resetDb = async () => {
    mem = newDb();
    pool = new (mem.adapters.createPg().Pool)();
    mem.public.none(DDL);
    query.mockReset();
    query.mockImplementation((text: string, params?: unknown[]) => pool.query(text, params));
  };

  /** value + absolute expiry (ms), so `ttl` and `EX` behave like the real thing. */
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  // Reads the clock rather than a private counter, so `advance` below moves the
  // store's expiries and the module's own `Date.now()` together.
  const now = () => Date.now();

  const live = (key: string) => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };

  const fakeRedis = {
    get: vi.fn(async (key: string) => live(key)?.value ?? null),
    set: vi.fn(async (key: string, value: string, mode?: string, seconds?: number) => {
      const previous = live(key);
      const expiresAt =
        mode === "EX" && typeof seconds === "number"
          ? now() + seconds * 1000
          : mode === "KEEPTTL"
            ? (previous?.expiresAt ?? null)
            : null;
      store.set(key, { value, expiresAt });
      return "OK";
    }),
    ttl: vi.fn(async (key: string) => {
      const entry = live(key);
      if (!entry) return -2;
      if (entry.expiresAt === null) return -1;
      return Math.ceil((entry.expiresAt - now()) / 1000);
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    ping: vi.fn(async () => "PONG"),
  };

  return { query, resetDb, fakeRedis, store };
});

vi.mock("../src/db", () => ({
  query,
  ensureSchema: async () => {},
  whenDbReady: async () => {},
  closeDb: async () => {},
}));
vi.mock("../src/redis", () => ({ getRedis: () => fakeRedis, whenRedisReady: async () => {} }));

import {
  MAX_OTP_ATTEMPTS,
  RESEND_COOLDOWN_SECONDS,
  SIGNUP_TTL_SECONDS,
  checkOtp,
  discardSignup,
  peekSignup,
  resendOtp,
  startSignup,
} from "../src/auth/signup";
import { allocateTenantId, provisionTenant } from "../src/auth/tenant-provisioning";
import { getTenantUserByEmail, verifyPassword } from "../src/auth/tenant-users";
import { resolveSubscription } from "../src/billing/subscriptions";
import { listKeysForTenant } from "../src/auth/tenants";
import { PLANS } from "../src/billing/plans";

const SIGNUP = {
  email: "Ada@Example.Test",
  name: "Ada Okafor",
  organizationName: "Acme Documents",
  planId: "free_trial",
  password: "correct horse battery staple",
};

/**
 * Only `Date` is faked. Both the TTLs in the store above and the resend cooldown
 * read the wall clock, and argon2 resolves through real native callbacks that fake
 * timers would leave pending.
 */
const advance = (seconds: number): void => {
  vi.setSystemTime(Date.now() + seconds * 1000);
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  await resetDb();
  store.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pending signup store", () => {
  it("holds neither the password nor the code in the clear", async () => {
    const { otp } = await startSignup(SIGNUP);

    const raw = [...store.values()][0]!.value;
    expect(raw).not.toContain(SIGNUP.password);
    expect(raw).not.toContain(otp);

    const pending = await peekSignup(SIGNUP.email);
    expect(pending?.passwordHash).toMatch(/^\$argon2/);
    expect(pending?.otpHash).toMatch(/^\$argon2/);
  });

  it("normalizes the email so the code can be redeemed in any case", async () => {
    const { otp } = await startSignup(SIGNUP);
    expect((await peekSignup(SIGNUP.email))?.email).toBe("ada@example.test");

    const check = await checkOtp("ADA@example.TEST", otp);
    expect(check.ok).toBe(true);
  });

  it("issues a six-digit code and carries the form details through", async () => {
    const { otp, expiresAt } = await startSignup(SIGNUP);
    expect(otp).toMatch(/^\d{6}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const check = await checkOtp(SIGNUP.email, otp);
    expect(check).toMatchObject({
      ok: true,
      pending: { organizationName: "Acme Documents", planId: "free_trial", name: "Ada Okafor" },
    });
  });

  it("leaves the signup usable after a wrong code, so a typo is not fatal", async () => {
    const { otp } = await startSignup(SIGNUP);

    expect(await checkOtp(SIGNUP.email, "000000")).toEqual({ ok: false, reason: "invalid" });
    expect((await peekSignup(SIGNUP.email))?.attempts).toBe(1);
    expect((await checkOtp(SIGNUP.email, otp)).ok).toBe(true);
  });

  it("does not extend the window on a wrong code", async () => {
    await startSignup(SIGNUP);
    advance(SIGNUP_TTL_SECONDS - 60);

    await checkOtp(SIGNUP.email, "000000");
    // A guess every 14 minutes must not keep a pending signup alive indefinitely.
    expect(await fakeRedis.ttl([...store.keys()][0]!)).toBeLessThanOrEqual(60);
  });

  it("destroys the signup after too many wrong codes", async () => {
    const { otp } = await startSignup(SIGNUP);

    for (let i = 1; i < MAX_OTP_ATTEMPTS; i++) {
      expect(await checkOtp(SIGNUP.email, "000000")).toEqual({ ok: false, reason: "invalid" });
    }
    expect(await checkOtp(SIGNUP.email, "000000")).toEqual({ ok: false, reason: "locked" });

    // Even the correct code is worthless now — the record is gone.
    expect(await checkOtp(SIGNUP.email, otp)).toEqual({ ok: false, reason: "expired" });
    expect(await peekSignup(SIGNUP.email)).toBeUndefined();
  });

  it("expires the signup on its own", async () => {
    const { otp } = await startSignup(SIGNUP);
    advance(SIGNUP_TTL_SECONDS + 1);

    expect(await peekSignup(SIGNUP.email)).toBeUndefined();
    expect(await checkOtp(SIGNUP.email, otp)).toEqual({ ok: false, reason: "expired" });
  });

  it("replaces an earlier signup for the same email and retires its code", async () => {
    const first = await startSignup(SIGNUP);
    const second = await startSignup({ ...SIGNUP, organizationName: "Acme Docs Ltd" });

    expect(await checkOtp(SIGNUP.email, first.otp)).toEqual({ ok: false, reason: "invalid" });
    const check = await checkOtp(SIGNUP.email, second.otp);
    expect(check).toMatchObject({ ok: true, pending: { organizationName: "Acme Docs Ltd" } });
  });

  it("discards a signup outright", async () => {
    const { otp } = await startSignup(SIGNUP);
    await discardSignup(SIGNUP.email);
    expect(await checkOtp(SIGNUP.email, otp)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("resending a code", () => {
  it("refuses inside the cooldown", async () => {
    await startSignup(SIGNUP);
    const result = await resendOtp(SIGNUP.email);
    expect(result).toMatchObject({ ok: false, reason: "cooldown" });
  });

  it("issues a fresh code that retires the old one, and clears the attempt count", async () => {
    const first = await startSignup(SIGNUP);
    await checkOtp(SIGNUP.email, "000000");
    expect((await peekSignup(SIGNUP.email))?.attempts).toBe(1);

    advance(RESEND_COOLDOWN_SECONDS);
    const again = await resendOtp(SIGNUP.email);
    if (!again.ok) throw new Error("expected a resend");

    expect(again.otp).not.toBe(first.otp);
    expect(again.pending.attempts).toBe(0);
    expect(await checkOtp(SIGNUP.email, first.otp)).toEqual({ ok: false, reason: "invalid" });
    expect((await checkOtp(SIGNUP.email, again.otp)).ok).toBe(true);
  });

  it("reports nothing to resend once the signup has gone", async () => {
    expect(await resendOtp("nobody@example.test")).toEqual({ ok: false, reason: "expired" });
  });
});

describe("tenant id allocation", () => {
  it("derives a readable slug from the organisation name", async () => {
    expect(await allocateTenantId("Acme Documents Ltd.")).toMatch(/^acme-documents-ltd-[0-9a-f]{6}$/);
  });

  it("falls back rather than producing an empty id", async () => {
    expect(await allocateTenantId("!!!")).toMatch(/^org-[0-9a-f]{6}$/);
  });

  it("does not collide when the same organisation name signs up twice", async () => {
    const a = await allocateTenantId("Acme");
    const b = await allocateTenantId("Acme");
    expect(a).not.toBe(b);
  });
});

describe("provisioning a self-serve tenant", () => {
  it("creates the org, its subscription and an owner who can sign in", async () => {
    const { otp } = await startSignup(SIGNUP);
    const check = await checkOtp(SIGNUP.email, otp);
    if (!check.ok) throw new Error("expected a valid code");

    const { tenant, apiKey, user } = await provisionTenant({
      organizationName: check.pending.organizationName,
      plan: PLANS.free_trial!,
      owner: { email: check.pending.email, name: check.pending.name, passwordHash: check.pending.passwordHash },
    });

    expect(apiKey).toMatch(/^hok_(test|live)_/);
    expect(await listKeysForTenant(tenant.tenantId)).toHaveLength(1);

    const subscription = await resolveSubscription(tenant.tenantId);
    expect(subscription).toMatchObject({ tenantId: tenant.tenantId, status: "trialing" });
    expect(subscription?.plan.id).toBe("free_trial");

    expect(user).toMatchObject({ role: "owner", email: "ada@example.test", tenantId: tenant.tenantId });

    // The hash travelled from the pending record intact — the password chosen at
    // register time is the one that signs in.
    const stored = await getTenantUserByEmail(SIGNUP.email);
    expect(stored).toBeDefined();
    expect(await verifyPassword(stored!, SIGNUP.password)).toBe(true);
    expect(await verifyPassword(stored!, "wrong password")).toBe(false);
  });
});
