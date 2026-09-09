import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";

import {
  resolveSubscription,
  SubscriptionStoreUnavailableError,
  toEffectiveSubscription,
} from "../../billing/subscriptions";
import { clearLoginFailures, loginAllowed, recordLoginFailure } from "../../auth/login-throttle";
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  listSessions,
  revokeOtherSessions,
} from "../../auth/tenant-session";
import { consumeChallenge, createChallenge, peekChallenge } from "../../auth/mfa-challenge";
import { recordAuditEvent } from "../../observability/audit";
import { personLabel } from "../../observability/audit-labels";
import {
  beginEnrolment,
  confirmEnrolment,
  disableMfa,
  getMfaStatus,
  isMfaEnabled,
  MfaAlreadyEnabledError,
  regenerateRecoveryCodes,
  verifyMfa,
} from "../../auth/mfa";
import { requireTenantRole, tenantAuth } from "../middleware/tenant-auth";
import { getTenantUsage } from "../../observability/usage";
import { getDocumentById, getDocumentReport, listDocumentsPage } from "../../observability/documents";
import {
  MAX_ENDPOINTS_PER_TENANT,
  countEndpoints,
  createEndpoint,
  deleteEndpoint,
  enqueueDelivery,
  getEndpoint,
  listDeliveriesPage,
  listEndpoints,
  rotateSecret,
  updateEndpoint,
} from "../../webhooks/store";
import { UnsafeWebhookUrlError, assertSafeWebhookUrl } from "../../webhooks/url-guard";
import { requireTenantFeature } from "../middleware/require-tenant-feature";
import { WEBHOOK_EVENTS } from "../../webhooks/events";
import { listRequestLogsPage } from "../../observability/request-log";
import { assertPasswordPolicy } from "../../auth/password-policy";
import { buildTenantExport, getTenantExportSummary } from "../../ops/tenant-export";
import { randomUUID } from "crypto";
import { presignDownload } from "../../storage/blob";
import { env } from "../../config/env";
import { pageParams, paginate, paginatedFrom } from "../pagination";
import { getSettings } from "../../config/settings-store";
import { getTenantSettings, putTenantSettings } from "../../config/tenant-settings";
import { isIpAllowed } from "../../auth/ip-allowlist";
import { parseCookies } from "../middleware/admin-auth";
import { logger } from "../../observability/logger";
import type { TenantUser } from "../../types/user";
import { ocrQueue } from "../../jobs/queue";
import { subscribeToJobEvents } from "../../jobs/events";
import {
  countOwners,
  createTenantUser,
  deleteTenantUser,
  getTenantUserByEmail,
  getTenantUserById,
  listTenantUsers,
  updateTenantUser,
  verifyPassword,
} from "../../auth/tenant-users";
import {
  generateApiKey,
  hashApiKey,
  listKeysForTenant,
  putTenant,
  revokeByHash,
  type Tenant,
} from "../../auth/tenants";
import {
  MAX_OTP_ATTEMPTS,
  RESEND_COOLDOWN_SECONDS,
  SIGNUP_TTL_SECONDS,
  checkOtp,
  discardSignup,
  resendOtp,
  startSignup,
} from "../../auth/signup";
import { appUrl, sendVerifyEmail, sendWelcomeEmail, type SendMailResult } from "../../notification/mail";
import { provisionTenant } from "../../auth/tenant-provisioning";
import { getStoredPlan, listPlans } from "../../billing/plan-store";
import type { SubscriptionPlan } from "../../types/subscription";

/**
 * Tenant portal JSON API, mounted under `/tenant` (paths here start with `/api`).
 * The tenant-side twin of the admin console (src/http/admin/routes.ts):
 * `POST /api/login` is the only open route; everything else requires a session
 * (`tenantAuth`) and, for management, `owner` role (`requireTenantRole`).
 *
 * Every route is scoped to the caller's own tenant org (`req.tenantUser.tenantId`) —
 * a tenant can never read or mutate another org's keys or users.
 */
export const tenantApiRouter = Router();
export const openApiRouter = Router();

const TENANT_ROLE = z.enum(["owner", "member"]);

const sendError = (res: Response, status: number, code: string, message: string): void => {
  res.status(status).json({ error: { code, message } });
};

/** Wraps an async handler so a thrown error becomes a 500 JSON instead of a hang. */
const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch((err) => {
      logger.error("tenant route failed", { path: req.path, err: err instanceof Error ? err.message : String(err) });
      if (res.headersSent) {
        next(err);
        return;
      }
      sendError(res, 500, "INTERNAL", "Unexpected error");
    });
  };

/** See the admin console's note: `secure` from the actual request scheme, not NODE_ENV. */
const isHttpsRequest = (req: Request): boolean =>
  req.secure || (req.get("x-forwarded-proto") ?? "").split(",")[0]!.trim().toLowerCase() === "https";

/**
 * httpOnly session cookie for the portal. Scoped to `Path=/` (not `/tenant`) because
 * the same session also authenticates in-app OCR at `/v1/ocr/*` — the OCR auth
 * middleware reads this cookie when no API key is present.
 */
const setSessionCookie = (req: Request, res: Response, token: string, ttlSeconds: number): void => {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: isHttpsRequest(req),
    path: "/",
    maxAge: ttlSeconds * 1000,
  });
};

// ── Auth ────────────────────────────────────────────────────────────────────

/**
 * Provenance recorded against a new session, so the security page can show a person
 * *which* sign-ins are live rather than an anonymous count. Both fields are
 * self-reported by the client — useful for recognising your own devices, not
 * evidence of anything.
 */
const sessionContext = (req: Request): { ip?: string; userAgent?: string } => ({
  ip: req.ip,
  // Bounded: a user-agent is attacker-controlled and lands in a Redis value.
  userAgent: req.get("user-agent")?.slice(0, 200),
});

const loginSchema = z.object({ email: z.string().min(1), password: z.string().min(1) });

openApiRouter.post(
  "/login",
  handler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", "email and password are required");
      return;
    }

    const ip = req.ip ?? "unknown";
    const email = parsed.data.email;

    // Brute-force throttle, scoped to the tenant surface so it can't lock out admins.
    if (!(await loginAllowed("tenant", ip, email))) {
      logger.warn("tenant.login.throttled", { email, ip });
      sendError(res, 429, "RATE_LIMITED", "Too many failed attempts. Try again later.");
      return;
    }

    let user, session;
    try {
      user = await getTenantUserByEmail(email);

      // IP restriction is checked *before* the password, so a denial cannot double as
      // an oracle for whether the password was right. An unknown email has no org and
      // therefore no allowlist to apply — it falls through to the same 401 as always.
      if (user) {
        const settings = await getTenantSettings(user.tenantId);
        if (settings.ipAllowlistEnabled && !isIpAllowed(ip, settings.ipAllowlist)) {
          logger.warn("tenant.login.ip_denied", { email, ip, tenantId: user.tenantId });
          sendError(res, 403, "FORBIDDEN", "Sign-in is not permitted from this network");
          return;
        }
      }

      // Same response whether the email is unknown or the password is wrong.
      if (!user || !(await verifyPassword(user, parsed.data.password))) {
        await recordLoginFailure("tenant", ip, email);
        logger.warn("tenant.login.failed", { email, ip });
        sendError(res, 401, "UNAUTHORIZED", "Invalid email or password");
        return;
      }
      // Enrolled accounts stop here with a challenge instead of a session — the
      // cookie is only minted once the second factor lands (src/auth/mfa-challenge.ts).
      if (await isMfaEnabled("tenant_users", user.id)) {
        const challenge = await createChallenge("tenant", { userId: user.id, email: user.email });
        await clearLoginFailures("tenant", ip, email);
        logger.info("tenant.login.mfa_required", { userId: user.id, tenantId: user.tenantId, email: user.email, ip });
        res.json({ mfaRequired: true, challenge });
        return;
      }
      session = await createSession(user.id, user.tenantId, user.role, sessionContext(req));
    } catch (err) {
      logger.error("tenant login: store unavailable", { err: err instanceof Error ? err.message : String(err) });
      sendError(res, 503, "PROVIDER_UNAVAILABLE", "Authentication store unavailable");
      return;
    }

    await clearLoginFailures("tenant", ip, email);
    setSessionCookie(req, res, session.token, session.ttl);
    logger.info("tenant.login", { userId: user.id, tenantId: user.tenantId, email: user.email, ip });
    res.json({ user: publicUser(user), tenantId: user.tenantId, role: user.role });
  }),
);

// ── Second factor ─────────────────────────────────────────────────────────────
// The tenant-side twin of the admin console's MFA routes (src/http/admin/routes.ts).

const mfaLoginSchema = z.object({ challenge: z.string().min(1), code: z.string().min(1) });

openApiRouter.post(
  "/login/mfa",
  handler(async (req, res) => {
    const parsed = mfaLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", "challenge and code are required");
      return;
    }

    const ip = req.ip ?? "unknown";
    const pending = await peekChallenge("tenant", parsed.data.challenge);
    if (!pending) {
      // Expired, already spent, or forged — indistinguishable to the caller.
      sendError(res, 401, "UNAUTHORIZED", "Login session expired. Sign in again.");
      return;
    }

    // A six-digit code is guessable in a way the password is not, so failures count
    // against the same throttle buckets.
    if (!(await loginAllowed("tenant", ip, pending.email))) {
      logger.warn("tenant.login.mfa.throttled", { email: pending.email, ip });
      sendError(res, 429, "RATE_LIMITED", "Too many failed attempts. Try again later.");
      return;
    }

    let session, user;
    try {
      const factor = await verifyMfa("tenant_users", pending.userId, parsed.data.code);
      if (!factor) {
        await recordLoginFailure("tenant", ip, pending.email);
        logger.warn("tenant.login.mfa.failed", { userId: pending.userId, email: pending.email, ip });
        sendError(res, 401, "UNAUTHORIZED", "Invalid verification code");
        return;
      }

      user = await getTenantUserById(pending.userId);
      // Disabled or deleted between the two steps — the challenge must not outlive it.
      if (!user || user.disabled) {
        await consumeChallenge("tenant", parsed.data.challenge);
        sendError(res, 401, "UNAUTHORIZED", "Invalid email or password");
        return;
      }

      await consumeChallenge("tenant", parsed.data.challenge);
      session = await createSession(user.id, user.tenantId, user.role, sessionContext(req));
      logger.info("tenant.login", { userId: user.id, tenantId: user.tenantId, email: user.email, ip, factor });
    } catch (err) {
      logger.error("tenant mfa: store unavailable", { err: err instanceof Error ? err.message : String(err) });
      sendError(res, 503, "PROVIDER_UNAVAILABLE", "Authentication store unavailable");
      return;
    }

    await clearLoginFailures("tenant", ip, pending.email);
    setSessionCookie(req, res, session.token, session.ttl);
    res.json({ user: publicUser(user), tenantId: user.tenantId, role: user.role });
  }),
);

// ── Self-serve signup ─────────────────────────────────────────────────────────
//
// Three open routes turn a stranger into an organisation:
//
//   GET  /api/plans          the plans a person may pick from
//   POST /api/register       hold the details, mail a code — nothing is created yet
//   POST /api/verification   code accepted → org + subscription + owner + session
//
// Nothing reaches Postgres until the code comes back (src/auth/signup.ts explains
// why), so an abandoned form leaves nothing behind and no one can claim an
// organisation under an address they cannot read.

/** Cheapest tier first, so the free option leads on a signup form. */
const TIER_ORDER = ["trial", "payg", "starter", "business", "enterprise"];

const selfServePlans = async (): Promise<SubscriptionPlan[]> =>
  (await listPlans())
    .filter((plan) => !plan.hidden)
    .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));

/**
 * The plan catalog as a signup form needs it: open, because it is read *before*
 * anyone has an account. Only `hidden: false` plans appear — bespoke enterprise
 * deals are assigned by an operator, never self-selected.
 */
openApiRouter.get(
  "/plans",
  handler(async (req, res) => {
    res.json(paginate(await selfServePlans(), pageParams(req.query)));
  }),
);

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  name: z.string().min(1).max(120),
  organizationName: z.string().min(1).max(120),
  planId: z.string().min(1),
});

/** Minutes, for the copy in the verification email. */
const SIGNUP_TTL_MINUTES = Math.round(SIGNUP_TTL_SECONDS / 60);

/** Formatted for a reader, not a parser — the mail layer interpolates values verbatim. */
const formatInstant = (date: Date): string =>
  new Intl.DateTimeFormat("en-NG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Lagos" }).format(date);

/** First name for a greeting; the form asks for a full name. */
const firstNameOf = (name: string): string => name.trim().split(/\s+/)[0] || name;

/**
 * A send that was attempted and failed (as opposed to one skipped because mail is
 * switched off) leaves the user waiting for a code that will never arrive, so the
 * route answers 503 and invites a retry rather than a cheerful 202.
 */
const undelivered = (result: SendMailResult): boolean => !result.delivered && !result.skipped;

/**
 * In a deployment with no mailer configured there is no way to finish a signup at
 * all, which makes local development impossible. Log the code instead — but only
 * outside production, where a code in the log stream would be a real credential leak.
 */
const logOtpForDevelopment = (email: string, otp: string): void => {
  if (env.NODE_ENV === "production") return;
  logger.warn("signup.otp.logged", { email, otp, reason: "MAIL_ENABLED is false" });
};

openApiRouter.post(
  "/register",
  handler(async (req, res) => {
    if (env.SELF_SIGNUP_ENABLED !== "true") {
      sendError(res, 403, "FORBIDDEN", "Self-service signup is closed. Contact us to have an account created.");
      return;
    }

    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", parsed.error.issues[0]?.message ?? "Invalid registration");
      return;
    }

    const ip = req.ip ?? "unknown";
    const { email, name, organizationName, planId } = parsed.data;

    // The signup buckets are scoped away from `tenant`, so a spray here can't lock
    // anyone out of signing in. Every attempt counts, not just failures: this endpoint
    // sends mail to an address the caller names, and that is worth capping outright.
    if (!(await loginAllowed("signup", ip, email))) {
      logger.warn("signup.throttled", { email, ip });
      sendError(res, 429, "RATE_LIMITED", "Too many attempts. Try again later.");
      return;
    }
    await recordLoginFailure("signup", ip, email);

    try {
      await assertPasswordPolicy(parsed.data.password);
    } catch (err) {
      sendError(res, 400, "INVALID_ARGS", err instanceof Error ? err.message : "Password does not meet policy");
      return;
    }

    // Checked here so a bad plan id is a form error rather than a failure 15 minutes
    // later, at the point where the code is redeemed. Re-checked there too, since the
    // catalog can change in between.
    const plan = await getStoredPlan(planId);
    if (!plan || plan.hidden) {
      sendError(res, 400, "INVALID_ARGS", "Choose one of the available plans.");
      return;
    }

    // An address that already has an account gets the same 202 and no email. Saying
    // "that email is taken" would turn this endpoint into a membership oracle for
    // every address someone cares to try; the person who owns the mailbox is the one
    // who is allowed to know, and they can find out by signing in or resetting.
    const taken = await getTenantUserByEmail(email);
    if (taken) {
      logger.info("signup.duplicate_email", { email, ip });
      res.status(202).json({ pending: true, email, expiresInMinutes: SIGNUP_TTL_MINUTES });
      return;
    }

    const { otp, expiresAt } = await startSignup({ ...parsed.data, email });

    const sent = await sendVerifyEmail(
      { to: email, firstName: firstNameOf(name), tenantName: organizationName },
      {
        Email: email,
        ExpiresAt: formatInstant(expiresAt),
        ExpiryMinutes: SIGNUP_TTL_MINUTES,
        Otp: otp,
        PlanName: plan.name,
        RequestIp: ip,
        VerifyUrl: appUrl(`/verification?email=${encodeURIComponent(email)}`),
      },
    );
    if (undelivered(sent)) {
      // Don't leave a pending signup nobody can complete sitting on the address.
      await discardSignup(email);
      logger.error("signup.mail_failed", { email, ip });
      sendError(res, 503, "PROVIDER_UNAVAILABLE", "Could not send the verification email. Please try again.");
      return;
    }
    if (sent.skipped) logOtpForDevelopment(email, otp);

    logger.info("signup.started", { email, ip, planId, organizationName });
    res.status(202).json({ pending: true, email, expiresInMinutes: SIGNUP_TTL_MINUTES });
  }),
);

const verificationSchema = z.object({
  email: z.string().email(),
  otp: z.string().regex(/^\d{6}$/, "Enter the 6-digit code from your email"),
});

/**
 * Redeems a code. This is the only place a self-serve organisation is created, and
 * it signs the new owner straight in — sending someone who has just proved they own
 * the mailbox back to a login form is friction with no security value.
 */
openApiRouter.post(
  "/verification",
  handler(async (req, res) => {
    if (env.SELF_SIGNUP_ENABLED !== "true") {
      sendError(res, 403, "FORBIDDEN", "Self-service signup is closed.");
      return;
    }

    const parsed = verificationSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", parsed.error.issues[0]?.message ?? "Invalid verification");
      return;
    }

    const ip = req.ip ?? "unknown";
    const { email, otp } = parsed.data;

    if (!(await loginAllowed("signup", ip, email))) {
      logger.warn("signup.verify.throttled", { email, ip });
      sendError(res, 429, "RATE_LIMITED", "Too many attempts. Try again later.");
      return;
    }

    const check = await checkOtp(email, otp);
    if (!check.ok) {
      await recordLoginFailure("signup", ip, email);
      logger.warn("signup.verify.failed", { email, ip, reason: check.reason });
      if (check.reason === "locked") {
        sendError(res, 429, "RATE_LIMITED", "Too many wrong codes. Start the signup again.");
        return;
      }
      if (check.reason === "expired") {
        sendError(res, 401, "UNAUTHORIZED", "That code has expired. Start the signup again.");
        return;
      }
      sendError(res, 401, "UNAUTHORIZED", `That code is not right. ${MAX_OTP_ATTEMPTS} tries are allowed per code.`);
      return;
    }

    const pending = check.pending;

    // Both of these were true when the form was submitted and are re-checked because
    // fifteen minutes is long enough for either to change.
    if (await getTenantUserByEmail(pending.email)) {
      await discardSignup(pending.email);
      sendError(res, 409, "CONFLICT", "An account already exists for this email. Sign in instead.");
      return;
    }
    const plan = await getStoredPlan(pending.planId);
    if (!plan || plan.hidden) {
      await discardSignup(pending.email);
      sendError(res, 409, "CONFLICT", "That plan is no longer available. Start the signup again.");
      return;
    }

    let provisioned, session;
    try {
      provisioned = await provisionTenant({
        organizationName: pending.organizationName,
        plan,
        owner: { email: pending.email, name: pending.name, passwordHash: pending.passwordHash },
      });
      session = await createSession(
        provisioned.user.id,
        provisioned.user.tenantId,
        provisioned.user.role,
        sessionContext(req),
      );
    } catch (err) {
      logger.error("signup.provision_failed", {
        email: pending.email,
        err: err instanceof Error ? err.message : String(err),
      });
      sendError(res, 503, "PROVIDER_UNAVAILABLE", "Could not finish creating your workspace. Please try again.");
      return;
    }

    // Only now is the code spent. Discarding it before provisioning would strand
    // anyone whose org creation failed with no way back in.
    await discardSignup(pending.email);
    await clearLoginFailures("signup", ip, pending.email);

    const { tenant, user, apiKey } = provisioned;
    setSessionCookie(req, res, session.token, session.ttl);

    await recordAuditEvent({
      action: "tenant.self_registered",
      actor: user.id,
      actorLabel: personLabel(user),
      target: tenant.tenantId,
      targetLabel: pending.organizationName,
      metadata: { planId: plan.id, planName: plan.name, ip },
    });

    // Best-effort: the workspace exists either way, and a missing welcome email is
    // not a reason to fail a signup that has already succeeded.
    const limits = plan.entitlements.limits;
    void sendWelcomeEmail(
      { to: user.email, firstName: firstNameOf(user.name), tenantName: pending.organizationName },
      {
        ApiBaseUrl: env.API_BASE_URL,
        DataRetentionDays: limits.dataRetentionDays,
        DocumentsIncluded: limits.documentsPerPeriod ?? "Unlimited",
        PlanName: plan.name,
        RateLimitPerMinute: limits.rateLimitPerMinute ?? "Unlimited",
      },
    ).catch(() => undefined);

    logger.info("signup.completed", { email: user.email, tenantId: tenant.tenantId, planId: plan.id, ip });

    // The raw key rides along on this one response and is never recoverable again —
    // same contract as the admin console's tenant-creation endpoint.
    res.status(201).json({ user: publicUser(user), tenantId: user.tenantId, role: user.role, apiKey });
  }),
);

const resendSchema = z.object({ email: z.string().email() });

/** A fresh code for a signup already in flight. Cooldown-limited in the store. */
openApiRouter.post(
  "/verification/resend",
  handler(async (req, res) => {
    const parsed = resendSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", "A valid email is required");
      return;
    }

    const ip = req.ip ?? "unknown";
    const email = parsed.data.email;

    if (!(await loginAllowed("signup", ip, email))) {
      sendError(res, 429, "RATE_LIMITED", "Too many attempts. Try again later.");
      return;
    }
    await recordLoginFailure("signup", ip, email);

    const result = await resendOtp(email);
    if (!result.ok) {
      if (result.reason === "cooldown") {
        res.setHeader("Retry-After", String(result.retryAfterSeconds ?? RESEND_COOLDOWN_SECONDS));
        sendError(
          res,
          429,
          "RATE_LIMITED",
          `Wait ${result.retryAfterSeconds ?? RESEND_COOLDOWN_SECONDS}s before asking for another code.`,
        );
        return;
      }
      // No pending signup — same shape as success, for the same non-enumeration
      // reason as `/api/register`.
      res.status(202).json({ pending: true, email, expiresInMinutes: SIGNUP_TTL_MINUTES });
      return;
    }

    const plan = await getStoredPlan(result.pending.planId);
    const sent = await sendVerifyEmail(
      { to: email, firstName: firstNameOf(result.pending.name), tenantName: result.pending.organizationName },
      {
        Email: email,
        ExpiresAt: formatInstant(result.expiresAt),
        ExpiryMinutes: SIGNUP_TTL_MINUTES,
        Otp: result.otp,
        PlanName: plan?.name ?? result.pending.planId,
        RequestIp: ip,
        VerifyUrl: appUrl(`/verification?email=${encodeURIComponent(email)}`),
      },
    );
    if (undelivered(sent)) {
      sendError(res, 503, "PROVIDER_UNAVAILABLE", "Could not send the verification email. Please try again.");
      return;
    }
    if (sent.skipped) logOtpForDevelopment(email, result.otp);

    res.status(202).json({ pending: true, email, expiresInMinutes: SIGNUP_TTL_MINUTES });
  }),
);

// ── Password ──────────────────────────────────────────────────────────────────

const changePasswordSchema = z.object({
  current: z.string().min(1),
  next: z.string().min(1),
});

/**
 * Self-service password change.
 *
 * Three things beyond writing the new hash:
 *
 *  - **The current password is required.** A session alone must not be enough to
 *    change it, or a hijacked session becomes a permanent takeover by locking the
 *    real owner out.
 *  - **Failures count against the login throttle.** This endpoint verifies a
 *    credential, so without that it is a rate-limit-free oracle for guessing the
 *    current password from inside a stolen session.
 *  - **Every other session is revoked.** Someone changing their password usually
 *    believes they are compromised; leaving the attacker's session alive would defeat
 *    the entire point of the change.
 */
tenantApiRouter.post(
  "/api/security/password",
  tenantAuth,
  handler(async (req, res) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", "current and next are required");
      return;
    }

    const ip = req.ip ?? "unknown";
    const user = await getTenantUserById(req.tenantUser!.userId);
    if (!user) {
      sendError(res, 401, "UNAUTHORIZED", "Account no longer exists");
      return;
    }

    if (!(await loginAllowed("tenant", ip, user.email))) {
      sendError(res, 429, "RATE_LIMITED", "Too many failed attempts. Try again later.");
      return;
    }

    if (!(await verifyPassword(user, parsed.data.current))) {
      await recordLoginFailure("tenant", ip, user.email);
      logger.warn("tenant.password.change_failed", { userId: user.id, tenantId: user.tenantId, ip });
      sendError(res, 401, "UNAUTHORIZED", "Current password is incorrect");
      return;
    }

    if (parsed.data.next === parsed.data.current) {
      sendError(res, 400, "INVALID_ARGS", "New password must be different from the current one");
      return;
    }

    try {
      await assertPasswordPolicy(parsed.data.next);
    } catch (err) {
      sendError(res, 400, "INVALID_ARGS", err instanceof Error ? err.message : "Password does not meet policy");
      return;
    }

    await updateTenantUser(user.tenantId, user.id, { password: parsed.data.next }, user.id);
    await clearLoginFailures("tenant", ip, user.email);

    // Keep the caller signed in; drop everyone else claiming to be them.
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const revoked = await revokeOtherSessions(user.id, token);

    await recordAuditEvent({
      action: "tenant.password.changed",
      actor: user.id,
      actorLabel: personLabel(user),
      target: user.tenantId,
      targetLabel: user.tenantId,
      metadata: { sessionsRevoked: revoked },
    });
    res.json({ ok: true, sessionsRevoked: revoked });
  }),
);

// ── Active sessions ───────────────────────────────────────────────────────────

/** Live sessions for the signed-in tenant user. Tokens are never returned. */
tenantApiRouter.get(
  "/api/security/sessions",
  tenantAuth,
  handler(async (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    res.json({ sessions: await listSessions(req.tenantUser!.userId, token) });
  }),
);

/**
 * Signs the account out everywhere else, keeping the session making the request.
 *
 * Deliberately "all others" rather than per-session revocation: someone reaching for
 * this has lost a device or suspects a compromise, and picking the right row off a
 * list of IP addresses is exactly the judgement they cannot reliably make.
 */
tenantApiRouter.delete(
  "/api/security/sessions",
  tenantAuth,
  handler(async (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const revoked = await revokeOtherSessions(req.tenantUser!.userId, token);
    await recordAuditEvent({
      action: "tenant.sessions.revoked",
      actor: req.tenantUser!.userId,
      actorLabel: req.tenantUser!.label,
      target: req.tenantUser!.tenantId,
      metadata: { revoked },
    });
    res.json({ revoked });
  }),
);

// ── IP allowlist (owner only) ─────────────────────────────────────────────────
// Restricts where a portal session may be *established*. Owner-only because it can
// lock the whole org out of the portal.

tenantApiRouter.get(
  "/api/security/ip-allowlist",
  tenantAuth,
  requireTenantRole("owner"),
  handler(async (req, res) => {
    res.json(await getTenantSettings(req.tenantUser!.tenantId));
  }),
);

const ipAllowlistSchema = z.object({
  ipAllowlistEnabled: z.boolean(),
  ipAllowlist: z.array(z.string().min(1)),
});

tenantApiRouter.put(
  "/api/security/ip-allowlist",
  tenantAuth,
  requireTenantRole("owner"),
  handler(async (req, res) => {
    const parsed = ipAllowlistSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", "ipAllowlistEnabled and ipAllowlist are required");
      return;
    }

    const tenantId = req.tenantUser!.tenantId;
    const entries = parsed.data.ipAllowlist.map((e) => e.trim()).filter(Boolean);

    // Refuse a rule set that would lock the caller out of their own portal. The
    // entries are already validated for syntax by the schema; this catches the
    // subtler mistake of a *valid* range that simply does not include you.
    if (parsed.data.ipAllowlistEnabled && entries.length > 0 && !isIpAllowed(req.ip, entries)) {
      sendError(
        res,
        400,
        "INVALID_ARGS",
        `This list would block your own address (${req.ip ?? "unknown"}). Add it before enabling.`,
      );
      return;
    }

    try {
      const settings = await putTenantSettings(tenantId, {
        ipAllowlistEnabled: parsed.data.ipAllowlistEnabled,
        ipAllowlist: entries,
      });
      await recordAuditEvent({
        action: "tenant.ip_allowlist.updated",
        actor: req.tenantUser!.userId,
        actorLabel: req.tenantUser!.label,
        target: tenantId,
        targetLabel: tenantId,
        metadata: { enabled: settings.ipAllowlistEnabled, entries: settings.ipAllowlist.length },
      });
      res.json(settings);
    } catch (err) {
      // A schema rejection here is a malformed CIDR the client should fix, not a 500.
      sendError(res, 400, "INVALID_ARGS", err instanceof Error ? err.message : "Invalid allowlist");
    }
  }),
);

tenantApiRouter.get(
  "/api/security/mfa",
  tenantAuth,
  handler(async (req, res) => {
    const status = await getMfaStatus("tenant_users", req.tenantUser!.userId);
    if (!status) {
      sendError(res, 401, "UNAUTHORIZED", "Account no longer exists");
      return;
    }
    res.json(status);
  }),
);

tenantApiRouter.post(
  "/api/security/mfa",
  tenantAuth,
  handler(async (req, res) => {
    const user = await getTenantUserById(req.tenantUser!.userId);
    if (!user) {
      sendError(res, 401, "UNAUTHORIZED", "Account no longer exists");
      return;
    }
    try {
      res.json(await beginEnrolment("tenant_users", user.id, user.email));
    } catch (err) {
      if (err instanceof MfaAlreadyEnabledError) {
        sendError(res, 409, "CONFLICT", err.message);
        return;
      }
      throw err;
    }
  }),
);

const mfaCodeSchema = z.object({ code: z.string().min(1) });

tenantApiRouter.post(
  "/api/security/mfa/verify",
  tenantAuth,
  handler(async (req, res) => {
    const parsed = mfaCodeSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", "code is required");
      return;
    }

    const result = await confirmEnrolment("tenant_users", req.tenantUser!.userId, parsed.data.code);
    if (!result.ok) {
      sendError(res, 400, "INVALID_ARGS", "Invalid verification code");
      return;
    }

    await recordAuditEvent({
      action: "tenant.mfa.enabled",
      actor: req.tenantUser!.userId,
      actorLabel: req.tenantUser!.label,
      target: req.tenantUser!.tenantId,
      targetLabel: req.tenantUser!.tenantId,
    });
    // The plaintext codes exist only in this response — only their hashes are stored.
    res.json({ enabled: true, recoveryCodes: result.recoveryCodes });
  }),
);

/** Password re-check: a hijacked session must not be able to strip the account back
 *  to a single factor. Same reasoning as the console's disable route. */
const mfaPasswordSchema = z.object({ password: z.string().min(1) });

tenantApiRouter.delete(
  "/api/security/mfa",
  tenantAuth,
  handler(async (req, res) => {
    const parsed = mfaPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", "password is required");
      return;
    }

    const user = await getTenantUserById(req.tenantUser!.userId);
    if (!user || !(await verifyPassword(user, parsed.data.password))) {
      sendError(res, 401, "UNAUTHORIZED", "Invalid password");
      return;
    }

    await disableMfa("tenant_users", user.id);
    await recordAuditEvent({
      action: "tenant.mfa.disabled",
      actor: user.id,
      actorLabel: personLabel(user),
      target: user.tenantId,
      targetLabel: user.tenantId,
    });
    res.json({ enabled: false });
  }),
);

tenantApiRouter.post(
  "/api/security/mfa/recovery-codes",
  tenantAuth,
  handler(async (req, res) => {
    const parsed = mfaPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", "password is required");
      return;
    }

    const user = await getTenantUserById(req.tenantUser!.userId);
    if (!user || !(await verifyPassword(user, parsed.data.password))) {
      sendError(res, 401, "UNAUTHORIZED", "Invalid password");
      return;
    }

    const recoveryCodes = await regenerateRecoveryCodes("tenant_users", user.id);
    if (!recoveryCodes) {
      sendError(res, 409, "CONFLICT", "Two-factor authentication is not enabled");
      return;
    }
    await recordAuditEvent({
      action: "tenant.mfa.recovery_codes_regenerated",
      actor: user.id,
      actorLabel: personLabel(user),
      target: user.tenantId,
      targetLabel: user.tenantId,
    });
    res.json({ recoveryCodes });
  }),
);

tenantApiRouter.post(
  "/api/logout",
  tenantAuth,
  handler(async (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) await destroySession(token);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  }),
);

tenantApiRouter.get(
  "/api/me",
  tenantAuth,
  handler(async (req, res) => {
    const user = await getTenantUserById(req.tenantUser!.userId);
    if (!user) {
      sendError(res, 401, "UNAUTHORIZED", "Account no longer exists");
      return;
    }
    res.json({ user: publicUser(user), tenantId: user.tenantId, role: user.role });
  }),
);

tenantApiRouter.get(
  "/api/billing",
  tenantAuth,
  handler(async (req, res) => {
    const tenantId = req.tenantUser!.tenantId;
    try {
      const [stored, usage] = await Promise.all([resolveSubscription(tenantId), getTenantUsage(tenantId)]);
      // The derived status, so the portal's plan badge agrees with what the API will
      // actually allow — a lapsed trial reads "expired" here, not "trialing".
      const subscription = stored ? toEffectiveSubscription(stored) : null;
      res.json({ subscription, usage });
    } catch (err) {
      if (err instanceof SubscriptionStoreUnavailableError) {
        sendError(res, 503, "PROVIDER_UNAVAILABLE", "Billing store unavailable");
        return;
      }
      throw err;
    }
  }),
);

// ── Data export (owner only) ──────────────────────────────────────────────────
// The org's own documents, keys and team, packaged for download. Owner-only: it is a
// bulk read of everything the org holds here.

tenantApiRouter.get(
  "/api/backup",
  tenantAuth,
  requireTenantRole("owner"),
  handler(async (req, res) => {
    res.json(await getTenantExportSummary(req.tenantUser!.tenantId));
  }),
);

/**
 * Builds the export itself.
 *
 * Audited, because it is the single request that reads out everything the org has —
 * exactly the shape of a data exfiltration, and an owner should be able to see when
 * one happened and who asked for it.
 */
tenantApiRouter.get(
  "/api/backup/export",
  tenantAuth,
  requireTenantRole("owner"),
  handler(async (req, res) => {
    const tenantId = req.tenantUser!.tenantId;
    const payload = await buildTenantExport(tenantId);

    await recordAuditEvent({
      action: "tenant.export.downloaded",
      actor: req.tenantUser!.userId,
      actorLabel: req.tenantUser!.label,
      target: tenantId,
      targetLabel: tenantId,
      metadata: { ...payload.counts, truncated: payload.truncated },
    });
    res.json(payload);
  }),
);

// ── Request logs ──────────────────────────────────────────────────────────────
// The org's API call history. Member-visible (unlike webhooks/keys, this is
// read-only and carries no secrets) — anyone debugging an integration needs it.

tenantApiRouter.get(
  "/api/logs",
  tenantAuth,
  handler(async (req, res) => {
    const params = pageParams(req.query);
    const { items, total } = await listRequestLogsPage({
      ...params,
      // Forced from the session; the filters below only narrow.
      tenantId: req.tenantUser!.tenantId,
      functionKey: req.query.functionKey ? String(req.query.functionKey) : undefined,
      outcome: req.query.outcome === "error" || req.query.outcome === "success" ? req.query.outcome : undefined,
    });
    res.json(paginatedFrom(items, total, params));
  }),
);

// ── Webhooks (owner only) ─────────────────────────────────────────────────────
// Endpoint registration plus the delivery log. Owner-only: an endpoint receives the
// org's event stream, so adding one is a data-egress decision.
//
// Two guards, answering different questions. `requireTenantRole("owner")` asks whether
// this person may act; `requireTenantFeature("webhooks")` asks whether the org's plan
// includes the capability at all. The plan gate is on the routes that *create or
// widen* delivery — create, update, rotate, test — and deliberately not on list, read
// or delete: a tenant who downgrades must still be able to see what they have and
// take it down. Leaving those behind an upgrade wall would strand endpoints the
// tenant can neither see nor remove.

const webhookEventsSchema = z.array(z.enum(WEBHOOK_EVENTS)).min(1, "Subscribe to at least one event");

/**
 * Only http(s), and https is required outside development.
 *
 * A webhook URL is a destination this service will POST to on the tenant's behalf.
 * Refusing other schemes keeps it from being pointed at something that is not an HTTP
 * receiver at all.
 */
const webhookUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || (protocol === "http:" && env.NODE_ENV !== "production");
  }, "Webhook URLs must use https");

/**
 * Rejects a destination the service must not be pointed at (see
 * src/webhooks/url-guard.ts). Returns `true` when it already answered the request.
 *
 * Async, so it cannot live in the zod schema beside the scheme rule: the check
 * resolves DNS.
 */
const rejectedUnsafeUrl = async (res: Response, url: string | undefined): Promise<boolean> => {
  if (!url) return false;
  try {
    await assertSafeWebhookUrl(url);
    return false;
  } catch (err) {
    if (err instanceof UnsafeWebhookUrlError) {
      sendError(res, 400, "INVALID_ARGS", err.message);
      return true;
    }
    throw err;
  }
};

const createWebhookSchema = z.object({
  url: webhookUrlSchema,
  description: z.string().max(200).optional(),
  events: webhookEventsSchema,
});

tenantApiRouter.get(
  "/api/webhooks",
  tenantAuth,
  requireTenantRole("owner"),
  handler(async (req, res) => {
    const endpoints = await listEndpoints(req.tenantUser!.tenantId);
    res.json(paginate(endpoints, pageParams(req.query)));
  }),
);

tenantApiRouter.post(
  "/api/webhooks",
  tenantAuth,
  requireTenantRole("owner"),
  requireTenantFeature("webhooks"),
  handler(async (req, res) => {
    const parsed = createWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", parsed.error.issues[0]?.message ?? "Invalid webhook");
      return;
    }
    if (await rejectedUnsafeUrl(res, parsed.data.url)) return;

    // Checked before the insert rather than enforced with a constraint: the tenant
    // gets told the limit and what they have, instead of a 500 from a violated index.
    const existing = await countEndpoints(req.tenantUser!.tenantId);
    if (existing >= MAX_ENDPOINTS_PER_TENANT) {
      sendError(
        res,
        409,
        "LIMIT_REACHED",
        `You already have ${existing} webhook endpoints; the limit is ${MAX_ENDPOINTS_PER_TENANT}. Delete one to add another.`,
      );
      return;
    }

    const endpoint = await createEndpoint({ tenantId: req.tenantUser!.tenantId, ...parsed.data });
    await recordAuditEvent({
      action: "tenant.webhook.created",
      actor: req.tenantUser!.userId,
      actorLabel: req.tenantUser!.label,
      target: req.tenantUser!.tenantId,
      targetLabel: req.tenantUser!.tenantId,
      metadata: { endpointId: endpoint.id, url: endpoint.url },
    });
    // The secret is returned exactly once — it is not recoverable afterwards, only
    // rotatable, so the client must capture it here.
    res.status(201).json(endpoint);
  }),
);

const updateWebhookSchema = z.object({
  url: webhookUrlSchema.optional(),
  description: z.string().max(200).optional(),
  events: webhookEventsSchema.optional(),
  enabled: z.boolean().optional(),
});

tenantApiRouter.patch(
  "/api/webhooks/:id",
  tenantAuth,
  requireTenantRole("owner"),
  requireTenantFeature("webhooks"),
  handler(async (req, res) => {
    const parsed = updateWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", parsed.error.issues[0]?.message ?? "Invalid webhook");
      return;
    }
    if (await rejectedUnsafeUrl(res, parsed.data.url)) return;

    const updated = await updateEndpoint(req.tenantUser!.tenantId, String(req.params.id), parsed.data);
    if (!updated) {
      sendError(res, 404, "NOT_FOUND", "No such webhook");
      return;
    }
    await recordAuditEvent({
      action: "tenant.webhook.updated",
      actor: req.tenantUser!.userId,
      actorLabel: req.tenantUser!.label,
      target: req.tenantUser!.tenantId,
      targetLabel: req.tenantUser!.tenantId,
      metadata: { endpointId: updated.id, enabled: updated.enabled },
    });
    res.json(updated);
  }),
);

tenantApiRouter.delete(
  "/api/webhooks/:id",
  tenantAuth,
  requireTenantRole("owner"),
  handler(async (req, res) => {
    const removed = await deleteEndpoint(req.tenantUser!.tenantId, String(req.params.id));
    if (!removed) {
      sendError(res, 404, "NOT_FOUND", "No such webhook");
      return;
    }
    await recordAuditEvent({
      action: "tenant.webhook.deleted",
      actor: req.tenantUser!.userId,
      actorLabel: req.tenantUser!.label,
      target: req.tenantUser!.tenantId,
      targetLabel: req.tenantUser!.tenantId,
      metadata: { endpointId: String(req.params.id) },
    });
    res.json({ ok: true });
  }),
);

tenantApiRouter.post(
  "/api/webhooks/:id/rotate-secret",
  tenantAuth,
  requireTenantRole("owner"),
  requireTenantFeature("webhooks"),
  handler(async (req, res) => {
    const rotated = await rotateSecret(req.tenantUser!.tenantId, String(req.params.id));
    if (!rotated) {
      sendError(res, 404, "NOT_FOUND", "No such webhook");
      return;
    }
    await recordAuditEvent({
      action: "tenant.webhook.secret_rotated",
      actor: req.tenantUser!.userId,
      actorLabel: req.tenantUser!.label,
      target: req.tenantUser!.tenantId,
      targetLabel: req.tenantUser!.tenantId,
      metadata: { endpointId: rotated.id },
    });
    // The previous secret stopped working the moment this returned.
    res.json(rotated);
  }),
);

/**
 * Queues a synthetic event so a tenant can verify their receiver end to end —
 * signature included — without waiting to process a real document.
 */
tenantApiRouter.post(
  "/api/webhooks/:id/test",
  tenantAuth,
  requireTenantRole("owner"),
  requireTenantFeature("webhooks"),
  handler(async (req, res) => {
    const tenantId = req.tenantUser!.tenantId;
    const endpoint = await getEndpoint(tenantId, String(req.params.id));
    if (!endpoint) {
      sendError(res, 404, "NOT_FOUND", "No such webhook");
      return;
    }

    const deliveryId = randomUUID();
    await enqueueDelivery({
      id: deliveryId,
      endpointId: endpoint.id,
      tenantId,
      event: "document.processed",
      payload: {
        event: "document.processed",
        deliveryId,
        tenantId,
        functionKey: "TEXT_EXTRACTION",
        outcome: "success",
        pageCount: 1,
        fileName: "test-document.pdf",
        occurredAt: new Date().toISOString(),
        // Marked so a receiver can tell a drill from the real thing.
        test: true,
      },
    });
    res.status(202).json({ deliveryId });
  }),
);

tenantApiRouter.get(
  "/api/webhooks/deliveries",
  tenantAuth,
  requireTenantRole("owner"),
  handler(async (req, res) => {
    const params = pageParams(req.query);
    const { items, total } = await listDeliveriesPage({
      ...params,
      tenantId: req.tenantUser!.tenantId,
      endpointId: req.query.endpointId ? String(req.query.endpointId) : undefined,
    });
    res.json(paginatedFrom(items, total, params));
  }),
);

// ── Documents & reports ───────────────────────────────────────────────────────
// The org's processing history. Only `standard`-sensitivity functions are recorded
// at all (src/observability/documents.ts) — a PII run leaves no row here by design,
// so this list is deliberately not a complete account of everything submitted.

tenantApiRouter.get(
  "/api/documents",
  tenantAuth,
  handler(async (req, res) => {
    const params = pageParams(req.query);
    const { items, total } = await listDocumentsPage({
      ...params,
      // Forced from the session, never read from the query: this is the only thing
      // stopping one org from paging through another's history.
      tenantId: req.tenantUser!.tenantId,
      functionKey: req.query.functionKey ? String(req.query.functionKey) : undefined,
      outcome: req.query.outcome === "error" || req.query.outcome === "success" ? req.query.outcome : undefined,
    });
    res.json(paginatedFrom(items, total, params));
  }),
);

/**
 * A short-lived presigned link to the archived source file.
 *
 * The API issues the link and the browser fetches the bytes straight from object
 * storage, so a large download never occupies an API process. Ownership is checked
 * *here*, when the link is minted — the link itself is a bearer URL, which is why
 * its TTL is measured in minutes.
 */
tenantApiRouter.get(
  "/api/documents/:id/download",
  tenantAuth,
  handler(async (req, res) => {
    const doc = await getDocumentById(String(req.params.id));
    // Same 404 whether it does not exist or belongs to another org — a distinct
    // "forbidden" would confirm the id is real.
    if (!doc || doc.tenantId !== req.tenantUser!.tenantId) {
      sendError(res, 404, "NOT_FOUND", "No such document");
      return;
    }
    if (!doc.storageKey) {
      sendError(res, 404, "NOT_FOUND", "This document's file was not archived");
      return;
    }

    const url = await presignDownload(doc.storageKey, doc.fileName);
    if (!url) {
      sendError(res, 503, "PROVIDER_UNAVAILABLE", "Document storage unavailable");
      return;
    }
    res.json({ url, fileName: doc.fileName, expiresInSeconds: env.S3_DOWNLOAD_URL_TTL_SECONDS });
  }),
);

tenantApiRouter.get(
  "/api/documents/report",
  tenantAuth,
  handler(async (req, res) => {
    const days = Number(req.query.days);
    const report = await getDocumentReport(req.tenantUser!.tenantId, Number.isFinite(days) ? days : 30);
    // The retention window rides along so the page can say *why* the history stops
    // where it does, rather than looking like data loss.
    const policy = await getSettings("retention");
    res.json({
      ...report,
      retention: {
        enabled: policy.enabled,
        documentRetentionDays: policy.documentRetentionDays,
      },
    });
  }),
);

tenantApiRouter.get(
  "/api/jobs",
  tenantAuth,
  handler(async (req, res) => {
    // The queue holds a bounded recent window, so this is paged in memory like the
    // other small collections rather than in the store.
    const jobs = await ocrQueue.getRecentForTenant(req.tenantUser!.tenantId);
    res.json(paginate(jobs, pageParams(req.query)));
  }),
);

/**
 * Server-sent stream of this tenant's job transitions.
 *
 * Replaces the jobs page's poll. A job that starts promptly is `queued` for around a
 * second, so a 5s interval reported it only once it had already settled — the queue
 * appeared to go straight from empty to failed. Events land as they happen.
 *
 * The list endpoint above stays, and stays authoritative: this carries *that
 * something changed*, and the console refetches. That keeps one shape of the job
 * record rather than two that can drift, and means a dropped connection costs
 * freshness rather than correctness — the client still polls, just slowly.
 *
 * SSE rather than a websocket: the traffic is one-directional and an `EventSource`
 * reconnects by itself, which matters because the consoles sit behind a proxy that
 * will cut an idle connection eventually no matter what we do here.
 */
tenantApiRouter.get("/api/jobs/stream", tenantAuth, (req, res) => {
  const { tenantId } = req.tenantUser!;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    // `no-transform` is the load-bearing half: a proxy that gzips this buffers it,
    // and a buffered stream arrives all at once at the end, which is worse than
    // polling was.
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Nginx honours this to disable its own response buffering.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  // An idle stream is indistinguishable from a dead one to every intermediary in the
  // path. A comment line every 25s keeps it open and costs 3 bytes.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);

  const unsubscribe = subscribeToJobEvents(tenantId, (event) => {
    res.write(`event: job\ndata: ${JSON.stringify(event)}\n\n`);
  });

  // `close` fires on a client disconnect and on a proxy timeout alike. Without this
  // the listener set grows by one on every page reload and every reconnect.
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

/** Trims a stored user down to the public view — never leak the password hash. */
const publicUser = (u: TenantUser): TenantUser => ({
  id: u.id,
  tenantId: u.tenantId,
  email: u.email,
  name: u.name,
  role: u.role,
  disabled: u.disabled,
  createdAt: u.createdAt,
  updatedAt: u.updatedAt,
});

// ── API keys (owner only) ─────────────────────────────────────────────────────
// The tenant's own keys for direct API access. The raw key is unrecoverable, so the
// list surfaces only the key-hash (and a short display prefix), never the secret.

const createKeySchema = z.object({
  name: z.string().min(1).optional(),
  expiresAt: z.string().datetime().optional(),
});

/**
 * Scope for a tenant-minted key: exactly what the org can already do, never more.
 *
 * Not the *narrowest* existing scope — the union. If the org already holds a key
 * that can call a function, a new key that can also call it grants no new
 * capability; intersecting instead would break tenants who legitimately hold
 * several differently-scoped keys. The property being preserved is only that
 * self-service cannot *escalate* beyond what an admin has already granted.
 *
 * `undefined` for either field means "unrestricted" downstream, so it is returned
 * only when the org genuinely already has an unrestricted key (or no keys at all,
 * i.e. nothing has been constrained yet).
 */
export const inheritedScope = (keys: Tenant[]): Partial<Pick<Tenant, "allowedFunctions" | "rateLimit">> => {
  if (keys.length === 0) return {};

  const unrestrictedFunctions = keys.some((k) => !k.allowedFunctions || k.allowedFunctions.length === 0);
  const allowedFunctions = unrestrictedFunctions
    ? undefined
    : [...new Set(keys.flatMap((k) => k.allowedFunctions ?? []))];

  // A key with no explicit limit already runs at the env default, so inheriting
  // "no limit" from it is not an escalation; otherwise take the most permissive.
  const rateLimit = keys.some((k) => k.rateLimit === undefined)
    ? undefined
    : Math.max(...keys.map((k) => k.rateLimit!));

  return { allowedFunctions, rateLimit };
};

/** Public shape of a key: the hash identifies it; the raw key is never stored. */
const publicKey = (
  keyHash: string,
  tenant: { name?: string; disabled?: boolean; expiresAt?: string; createdAt?: string },
) => ({
  keyHash,
  prefix: keyHash.slice(0, 12),
  name: tenant.name,
  disabled: tenant.disabled ?? false,
  expiresAt: tenant.expiresAt,
  expired: tenant.expiresAt ? new Date(tenant.expiresAt).getTime() <= Date.now() : false,
  createdAt: tenant.createdAt,
});

tenantApiRouter.get(
  "/api/keys",
  tenantAuth,
  requireTenantRole("owner"),
  handler(async (req, res) => {
    const keys = await listKeysForTenant(req.tenantUser!.tenantId);
    res.json(
      paginate(
        keys.map(({ keyHash, tenant }) => publicKey(keyHash, tenant)),
        pageParams(req.query),
      ),
    );
  }),
);

tenantApiRouter.post(
  "/api/keys",
  tenantAuth,
  requireTenantRole("owner"),
  handler(async (req, res) => {
    const parsed = createKeySchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", parsed.error.issues[0]?.message ?? "Invalid key");
      return;
    }
    if (parsed.data.expiresAt && new Date(parsed.data.expiresAt).getTime() <= Date.now()) {
      sendError(res, 400, "INVALID_ARGS", "Expiry must be in the future");
      return;
    }
    const tenantId = req.tenantUser!.tenantId;
    const apiKey = generateApiKey();
    const createdAt = new Date().toISOString();

    // Inherit the org's existing scope rather than minting an unrestricted key.
    // `allowedFunctions`/`rateLimit` left NULL mean "all functions, env default
    // rate" (see authorize.ts), so a tenant whose admin-issued key was deliberately
    // narrowed to, say, RECEIPT_PARSING at 10 rpm could otherwise escape both
    // constraints in one click from this very endpoint.
    const existing = await listKeysForTenant(tenantId);
    const scope = inheritedScope(existing.map(({ tenant }) => tenant));

    await putTenant(
      apiKey,
      { tenantId, name: parsed.data.name, expiresAt: parsed.data.expiresAt, createdAt, ...scope },
      { actor: req.tenantUser!.userId },
    );
    // The raw key is shown exactly once — it is never stored, only its hash.
    res.status(201).json({
      apiKey,
      ...publicKey(hashApiKey(apiKey), { name: parsed.data.name, expiresAt: parsed.data.expiresAt, createdAt }),
    });
  }),
);

tenantApiRouter.delete(
  "/api/keys/:hash",
  tenantAuth,
  requireTenantRole("owner"),
  handler(async (req, res) => {
    const keyHash = String(req.params.hash);
    // Only revoke a key that belongs to this org — never touch another tenant's key.
    const owned = await listKeysForTenant(req.tenantUser!.tenantId);
    if (!owned.some((k) => k.keyHash === keyHash)) {
      sendError(res, 404, "NOT_FOUND", "No such key");
      return;
    }
    await revokeByHash(keyHash, { actor: req.tenantUser!.userId });
    res.json({ ok: true });
  }),
);

// ── Team / tenant users (owner only) ──────────────────────────────────────────

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: TENANT_ROLE,
  password: z.string().min(8),
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: TENANT_ROLE.optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

tenantApiRouter.get(
  "/api/users",
  tenantAuth,
  requireTenantRole("owner"),
  handler(async (req, res) => {
    res.json(paginate(await listTenantUsers(req.tenantUser!.tenantId), pageParams(req.query)));
  }),
);

tenantApiRouter.post(
  "/api/users",
  tenantAuth,
  requireTenantRole("owner"),
  handler(async (req, res) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", parsed.error.issues[0]?.message ?? "Invalid user");
      return;
    }

    // The platform's minimum-length policy applies wherever a password is set, not
    // only to self-service changes — otherwise raising it leaves every account
    // created by an owner on the old floor.
    if (parsed.data.password !== undefined) {
      try {
        await assertPasswordPolicy(parsed.data.password);
      } catch (err) {
        sendError(res, 400, "INVALID_ARGS", err instanceof Error ? err.message : "Password does not meet policy");
        return;
      }
    }
    try {
      const user = await createTenantUser(
        { tenantId: req.tenantUser!.tenantId, ...parsed.data },
        req.tenantUser!.userId,
      );
      res.status(201).json({ user });
    } catch (err) {
      sendError(res, 409, "CONFLICT", err instanceof Error ? err.message : "Could not create user");
    }
  }),
);

tenantApiRouter.patch(
  "/api/users/:id",
  tenantAuth,
  requireTenantRole("owner"),
  handler(async (req, res) => {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", parsed.error.issues[0]?.message ?? "Invalid update");
      return;
    }

    // The platform's minimum-length policy applies wherever a password is set, not
    // only to self-service changes — otherwise raising it leaves every account
    // created by an owner on the old floor.
    if (parsed.data.password !== undefined) {
      try {
        await assertPasswordPolicy(parsed.data.password);
      } catch (err) {
        sendError(res, 400, "INVALID_ARGS", err instanceof Error ? err.message : "Password does not meet policy");
        return;
      }
    }
    const tenantId = req.tenantUser!.tenantId;
    const id = String(req.params.id);
    const target = await getTenantUserById(id);
    if (!target || target.tenantId !== tenantId) {
      sendError(res, 404, "NOT_FOUND", "No such user");
      return;
    }

    // Self-lockout guard: don't let the last active owner be demoted or disabled.
    const removesOwner =
      target.role === "owner" && ((parsed.data.role && parsed.data.role !== "owner") || parsed.data.disabled === true);
    if (removesOwner && (await countOwners(tenantId)) <= 1) {
      sendError(res, 400, "LAST_OWNER", "Cannot demote or disable the last owner");
      return;
    }

    const user = await updateTenantUser(tenantId, id, parsed.data, req.tenantUser!.userId);
    res.json({ user });
  }),
);

tenantApiRouter.delete(
  "/api/users/:id",
  tenantAuth,
  requireTenantRole("owner"),
  handler(async (req, res) => {
    const tenantId = req.tenantUser!.tenantId;
    const id = String(req.params.id);
    const target = await getTenantUserById(id);
    if (!target || target.tenantId !== tenantId) {
      sendError(res, 404, "NOT_FOUND", "No such user");
      return;
    }
    if (target.role === "owner" && (await countOwners(tenantId)) <= 1) {
      sendError(res, 400, "LAST_OWNER", "Cannot delete the last owner");
      return;
    }
    await deleteTenantUser(tenantId, id, req.tenantUser!.userId);
    res.json({ ok: true });
  }),
);

/**
 * Org-owner escape hatch: clears a team member's second factor.
 *
 * Losing both the authenticator and the recovery codes is otherwise a permanent
 * lockout (the secret is unrecoverable; the codes are stored only as hashes).
 * Scoped to the caller's own org and audited — it lowers someone else's account
 * security, so the request should be verified out of band first.
 */
tenantApiRouter.delete(
  "/api/users/:id/mfa",
  tenantAuth,
  requireTenantRole("owner"),
  handler(async (req, res) => {
    const tenantId = req.tenantUser!.tenantId;
    const id = String(req.params.id);
    const target = await getTenantUserById(id);
    if (!target || target.tenantId !== tenantId) {
      sendError(res, 404, "NOT_FOUND", "No such user");
      return;
    }

    await disableMfa("tenant_users", id, req.tenantUser!.userId);
    await recordAuditEvent({
      action: "tenant.mfa.reset",
      actor: req.tenantUser!.userId,
      actorLabel: req.tenantUser!.label,
      // The org is the target of record, but the person is what a reader needs.
      target: tenantId,
      targetLabel: personLabel(target),
      metadata: { userId: id, email: target.email },
    });
    logger.warn("tenant.mfa.reset", { userId: id, tenantId, actor: req.tenantUser!.userId });
    res.json({ enabled: false });
  }),
);
