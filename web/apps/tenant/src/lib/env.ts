/**
 * Server-side environment for the tenant portal.
 *
 * Next reads `.env*` from this app's own directory — **not** from the repo root. The
 * root `.env` is loaded by the API process (`import "dotenv/config"`) and is invisible
 * here, so anything this app needs must be in `web/apps/tenant/.env.local`.
 *
 * A missing variable is caught at server start by `src/instrumentation.ts` rather than
 * on the first request. The alternative is what it replaced: `process.env.OCR_API_URL`
 * typed as `string`, undefined at runtime, and a proxy quietly dialling
 * `undefined/…` until someone reads the network tab.
 *
 * Note that a `.d.ts` cannot do this job. Declaration files are erased at compile
 * time and never execute, so augmenting `NodeJS.ProcessEnv` only tells TypeScript a
 * variable is present — it cannot check. That is a promise this module keeps instead.
 */

/** Variables the app cannot start without. Everything else has a documented default. */
export const REQUIRED_ENV = ["OCR_API_URL"] as const;

export type RequiredEnv = (typeof REQUIRED_ENV)[number];

const missingMessage = (names: readonly string[]): string =>
  `Missing required environment variable${names.length > 1 ? "s" : ""}: ${names.join(", ")}.\n` +
  `Copy web/apps/tenant/.env.local.example to web/apps/tenant/.env.local and fill it in.\n` +
  `The repo-root .env is read by the API only — Next does not load it.`;

/** Reads a required variable, or throws naming both the variable and the fix. */
export const requireEnv = (name: RequiredEnv): string => {
  const value = process.env[name];
  if (!value) throw new Error(missingMessage([name]));
  return value;
};

/**
 * Fails the boot when anything required is absent, listing every missing variable at
 * once — finding them one restart at a time is the slowest possible way to do this.
 */
export const assertRequiredEnv = (): void => {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) throw new Error(missingMessage(missing));
};
