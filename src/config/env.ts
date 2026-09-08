import { z } from "zod";

/**
 * Zod-validated process environment. Import `env` anywhere config is needed;
 * validation runs once at module load and throws on an invalid configuration.
 */
const schema = z
  .object({
    ADMIN_SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(8 * 60 * 60),
    ADMIN_BOOTSTRAP_EMAIL: z.string(),
    // Seeds the first owner account; brute-forceable online (see admin login), so
    // enforce a real minimum length rather than trusting the operator.
    ADMIN_BOOTSTRAP_PASSWORD: z.string().min(12, "ADMIN_BOOTSTRAP_PASSWORD must be at least 12 characters"),
    // Tenant-portal session lifetime. Independent of the admin console; defaults to
    // the same 8h interactive-login window.
    TENANT_SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(8 * 60 * 60),
    /**
     * Name an authenticator app shows beside an enrolled account. Purely cosmetic,
     * but it is baked into the `otpauth://` URI at enrolment time, so changing it
     * later only relabels accounts enrolled after the change.
     */
    /**
     * Whether this process also runs the background work — the BullMQ OCR worker,
     * the retention sweep, and webhook delivery.
     *
     * **Defaults to on**, deliberately. The two failure modes are not symmetric: with
     * it off in a single-container deploy, queued documents are never processed,
     * retention never runs and webhooks queue forever without sending — all silently.
     * With it on where a dedicated worker also exists, the cost is that the web
     * process shares some background load. A visible performance cost beats invisible
     * data loss, so the default is the one that always works.
     *
     * Running it in both places is *safe*, not merely tolerable: the retention sweep
     * takes a Redis lock, webhook delivery claims rows with `FOR UPDATE SKIP LOCKED`,
     * and BullMQ locks each job — so duplicate runners coordinate rather than collide.
     *
     * Set `false` on the web service when a separate worker process is deployed
     * (docker-compose.yml does exactly this), to keep OCR processing off the request
     * path.
     */
    RUN_BACKGROUND_WORKERS: z.enum(["true", "false"]).default("true"),
    MFA_ISSUER: z.string().min(1).default("Heirs OCR"),
    /**
     * Object storage for processed documents (src/storage/blob.ts).
     *
     * Off by default: storing the source file is a materially different privacy
     * posture from the metadata-only registry, so it has to be switched on
     * deliberately rather than arriving with an upgrade. When off, documents are
     * still listed — they just have nothing to download.
     */
    BLOB_STORAGE_ENABLED: z.enum(["true", "false"]).default("false"),
    /** Custom endpoint for an S3-compatible store (MinIO locally). Empty ⇒ real AWS S3. */
    S3_ENDPOINT: z.string().default(""),
    S3_BUCKET: z.string().default("heirs-ocr-documents"),
    S3_REGION: z.string().default("us-east-1"),
    S3_ACCESS_KEY_ID: z.string().default(""),
    S3_SECRET_ACCESS_KEY: z.string().default(""),
    /**
     * Path-style addressing (`host/bucket/key`) instead of virtual-host style
     * (`bucket.host/key`). MinIO needs it; so does any endpoint whose bucket name
     * is not a valid DNS label.
     */
    S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true"),
    /** Lifetime of a presigned download link. Short: it is a bearer URL for a document. */
    S3_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    API_KEY_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
    /**
     * Ceilings for the initial connection to each backing store.
     *
     * These are *boot* budgets, not per-request latency: nothing waits on them once
     * a connection is up, so headroom is free and being tight is expensive. Both
     * were previously hardcoded at 2000, which is right for a Postgres/Redis on
     * localhost and far too short for managed remote instances — measured against
     * this deployment, Postgres needs ~2.1s and Valkey 4–5.7s to hand-shake, with
     * enough variance that even a 10s ceiling flaps. A slow handshake should delay
     * the boot, never fail it.
     */
    DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    ASYNC_PAGE_THRESHOLD: z.coerce.number().int().positive().default(5),
    ASYNC_SIZE_THRESHOLD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 1024 * 1024),
    AUTH_ENABLED: z.enum(["true", "false"]).default("true"),
    AZURE_OPENAI_API_KEY: z.string().optional(),
    AZURE_OPENAI_ENDPOINT: z.string().optional(),
    AZURE_OPENAI_API_VERSION: z.string().optional(),
    AZURE_OPENAI_DEPLOYMENT_NAME: z.string().optional(),
    AZURE_OPENAI_ENABLED: z.enum(["true", "false"]).default("false"),
    CORS_ALLOWED_ORIGINS: z.string().default(""),
    // Connection string carrying DB credentials — no default; must be supplied via
    // the environment (12-factor III) so secrets are never baked into source.
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    EXTRACTION_CACHE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(7 * 24 * 60 * 60),
    GLM_API_KEY: z.string().optional(),
    GLM_BASE_URL: z.string().default("https://api.z.ai/api/paas/v4"),
    GLM_ENABLED: z.enum(["true", "false"]).default("false"),
    GLM_MAX_PAGES: z.coerce.number().int().positive().default(30),
    GLM_CONCURRENCY: z.coerce.number().int().positive().default(8),
    // Estimated LLM price in NGN per 1,000 tokens, feeding the cost SLI
    // (`ocr_estimated_cost_ngn_total`). 0 disables cost accounting.
    LLM_COST_NGN_PER_1K_TOKENS: z.coerce.number().nonnegative().default(0),
    // A result confidence at or below this (0–1) counts as "low" for the
    // low-confidence quality ratio SLI.
    LOW_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
    MAX_FILE_SIZE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(50 * 1024 * 1024),
    // When set, the /metrics scrape endpoint requires `Authorization: Bearer <token>`.
    // Leave unset only where the port is truly private (e.g. a scrape-only sidecar net).
    METRICS_AUTH_TOKEN: z.string().optional(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    /** OTLP/HTTP traces endpoint (e.g. http://collector:4318/v1/traces). Unset → traces not exported. */
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
    PORT: z.string().default("8080"),
    RATE_LIMIT_ENABLED: z.enum(["true", "false"]).default("true"),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    // May carry credentials (redis://:password@host) — no default; supplied via env.
    REDIS_URL: z.string().min(1, "REDIS_URL is required"),
    VERSION: z.string().default("1.0.0"),
    /**
     * Transactional email (src/notification/mail).
     *
     * Off by default, and deliberately so: a half-configured mailer that throws on
     * every send would take down the flows that *notify* about work rather than the
     * work itself. With this off, senders no-op and log — signups, job completions
     * and billing events all still succeed. Turn it on once SMTP is real.
     */
    MAIL_ENABLED: z.enum(["true", "false"]).default("false"),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    /**
     * Implicit TLS. True is port 465; on 587 leave this false — nodemailer upgrades
     * that connection with STARTTLS, and forcing `secure` there hangs the handshake.
     */
    SMTP_SECURE: z.enum(["true", "false"]).default("false"),
    /** Envelope sender. Must be a domain the SMTP relay is authorised to send for. */
    MAIL_FROM_ADDRESS: z.string().default(""),
    MAIL_FROM_NAME: z.string().default("Heirs Technologies"),
    /**
     * Public base URL of the tenant console. Every template links back to it, so it
     * must be the address a recipient can actually reach — not an internal hostname.
     */
    APP_BASE_URL: z.string().default("http://localhost:8080"),
    /**
     * Public base URL of *this* API, quoted to new tenants in their welcome email as
     * the host they should point an SDK at. Distinct from `APP_BASE_URL`, which is
     * the console a person opens in a browser.
     */
    API_BASE_URL: z.string().default("http://localhost:8080"),
    /** Landing pages linked from the footer of every email. */
    DOCS_URL: z.string().default("https://docs.heirstechnologies.com"),
    SUPPORT_EMAIL: z.string().default("support@heirstechnologies.com"),
    /**
     * Whether anyone may create an organisation from the public register page.
     *
     * On by default — the tenant portal ships a `/register` screen and a signup that
     * silently 404s is worse than one that is explicitly closed. Turn it off for a
     * deployment where every org is provisioned by an operator through the admin
     * console; `POST /tenant/api/register` then answers 403 and the console hides the
     * link.
     */
    SELF_SIGNUP_ENABLED: z.enum(["true", "false"]).default("true"),
  })
  .refine((data) => data.AZURE_OPENAI_ENABLED !== "true" || !!data.AZURE_OPENAI_API_KEY, {
    message: "AZURE_OPENAI_API_KEY is required when AZURE_OPENAI_ENABLED is true",
    path: ["AZURE_OPENAI_API_KEY"],
  })
  .refine((data) => data.GLM_ENABLED !== "true" || !!data.GLM_API_KEY, {
    message: "GLM_API_KEY is required when GLM_ENABLED is true",
    path: ["GLM_API_KEY"],
  })
  // Fail closed at boot: production must never run with auth or rate limiting
  // switched off. These bypasses exist for local dev only — a fat-fingered env var
  // must not be able to open the API in prod.
  .refine((data) => data.MAIL_ENABLED !== "true" || !!data.SMTP_HOST, {
    message: "SMTP_HOST is required when MAIL_ENABLED is true",
    path: ["SMTP_HOST"],
  })
  .refine((data) => data.MAIL_ENABLED !== "true" || !!data.MAIL_FROM_ADDRESS, {
    message: "MAIL_FROM_ADDRESS is required when MAIL_ENABLED is true",
    path: ["MAIL_FROM_ADDRESS"],
  })
  .refine((data) => data.NODE_ENV !== "production" || data.AUTH_ENABLED === "true", {
    message: "AUTH_ENABLED must be 'true' when NODE_ENV is 'production'",
    path: ["AUTH_ENABLED"],
  })
  .refine((data) => data.NODE_ENV !== "production" || data.RATE_LIMIT_ENABLED === "true", {
    message: "RATE_LIMIT_ENABLED must be 'true' when NODE_ENV is 'production'",
    path: ["RATE_LIMIT_ENABLED"],
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:", z.flattenError(parsed.error).fieldErrors);
  throw new Error("Invalid environment variables. Check your .env configuration.");
}

export type Env = z.infer<typeof schema>;

export const env: Env = parsed.data;
