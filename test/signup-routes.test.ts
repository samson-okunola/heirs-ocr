import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "net";

/**
 * The self-serve sign-up routes as HTTP — the guard chain and the wire contract,
 * not the store's internals (those are test/signup.test.ts).
 *
 * What can only be seen from here: that `/api/plans`, `/api/register` and
 * `/api/verification` are reachable **without** a session, that a duplicate email is
 * answered identically to a fresh one, that a `hidden` plan cannot be self-selected,
 * and that redeeming a code really does mint the org, the subscription, the owner and
 * the cookie in one call. Each of those is a one-line mistake no unit test would see.
 *
 * The real router runs on a real express app over a loopback socket. Only the edges
 * are doubled: Postgres (pg-mem), Redis, the session store, the mailer and the audit
 * sink.
 */
const { query, resetDb, redisStore, fakeRedis, sent } = vi.hoisted(() => {
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
    CREATE TABLE IF NOT EXISTS plans (
      id text PRIMARY KEY,
      tier text NOT NULL,
      hidden boolean NOT NULL DEFAULT false,
      data jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
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

  const redisStore = new Map<string, string>();
  const fakeRedis = {
    get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      redisStore.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (...keys: string[]) => keys.filter((k) => redisStore.delete(k)).length),
    ttl: vi.fn(async (key: string) => (redisStore.has(key) ? 900 : -2)),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ping: vi.fn(async () => "PONG"),
  };

  /** Every verification email the routes send, so a test can read the code back. */
  const sent: { to: string; Otp: string; PlanName: string }[] = [];

  return { query, resetDb, redisStore, fakeRedis, sent };
});

vi.mock("../src/db", () => ({
  query,
  ensureSchema: async () => {},
  whenDbReady: async () => {},
  closeDb: async () => {},
}));
vi.mock("../src/redis", () => ({ getRedis: () => fakeRedis, whenRedisReady: async () => {} }));
vi.mock("../src/observability/audit", () => ({ recordAuditEvent: vi.fn(async () => {}) }));

// The mailer is the one edge that decides whether a signup can proceed at all: a
// send that fails must roll the pending record back, so it is doubled explicitly.
const mailResult = { value: { delivered: true } as { delivered: boolean; error?: string; skipped?: string } };
vi.mock("../src/notification/mail", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    sendVerifyEmail: vi.fn(async (r: { to: string }, a: { Otp: string; PlanName: string }) => {
      sent.push({ to: r.to, Otp: a.Otp, PlanName: a.PlanName });
      return mailResult.value;
    }),
    sendWelcomeEmail: vi.fn(async () => ({ delivered: true })),
  };
});

import express from "express";

import { tenantApiRouter, openApiRouter } from "../src/http/tenant/routes";
import { getTenantUserByEmail } from "../src/auth/tenant-users";
import { resolveSubscription } from "../src/billing/subscriptions";
import { listKeysForTenant } from "../src/auth/tenants";
import { putPlan } from "../src/billing/plan-store";
import { PLANS } from "../src/billing/plans";

const app = express();
app.use(express.json());
app.use("/api", openApiRouter);
app.use("/tenant", tenantApiRouter);

let server: ReturnType<typeof app.listen>;
let base = "";

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    }),
);

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

type Body = {
  error?: { code: string; message: string };
  items?: { id: string; name: string }[];
  total?: number;
  pending?: boolean;
  email?: string;
  apiKey?: string;
  tenantId?: string;
  role?: string;
  user?: { email: string; name: string };
};

const call = async (
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Body; setCookie: string[] }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Body,
    setCookie: res.headers.getSetCookie(),
  };
};

const FORM = {
  email: "ada@example.test",
  password: "correct horse battery staple",
  name: "Ada Okafor",
  organizationName: "Acme Documents",
  planId: "free_trial",
};

/** Runs register, then reads the code out of the email the route sent. */
const startSignup = async (over: Partial<typeof FORM> = {}) => {
  const res = await call("POST", "/api/register", { ...FORM, ...over });
  return { res, otp: sent[sent.length - 1]?.Otp };
};

beforeEach(async () => {
  await resetDb();
  redisStore.clear();
  sent.length = 0;
  mailResult.value = { delivered: true };
  // The catalog is DB-backed at runtime; seed the two plans these tests select from.
  await putPlan(PLANS.free_trial!);
  await putPlan(PLANS.enterprise!); // `hidden: true` in the seed catalog
});

describe("GET /api/plans", () => {
  it("is readable with no session — the register form needs it before anyone has one", async () => {
    const { status, body } = await call("GET", "/api/plans");
    expect(status).toBe(200);
    expect(body.items?.length).toBeGreaterThan(0);
  });

  it("hides plans that are not self-serve", async () => {
    const { body } = await call("GET", "/api/plans");
    const ids = body.items!.map((p) => p.id);
    expect(ids).toContain("free_trial");
    expect(ids).not.toContain("enterprise");
  });

  it("returns the paginated envelope the client expects", async () => {
    const { body } = await call("GET", "/api/plans?page=1&pageSize=1");
    expect(body).toMatchObject({ page: 1, pageSize: 1 });
    expect(body.items).toHaveLength(1);
  });
});

describe("POST /api/register", () => {
  it("accepts the form and creates nothing yet", async () => {
    const { res, otp } = await startSignup();
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ pending: true, email: FORM.email });
    expect(otp).toMatch(/^\d{6}$/);

    // The whole point of the two-step flow.
    expect(await getTenantUserByEmail(FORM.email)).toBeUndefined();
  });

  it("never returns the code over the wire", async () => {
    const { res, otp } = await startSignup();
    expect(JSON.stringify(res.body)).not.toContain(otp!);
  });

  it("refuses a plan that is not self-serve", async () => {
    const { res } = await startSignup({ planId: "enterprise" });
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toBe("Choose one of the available plans.");
  });

  it("refuses a plan that does not exist", async () => {
    const { res } = await startSignup({ planId: "no_such_plan" });
    expect(res.status).toBe(400);
  });

  it("enforces the password policy", async () => {
    const { res } = await startSignup({ password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_ARGS");
  });

  it("answers a taken email exactly as a fresh one, and sends nothing", async () => {
    const first = await startSignup();
    await call("POST", "/api/verification", { email: FORM.email, otp: first.otp });
    sent.length = 0;

    const again = await call("POST", "/api/register", FORM);
    expect(again.status).toBe(202);
    expect(again.body).toEqual({ pending: true, email: FORM.email, expiresInMinutes: 15 });
    // No mail: confirming the address would make this a membership oracle.
    expect(sent).toEqual([]);
  });

  it("rolls the pending signup back when the code could not be delivered", async () => {
    mailResult.value = { delivered: false, error: "smtp refused" };
    const { res } = await startSignup();
    expect(res.status).toBe(503);
    // Nothing left holding the address hostage for the next 15 minutes.
    expect(redisStore.size).toBe(0);
  });
});

describe("POST /api/verification", () => {
  it("creates the org, subscription, owner and session in one call", async () => {
    const { otp } = await startSignup();
    const { status, body, setCookie } = await call("POST", "/api/verification", { email: FORM.email, otp });

    expect(status).toBe(201);
    expect(body.user?.email).toBe(FORM.email);
    expect(body.role).toBe("owner");
    expect(body.apiKey).toMatch(/^hok_(test|live)_/);

    // Signed in on the spot — no second trip through the login form.
    expect(setCookie.join(";")).toContain("tenant_session=");

    const tenantId = body.tenantId!;
    expect(await listKeysForTenant(tenantId)).toHaveLength(1);
    expect(await resolveSubscription(tenantId)).toMatchObject({ status: "trialing" });
    expect(await getTenantUserByEmail(FORM.email)).toMatchObject({ role: "owner", tenantId });
  });

  it("rejects a wrong code without creating anything", async () => {
    await startSignup();
    const { status, body } = await call("POST", "/api/verification", { email: FORM.email, otp: "000000" });
    expect(status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHORIZED");
    expect(await getTenantUserByEmail(FORM.email)).toBeUndefined();
  });

  it("rejects a code for a signup that was never started", async () => {
    const { status } = await call("POST", "/api/verification", { email: "nobody@example.test", otp: "123456" });
    expect(status).toBe(401);
  });

  it("will not redeem the same code twice", async () => {
    const { otp } = await startSignup();
    expect((await call("POST", "/api/verification", { email: FORM.email, otp })).status).toBe(201);
    expect((await call("POST", "/api/verification", { email: FORM.email, otp })).status).toBe(401);
  });

  it("insists on a six-digit code", async () => {
    await startSignup();
    const { status, body } = await call("POST", "/api/verification", { email: FORM.email, otp: "12" });
    expect(status).toBe(400);
    expect(body.error?.message).toBe("Enter the 6-digit code from your email");
  });
});

describe("POST /api/verification/resend", () => {
  it("does not confirm whether a signup exists for the address", async () => {
    const { status, body } = await call("POST", "/api/verification/resend", { email: "nobody@example.test" });
    expect(status).toBe(202);
    expect(body).toMatchObject({ pending: true });
    expect(sent).toEqual([]);
  });

  it("refuses a second code inside the cooldown", async () => {
    await startSignup();
    const { status, body } = await call("POST", "/api/verification/resend", { email: FORM.email });
    expect(status).toBe(429);
    expect(body.error?.code).toBe("RATE_LIMITED");
  });
});
