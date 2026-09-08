import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { randomInt } from "crypto";

import { logger } from "../observability/logger";
import { getRedis } from "../redis";

/**
 * The half-finished account that sits between "someone filled in the register form"
 * and "an organisation exists".
 *
 * Nothing is written to Postgres at register time. A signup lives in Redis under a
 * short TTL, keyed by the email it claims, and only becomes a tenant org + owner
 * user + subscription once a code sent to that mailbox comes back. The ordering is
 * the whole point: if registering created the org up front, anyone could squat an
 * organisation name — or a colleague's email — without ever proving they can read
 * the inbox, and every abandoned form would leave a real, billable tenant behind.
 *
 * Two secrets are held here and neither is held in the clear:
 *
 *  - **The password**, hashed with argon2id exactly as `tenant_users` stores it, so
 *    the pending record is no more dangerous than the row it will become.
 *  - **The code**, also argon2id. Six digits is little entropy, so the real control
 *    is {@link MAX_OTP_ATTEMPTS} plus the TTL; hashing means a Redis dump still
 *    isn't a list of live codes.
 *
 * Mirrors src/auth/mfa-challenge.ts, which does the same job for the gap between a
 * correct password and a verified second factor.
 */

/** How long a code stays redeemable. Long enough to find the mail, short enough not to linger. */
export const SIGNUP_TTL_SECONDS = 15 * 60;

/** Wrong codes tolerated before the signup is destroyed and must be started again. */
export const MAX_OTP_ATTEMPTS = 5;

/** Minimum gap between two "send me another code" requests for the same signup. */
export const RESEND_COOLDOWN_SECONDS = 60;

const pendingKey = (email: string): string => `signup:pending:${email}`;

/** Login email is case-insensitive everywhere else; keep this store consistent. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** What verification needs in order to provision the org, once the code checks out. */
export type PendingSignup = {
  email: string;
  name: string;
  organizationName: string;
  planId: string;
  /** argon2id of the password the user chose. Never the plaintext. */
  passwordHash: string;
  /** argon2id of the six-digit code. */
  otpHash: string;
  /** Wrong codes so far; at {@link MAX_OTP_ATTEMPTS} the record is destroyed. */
  attempts: number;
  /** Epoch ms of the last code send, for the resend cooldown. */
  lastSentAt: number;
  createdAt: number;
};

export type StartSignupInput = {
  email: string;
  name: string;
  organizationName: string;
  planId: string;
  password: string;
};

/** A six-digit code. `randomInt` is the CSPRNG — `Math.random` would be guessable. */
const generateOtp = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

/**
 * Mints (or replaces) the pending signup for an email and returns the **plaintext**
 * code for the caller to email. It is returned rather than sent from here so this
 * module stays free of transport concerns and remains testable without a mailer.
 *
 * Replacing rather than rejecting an existing pending signup is deliberate: someone
 * who mistyped their organisation name should just be able to fill the form in
 * again, and the previous code stops working the moment this one is stored.
 */
export const startSignup = async (input: StartSignupInput): Promise<{ otp: string; expiresAt: Date }> => {
  const email = normalizeEmail(input.email);
  const otp = generateOtp();
  const now = Date.now();

  const pending: PendingSignup = {
    email,
    name: input.name,
    organizationName: input.organizationName,
    planId: input.planId,
    passwordHash: await argonHash(input.password),
    otpHash: await argonHash(otp),
    attempts: 0,
    lastSentAt: now,
    createdAt: now,
  };

  await getRedis().set(pendingKey(email), JSON.stringify(pending), "EX", SIGNUP_TTL_SECONDS);
  return { otp, expiresAt: new Date(now + SIGNUP_TTL_SECONDS * 1000) };
};

/** Reads a pending signup without spending it. `undefined` once expired or consumed. */
export const peekSignup = async (email: string): Promise<PendingSignup | undefined> => {
  const raw = await getRedis().get(pendingKey(normalizeEmail(email)));
  return raw ? (JSON.parse(raw) as PendingSignup) : undefined;
};

/** Drops a pending signup — on success, on too many wrong codes, or on abandonment. */
export const discardSignup = async (email: string): Promise<void> => {
  await getRedis().del(pendingKey(normalizeEmail(email)));
};

export type OtpCheck = { ok: true; pending: PendingSignup } | { ok: false; reason: "expired" | "invalid" | "locked" };

/**
 * Checks a submitted code against the pending signup and, on a wrong one, records
 * the attempt.
 *
 * A wrong code leaves the signup usable (a typo must not send someone back through
 * the whole form) until {@link MAX_OTP_ATTEMPTS} is reached, at which point the
 * record is destroyed — six digits is only 10^6, so an unbounded retry loop would
 * be a five-minute brute force.
 *
 * The remaining TTL is preserved across the attempt write. Re-`SET`ting with a fresh
 * `EX` would let a wrong guess every 14 minutes keep a signup alive forever.
 */
export const checkOtp = async (email: string, otp: string): Promise<OtpCheck> => {
  const key = pendingKey(normalizeEmail(email));
  const redis = getRedis();

  const raw = await redis.get(key);
  if (!raw) return { ok: false, reason: "expired" };
  const pending = JSON.parse(raw) as PendingSignup;

  let matches = false;
  try {
    matches = await argonVerify(pending.otpHash, otp);
  } catch {
    // A malformed hash can only mean a corrupt record; treat it as a wrong code.
    matches = false;
  }
  if (matches) return { ok: true, pending };

  const attempts = pending.attempts + 1;
  if (attempts >= MAX_OTP_ATTEMPTS) {
    await redis.del(key);
    logger.warn("signup.otp.locked", { email: pending.email, attempts });
    return { ok: false, reason: "locked" };
  }

  const ttl = await redis.ttl(key);
  const next: PendingSignup = { ...pending, attempts };
  if (ttl > 0) await redis.set(key, JSON.stringify(next), "EX", ttl);
  else await redis.set(key, JSON.stringify(next), "KEEPTTL");

  return { ok: false, reason: "invalid" };
};

export type ResendResult =
  | { ok: true; otp: string; pending: PendingSignup; expiresAt: Date }
  | { ok: false; reason: "expired" | "cooldown"; retryAfterSeconds?: number };

/**
 * Issues a fresh code for an existing pending signup, resetting the attempt counter
 * and the TTL. Rate-limited per signup so the endpoint can't be used to mail-bomb an
 * address that never asked to register.
 */
export const resendOtp = async (email: string): Promise<ResendResult> => {
  const normalized = normalizeEmail(email);
  const pending = await peekSignup(normalized);
  if (!pending) return { ok: false, reason: "expired" };

  const elapsed = (Date.now() - pending.lastSentAt) / 1000;
  if (elapsed < RESEND_COOLDOWN_SECONDS) {
    return { ok: false, reason: "cooldown", retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed) };
  }

  const otp = generateOtp();
  const now = Date.now();
  const next: PendingSignup = { ...pending, otpHash: await argonHash(otp), attempts: 0, lastSentAt: now };
  await getRedis().set(pendingKey(normalized), JSON.stringify(next), "EX", SIGNUP_TTL_SECONDS);

  return { ok: true, otp, pending: next, expiresAt: new Date(now + SIGNUP_TTL_SECONDS * 1000) };
};
