import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { randomUUID } from "crypto";

import type { TenantRole, TenantUser } from "../types/user";
import { logger } from "../observability/logger";
import { query } from "../db";

/**
 * Tenant-user registry — the tenant-side twin of the admin registry
 * (src/auth/admins.ts). Tenant users log into the portal at `/tenant`; each
 * belongs to a tenant *org* (`tenant_id`, the stable id also carried on the API-key
 * registry in src/auth/tenants.ts) and has a role (see {@link TenantRole}) scoping
 * what the portal lets them do.
 *
 * Rows live in the `tenant_users` table (src/db.ts), keyed by user id, with a
 * UNIQUE constraint on the (lowercased) login email — the database enforces one
 * account per email globally. The password is stored only as an **argon2id hash**;
 * the plaintext is never persisted and there is no way to recover it.
 *
 * As with admins/tenants, the stdout log stream is the audit trail
 * (`tenant_user.created` / `.updated` / `.deleted`).
 */

/** The stored shape: the public {@link TenantUser}, plus the secret hash. */
type TenantUserRecord = TenantUser & { passwordHash: string };

/** The `tenant_users` row shape (snake_case columns); timestamptz columns come back as Date. */
type TenantUserRow = {
  id: string;
  tenant_id: string;
  email: string;
  name: string;
  role: TenantRole;
  password_hash: string;
  disabled: boolean;
  created_at: Date;
  updated_at: Date;
};

const rowToRecord = (r: TenantUserRow): TenantUserRecord => ({
  id: r.id,
  tenantId: r.tenant_id,
  email: r.email,
  name: r.name,
  role: r.role,
  passwordHash: r.password_hash,
  disabled: r.disabled,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Login email is case-insensitive; normalize before every read/write. */
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Strips the secret before a record leaves this module. */
const toView = (record: TenantUserRecord): TenantUser => {
  const { passwordHash: _passwordHash, ...view } = record;
  return view;
};

/**
 * argon2id with the library's interactive-login defaults. Ships prebuilt binaries
 * (no native build), so this works on the slim runtime image as-is — same as admins.
 */
const hashPassword = (plain: string): Promise<string> => argonHash(plain);

/**
 * Exactly one of `password` / `passwordHash` must be supplied.
 *
 * The hash form exists for self-serve signup: it hashes at register time so the
 * plaintext never reaches the pending-signup store in Redis (src/auth/signup.ts),
 * and by the time the account is really created there is nothing left to hash.
 */
export type CreateTenantUserInput = {
  tenantId: string;
  email: string;
  name: string;
  role: TenantRole;
} & ({ password: string; passwordHash?: undefined } | { passwordHash: string; password?: undefined });

/**
 * Creates a tenant user under an org. Rejects a duplicate email (the login key is
 * globally unique). Returns the safe view; emits a `tenant_user.created` audit line.
 */
export const createTenantUser = async (input: CreateTenantUserInput, actor = "unknown"): Promise<TenantUser> => {
  const email = normalizeEmail(input.email);

  if (await getTenantUserByEmail(email)) throw new Error(`A tenant user with email '${email}' already exists`);

  const now = new Date();
  const record: TenantUserRecord = {
    id: randomUUID(),
    tenantId: input.tenantId,
    email,
    name: input.name,
    role: input.role,
    passwordHash: input.passwordHash ?? (await hashPassword(input.password!)),
    createdAt: now,
    updatedAt: now,
  };

  await query(
    `INSERT INTO tenant_users (id, tenant_id, email, name, role, password_hash, disabled, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [record.id, record.tenantId, email, record.name, record.role, record.passwordHash, false, now, now],
  );
  logger.info("tenant_user.created", { userId: record.id, tenantId: record.tenantId, email, role: record.role, actor });
  return toView(record);
};

/** Resolves a login email to its full record (secret included) or `undefined`. */
export const getTenantUserByEmail = async (email: string): Promise<TenantUserRecord | undefined> => {
  const { rows } = await query<TenantUserRow>(`SELECT * FROM tenant_users WHERE email = $1`, [normalizeEmail(email)]);
  return rows[0] ? rowToRecord(rows[0]) : undefined;
};

/** Resolves an id to its full record (secret included) or `undefined`. */
export const getTenantUserById = async (id: string): Promise<TenantUserRecord | undefined> => {
  const { rows } = await query<TenantUserRow>(`SELECT * FROM tenant_users WHERE id = $1`, [id]);
  return rows[0] ? rowToRecord(rows[0]) : undefined;
};

/** A tenant's users as safe views, sorted oldest-first. Scoped to one org. */
export const listTenantUsers = async (tenantId: string): Promise<TenantUser[]> => {
  const { rows } = await query<TenantUserRow>(
    `SELECT * FROM tenant_users WHERE tenant_id = $1 ORDER BY created_at ASC`,
    [tenantId],
  );
  return rows.map((r) => toView(rowToRecord(r)));
};

/** Count of enabled owners for an org — used to block removing the last one (self-lockout guard). */
export const countOwners = async (tenantId: string): Promise<number> => {
  const { rows } = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM tenant_users WHERE tenant_id = $1 AND role = 'owner' AND disabled = false`,
    [tenantId],
  );
  return rows[0]?.n ?? 0;
};

export type UpdateTenantUserInput = {
  name?: string;
  role?: TenantRole;
  disabled?: boolean;
  /** When present, resets the password to this new value (re-hashed). */
  password?: string;
};

/**
 * Updates a tenant user (scoped to its org so one tenant can't touch another's).
 * Only the provided fields change; `password` is re-hashed. Returns the safe view
 * or `undefined` if no such user in that org. Emits `tenant_user.updated`.
 */
export const updateTenantUser = async (
  tenantId: string,
  id: string,
  patch: UpdateTenantUserInput,
  actor = "unknown",
): Promise<TenantUser | undefined> => {
  const passwordHash = patch.password ? await hashPassword(patch.password) : null;
  const { rows } = await query<TenantUserRow>(
    `UPDATE tenant_users SET
       name = COALESCE($3, name),
       role = COALESCE($4, role),
       disabled = COALESCE($5, disabled),
       password_hash = COALESCE($6, password_hash),
       updated_at = $7
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [tenantId, id, patch.name ?? null, patch.role ?? null, patch.disabled ?? null, passwordHash, new Date()],
  );
  if (!rows[0]) return undefined;

  const next = rowToRecord(rows[0]);
  logger.info("tenant_user.updated", {
    userId: id,
    tenantId,
    actor,
    role: next.role,
    disabled: next.disabled,
    passwordReset: !!patch.password,
  });
  return toView(next);
};

/** Deletes a tenant user within its org. Emits `tenant_user.deleted`. Idempotent. */
export const deleteTenantUser = async (tenantId: string, id: string, actor = "unknown"): Promise<boolean> => {
  const { rows } = await query<{ email: string }>(
    `DELETE FROM tenant_users WHERE tenant_id = $1 AND id = $2 RETURNING email`,
    [tenantId, id],
  );
  if (!rows[0]) return false;
  logger.info("tenant_user.deleted", { userId: id, tenantId, email: rows[0].email, actor });
  return true;
};

/**
 * Verifies a plaintext password against a stored record. A disabled account always
 * fails, even with the right password. Returns false (never throws) on a malformed
 * hash so login stays constant-shaped.
 */
export const verifyPassword = async (record: TenantUserRecord, plain: string): Promise<boolean> => {
  if (record.disabled) return false;
  try {
    return await argonVerify(record.passwordHash, plain);
  } catch {
    return false;
  }
};

/** The public view of a stored record (id + org + role, never the hash). */
export type { TenantUser };
export { toView as tenantUserView };
