# Heirs OCR — API Specification

| **Document Version** | **1.0.1**                  |
| -------------------- | -------------------------- |
| **Classification**   | **Internal (Engineering)** |
| **Project/System**   | **Heirs OCR Service**      |
| **Prepared By**      | **Samson Okunola**         |

## Table of contents

1. [Document control](#document-control)
2. [Approval block](#approval-block)
3. [Introduction](#introduction)
4. [Conventions](#common-conventions)
5. [OCR API](#ocr-api--v1ocr) — the caller-facing contract
6. [Security](#security)
7. [Subscriptions & entitlements](#subscriptions--entitlements)
8. [Data lifecycle](#data-lifecycle) — registry, archives, retention, logs, export
9. [Webhooks](#webhooks)
10. [Error handling and status codes](#error-handling-and-status-codes)
11. [Function catalog](#function-catalog) — per-function args, sensitivity, expected responses
12. [Deployment topology](#deployment-topology)
13. [Appendix A — Tenant Portal API](#appendix-a--tenant-portal-api-tenantapi)
14. [Appendix B — Admin API](#appendix-b--admin-api-adminapi)
15. [Glossary](#glossary)

## Document control

| Version | Date       | Author         | Change summary                                                                                                                                                                                                                                                                  |
| ------- | ---------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.0.1   | 2026-07-29 | Samson Okunola | Initial engineering specification for review.                                                                                                                                                                                                                                   |
| 1.0.0   | 2026-08-12 | Samson Okunola | Reconciled with the shipped service: 13 functions; Postgres-backed auth; GLM-OCR and async paths wired; subscription/billing entitlements; new error codes (`NOT_FOUND`, `PAYMENT_REQUIRED`, `QUOTA_EXCEEDED`, `INTERNAL`); Tenant Portal and Admin management APIs documented. |
| 1.0.1   | 2026-09-01 | Samson Okunola | Documented the expected response of every catalog function (`Expected responses`), plus a `Returns` column on the function catalog table. Documentation only — no endpoint, error code, auth or data-classification change.                                                     |

This document is the source of truth for the **external contract and security posture** of
the Heirs OCR Service. Changes to any endpoint, error code, authentication mechanism, or
data-classification rule described here require a version bump and re-approval.
[TECHNICAL.md](./TECHNICAL.md) describes _how_ the service is built; this document describes
_what it guarantees to callers_.

## Approval block

| Role                       | Name                 | Signature | Date       |
| -------------------------- | -------------------- | --------- | ---------- |
| Author / Engineer          | Samson Okunola       | S.Okunola | 12/08/2026 |
| Engineering Lead           | Monsuru Abdullahi    |           |            |
| Head, Software Engineering | Israel Emoitologa    |           |            |
| Security Reviewer          | Nathaniel Oladunmomi |           |            |
| Product Owner              |                      |           |            |

## Introduction

### Purpose

The Heirs OCR Service converts uploaded documents (PDF, image, DOCX, plain text) into
structured, validated data. It exposes a small, uniform HTTP API in which a caller selects
a **function** — a specific interpretation task such as receipt parsing or ID verification —
uploads a file, and receives a typed JSON result.

The guiding principle is **extraction is shared, interpretation is per-function.** Any
supported input is first normalized into a single canonical `RecognizedDocument`
(markdown + layout blocks), then the selected function interprets that canonical form. This
keeps the surface area small and makes new capabilities additive.

### Scope

**In scope for this version:**

- The synchronous request path: `POST /v1/ocr/:function`, returning a result in one round trip.
- The asynchronous path: uploads over the size/page thresholds return `202 Accepted` with a
  `statusUrl`, and `GET /v1/ocr/jobs/:id` reports status and result.
- The function catalog: `GET /v1/ocr/functions`.
- Liveness/readiness probes and the Prometheus scrape endpoint.
- The **thirteen** document functions in [Function catalog](#function-catalog).
- API-key authentication, per-tenant authorization, subscription entitlements, rate
  limiting, and the data-sensitivity policy.
- The management surfaces: the **Tenant Portal API** (Appendix A) and **Admin API**
  (Appendix B).

**Environment gating.** LLM-backed functions run only when Azure OpenAI is configured
(`AZURE_OPENAI_ENABLED=true`); otherwise they return a clear configuration error.
`TEXT_EXTRACTION` and `DOCUMENT_AUTHENTICITY` require no LLM. `SIGNING` is served best by the
GLM-OCR provider (`GLM_ENABLED=true`), whose `seals` capability lets it locate signature
regions and judge each from its own crop. With GLM off, image/scanned-PDF extraction falls
back to Tesseract and `SIGNING` still runs, via a whole-page vision pass that returns
`confidence: "low"`, a warning, and blocks without `bbox` — see the function notes below.

### Intended audience

- **Backend engineers** integrating with or extending the service.
- **Client/integration engineers** consuming the API from other Heirs systems (server-to-server).
- **Security reviewers** assessing the authentication, authorization, and data-handling controls.

### Reference documents

| Document                  | Location                             | Contents                                                                                |
| ------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------- |
| Technical reference       | [TECHNICAL.md](./TECHNICAL.md)       | Architecture, providers, GLM-OCR, tamper detection, billing, ops, security, governance. |
| Contribution guide        | [CONTRIBUTION.md](./CONTRIBUTION.md) | Setup, build, test, and extension conventions.                                          |
| Environment configuration | `src/config/env.ts`, `.env.example`  | All tunables and their defaults.                                                        |

## Common conventions

**Base URL:** `/v1/ocr` **Transport:** HTTPS, server-to-server (CORS default-closed; browser
origins are not permitted unless explicitly configured). **Content types:** requests use
`multipart/form-data`; responses are `application/json`.

- **File field:** the uploaded document is sent in the `file` multipart field. Exactly one
  file per request.
- **Args field:** function arguments are sent in the `args` multipart field as a **JSON
  string**. Optional; an empty/absent value is treated as `{}` and defaults apply.
- **File type is sniffed, not trusted.** The service ignores the client-supplied filename and
  MIME type and determines the true type from the file's magic bytes. A `.pdf` that is
  actually a JPEG is routed as an image; an unsupported binary is rejected.
- **Request ID:** every response (success or error) carries a `requestId`. Callers should log
  it and quote it in support requests.
- **Size cap:** uploads are capped at `MAX_FILE_SIZE_BYTES` (default 50 MiB), enforced during
  upload buffering. A subscription plan may impose a tighter per-document cap.

### List responses

Every collection endpoint on the management APIs (Appendices A and B) answers with one
envelope, so a client pages any list without special-casing it:

```jsonc
{
  "items": [...],
  "page": 1,        // the page actually served (a past-the-end request is clamped back)
  "pageSize": 25,   // default 25, capped at 200
  "total": 137,     // rows matching the request, across all pages
  "totalPages": 6
}
```

`?page=` and `?pageSize=` are both optional and advisory: an out-of-range or unparseable
value falls back to the default rather than returning 400 — a bad page number is not a reason
to refuse to render a list. Endpoints returning a fixed enumeration rather than a collection
of records (`GET /v1/ocr/functions`, `GET /admin/api/functions`) are **not** paginated.

Most lists are sliced in memory because the underlying tables are bounded. The three that are
not — `audit_events`, `documents`, and `request_logs`, each of which grows with time or
traffic — page in SQL with a `COUNT(*)` over the identical predicate, so `total` can never
disagree with `items`.

## OCR API — `/v1/ocr`

### 1. `GET /v1/ocr/functions` — Function catalog

Returns the catalog of available functions with their JSON Schemas, so callers can discover
capabilities, generate forms, and validate args client-side.

**Auth:** not required.

**Response 200:**

```json
{
  "functions": [
    {
      "key": "RECEIPT_PARSING",
      "description": "Parse a receipt into structured line items and totals.",
      "accepts": ["pdf", "image"],
      "requires": ["text"],
      "prefers": ["tables"],
      "sensitivity": "standard",
      "maxPages": 5,
      "argsSchema": { "...": "JSON Schema for the args object" },
      "resultSchema": { "...": "JSON Schema for the result object" }
    }
  ]
}
```

`requires` is a hard gate — a provider missing one of those capabilities cannot serve the
function — while `prefers` (optional) only ranks: a provider offering every preferred
capability is tried first, and the function still runs, degraded, when none is registered.
`RECEIPT_PARSING` prefers `tables` and `SIGNING` prefers `seals`, so both keep working with
`GLM_ENABLED=false` instead of failing the request.

`resultSchema` is omitted only for a function with no result shape at all until the caller
supplies one — `FORM_DATA_EXTRACTION`, whose args are a required union. A function whose
schema merely *varies* with its args still publishes its default shape: `RECEIPT_PARSING`
advertises the canonical receipt even though `fieldMap` can rename it. The live catalog is
authoritative for the exact `accepts`, `maxPages`, and schemas; the
[Function catalog](#function-catalog) table is a summary.

### 2. `POST /v1/ocr/:function` — Run a function

Runs the named function against an uploaded file and returns the validated result. Large or
multi-page uploads are queued instead (see [Async path](#3-async-path)).

**Path parameter:** `:function` — one of the catalog keys (e.g. `RECEIPT_PARSING`).

**Middleware order (each can short-circuit with a typed error):**
`auth → authorize → requireSubscription → rate-limit → sensitivity → upload → pipeline`.

**Request (`multipart/form-data`):**

| Field  | Type   | Required | Notes                                      |
| ------ | ------ | -------- | ------------------------------------------ |
| `file` | binary | yes      | The document. One file only.               |
| `args` | string | no       | JSON string of the function's args object. |

**Example (curl):**

```bash
curl -X POST https://<host>/v1/ocr/RECEIPT_PARSING \
  -H "Authorization: Bearer <api-key>" \
  -F "file=@receipt.jpg" \
  -F 'args={"currency":"NGN","expectedTaxRate":0.075,"lineItemMode":"multiple"}'
```

**Pipeline stages** (all in `src/pipeline.ts`; identical for sync and async):

1. **Ingest** — parse multipart, sniff magic bytes, SHA-256 the buffer, validate the detected
   type against the function's `accepts`.
2. **Extract** — route to a provider by required capability, recognize into a
   `RecognizedDocument`, with a fallback chain on provider error, and (for
   standard-sensitivity functions) an extraction cache.
3. **Interpret** — run the function's `execute` step (Azure OpenAI structured output for LLM
   functions; deterministic for the rest).
4. **Validate** — validate the output against the function's Zod result schema plus any
   business rules; only a conforming result is returned.

**Response 200 (success envelope):**

```json
{
  "requestId": "req_9f2a1c…",
  "function": "RECEIPT_PARSING",
  "result": {
    "merchant": { "name": "…", "address": "…", "tin": null },
    "dateTime": "2026-07-20T14:03:00",
    "currency": "NGN",
    "lineItems": [{ "description": "…", "qty": 2, "unitPrice": 500, "total": 1000 }],
    "subtotal": 1000,
    "tax": 75,
    "tip": null,
    "total": 1075,
    "paymentMethod": "CARD",
    "confidence": "high",
    "warnings": []
  },
  "meta": {
    "provider": "tesseract",
    "fellBackFrom": null,
    "pageCount": 1,
    "cached": false,
    "durationMs": 812,
    "tokensUsed": 1340
  }
}
```

The `result` shape is function-specific — every function's expected response is shown in
[Expected responses](#expected-responses). `meta` is uniform across functions and reports
which provider ran, whether a fallback occurred, page count, cache status, latency, and
token usage where applicable.

### 3. Async path

When an upload exceeds `ASYNC_SIZE_THRESHOLD_BYTES` or `ASYNC_PAGE_THRESHOLD` pages, a
`standard`-sensitivity request is queued rather than processed inline:

**Response 202 (`POST /v1/ocr/:function`):**

```json
{ "jobId": "1734", "statusUrl": "/v1/ocr/jobs/1734" }
```

The accepted envelope carries only these two fields (`sendAccepted` in
`src/http/respond.ts`) — there is no `requestId` or `status` on the 202, and the job id is
the queue's own id rather than a prefixed one. Poll `statusUrl` for the status.

A worker (`node build/worker.js`) runs the identical `runPipeline` off-request. `pii` and
`restricted` files are **never enqueued** — they always run inline and are held only in memory.

**`GET /v1/ocr/jobs/:id`** — job status + result. Requires auth. Scoped to the submitting
tenant: another tenant's job id resolves to `NOT_FOUND` (ids can't be enumerated across
tenants). Returns the job record (`status`, and `result`/`meta` on completion, or a typed
error code on failure).

### 4. Health, readiness & metrics

| Endpoint       | Purpose              | Auth                                 | Response                         |
| -------------- | -------------------- | ------------------------------------ | -------------------------------- |
| `GET /`        | Service banner       | none                                 | `{ "message": "Heirs OCR API" }` |
| `GET /healthz` | Liveness             | none                                 | `{ "status": "ok" }`             |
| `GET /readyz`  | Readiness            | none                                 | `{ "status": "ok", … }`          |
| `GET /metrics` | Prometheus scrape    | bearer (`METRICS_AUTH_TOKEN`) if set | Prometheus text format           |

> **Note:** `/readyz` probes Redis (`PING`), Postgres (`SELECT 1`) and blob storage, and answers
> `503` with a per-dependency breakdown when Redis or Postgres is unreachable. Blob storage is
> reported but does not gate readiness — it is optional, and reports healthy when switched off.

## Security

### Privacy and data classification

Every function declares a `sensitivity` level, and that declaration — not any per-call flag —
drives the handling policy centrally, where it cannot be bypassed at an individual call site.

| Level        | Meaning                                | Applies to                                                                     |
| ------------ | -------------------------------------- | ------------------------------------------------------------------------------ |
| `standard`   | Ordinary business documents            | Most functions                                                                 |
| `pii`        | Personal identifying information       | `ID_VERIFICATION`, `AUTO_EXTRACTION`, `LOAN_REVIEW`, `BANK_STATEMENT_ANALYSIS` |
| `restricted` | Reserved for future higher-sensitivity | —                                                                              |

For any non-standard function the service enforces, at distinct layers:

- **No raw text in logs.** The pipeline builds a redacting logger so document text and
  extracted identity fields never reach the log sink.
- **No trace body capture.** The interpretation span is created with result capture disabled.
- **`Cache-Control: no-store`** on the HTTP response.
- **No extraction caching** and **no async queueing** — a `pii`/`restricted` file is never
  persisted to Redis; it runs inline and its bytes are held only in memory.

**Upload handling:** files are held in memory only (never written to disk by the service),
size-capped before buffering completes, and limited to one file per request. The buffer's
SHA-256 is used as the cache key and trace-correlation id; the raw content is not persisted
beyond request handling (or the extraction cache TTL, for standard functions only).

### Authentication

- **Mechanism:** API-key. The caller sends `Authorization: Bearer <key>` or `X-API-Key: <key>`.
  In-app callers (the tenant portal) may instead present the tenant **session cookie**, which
  the OCR auth middleware accepts when no API key is present.
- **Storage:** keys are never stored in plaintext. The tenant registry lives in **Postgres**,
  keyed by the **SHA-256 of the API key**, so a database dump cannot be replayed as
  credentials. Newly minted keys use `hok_test_<uuid>` outside production and
  `hok_live_<uuid>` in production; legacy opaque keys remain valid because the
  server treats the submitted key as an opaque secret before hashing it.
- **Resolution:** a valid key resolves to a tenant, setting `req.tenantId` which scopes rate
  limiting, authorization, subscription, and caching. Resolution uses a short-TTL positive
  cache (`API_KEY_CACHE_TTL_SECONDS`) to stay off the Postgres hot path and ride out brief blips.
- **Fail-closed:** if the auth store is unreachable and nothing is cached, the request is
  **rejected** (503 `PROVIDER_UNAVAILABLE`, retryable) rather than admitted.
- **Revocation:** keys can be hard-revoked or soft-revoked (a disabled flag) at runtime, with
  no redeploy. The auth cache TTL bounds how long a revoked key stays valid.
- **Local-dev bypass:** `AUTH_ENABLED=false` disables auth entirely and assigns the anonymous
  tenant. **Throws at boot when `NODE_ENV=production`.**

### Authorization

- **Per-function scoping.** A tenant record may carry an `allowedFunctions` list. If present
  and non-empty, the requested `:function` must be in it; otherwise the request is rejected
  with 403 `FORBIDDEN`. An omitted/empty list allows all functions.
- **Subscription entitlements** layer on top of this — see next section.
- **Rate limiting.** Per-tenant fixed-window counter in Redis, keyed on `tenantId` (falling
  back to client IP). Default `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_SECONDS`
  (defaults 60 per 60 s), overridable per tenant and per plan. Exhaustion returns 429
  `RATE_LIMITED` (retryable). The limiter is **fail-open**: if Redis is unreachable it logs a
  warning and allows the request.

> **Deliberate asymmetry:** authentication **fails closed** (a broken security control must not
> admit traffic) while rate limiting **fails open** (a broken availability control must not
> deny traffic).

- **CORS.** Default-closed. The service is server-to-server; browser origins are not accepted
  unless explicitly configured (`CORS_ALLOWED_ORIGINS`). The `/admin` and `/tenant` management
  APIs are same-origin (served alongside the frontend) and need no CORS entry.

### Multi-factor authentication

Both interactive surfaces — the admin console and the tenant portal — support **TOTP**
(RFC 6238: SHA-1, 6 digits, 30-second steps, ±1 step of clock skew), so any standard
authenticator app enrols by scanning the `otpauth://` URI.

Login is **genuinely two-step whenever the account is enrolled.** The password POST does not
set a session cookie; it returns `{ "mfaRequired": true, "challenge": "<opaque>" }`, where the
challenge is a single-use Redis handle with a 5-minute TTL. `POST /api/login/mfa` trades that
handle plus a valid code for the real session. A stolen password is therefore not sufficient on
its own — there is no session to steal until the second factor lands. Failed code attempts
count against the same per-IP and per-email throttle buckets as failed passwords, because a
six-digit code is guessable in a way a password is not.

Enrolment is two-phase: `POST /security/mfa` stores the secret **unconfirmed**, and only
`POST /security/mfa/verify` — which requires a code derived from it — turns the factor on. An
authenticator that never received the secret therefore cannot lock the user out. Confirmation
mints **ten single-use recovery codes**, returned once and stored only as sha256 hashes; either
a TOTP code or a recovery code satisfies the login step. Each accepted TOTP step is persisted,
so a code observed in transit cannot be replayed for the remainder of its 30-second window.

Disabling MFA and re-minting recovery codes both re-check the account password: a hijacked
session must not be able to strip the account back to a single factor.

Losing both the authenticator and the recovery codes would otherwise be a permanent lockout —
the secret is unrecoverable and the codes are stored only as hashes — so an **owner** can clear
another account's factor (`DELETE /admin/api/admins/:id/mfa`, `DELETE /tenant/api/users/:id/mfa`,
the latter scoped to the caller's own org). Both are audited: the action lowers someone else's
account security, so the request should be verified out of band first.

### Self-service sign-up

Anyone may create an organisation from the portal's register page, unless the deployment sets
`SELF_SIGNUP_ENABLED=false` (in which case `POST /tenant/api/register` answers `403 FORBIDDEN`
and orgs are provisioned by an operator through the admin API instead).

The flow is deliberately two-step, and **nothing is written to Postgres until the second step**:

1. `POST /api/register` validates the password against the same policy as every other
   credential, checks the chosen plan exists and is not `hidden`, and holds the submitted
   details in Redis for 15 minutes under a six-digit code emailed to the address. Both the
   password and the code are stored as argon2id hashes, never in the clear.
2. `POST /api/verification` redeems the code, then creates the org and its first API key, the
   subscription, and the owner login — in that order, so a partial failure leaves an org an
   operator can finish rather than an owner locked inside one with no subscription. The
   response carries the raw API key **once**, and sets the session cookie.

Ordering it this way means an abandoned form leaves nothing behind, and nobody can claim an
organisation — or a colleague's email address — without proving they can read that mailbox.

Three abuse controls apply. Attempts are counted against the login throttle under a separate
`signup` scope, so a spray cannot lock anyone out of signing *in*. A code tolerates five wrong
guesses before the pending sign-up is destroyed, and a wrong guess does not extend its window.
Re-sends are rate-limited per sign-up so the endpoint cannot be used to mail-bomb an address.

An email that already has an account receives the same `202` and no mail: confirming it would
turn the endpoint into a membership oracle for any address someone cares to try. The person who
owns the mailbox learns the account exists by signing in or resetting the password.

### Sessions

Each account's live sessions are listed on its security page and can be revoked in bulk
(`DELETE /security/sessions`, both surfaces). Revocation is deliberately "everything except the
caller" rather than per-session: someone reaching for it has lost a device or suspects a
compromise, and identifying the right row from a list of IP addresses is exactly the judgement
they cannot reliably make. Session **tokens are never returned** — each row carries a short,
non-secret prefix as its id, along with the source IP, user agent and sign-in time.

Sessions are indexed per user in Redis alongside the session keys themselves. Without that
index a token answers "who is this?" but not "where else is this account signed in?", and
scanning the keyspace to find out would be O(all sessions) on every page render.

### Sign-in IP restrictions

An IP allowlist may restrict where a session is **established**: platform-wide for the console
(the `security` settings namespace) and per-organisation for the portal
(`GET/PUT /tenant/api/security/ip-allowlist`, owner only). Both accept bare addresses and CIDR
ranges, IPv4 and IPv6, including the IPv4-mapped form (`::ffff:203.0.113.4`) that Node reports
on a dual-stack listener — an allowlist written as `203.0.113.0/24` must still match a request
arriving that way, or the control behaves differently per deployment.

Entries are validated **on write**. A malformed entry matches nothing, so saving one into an
enabled list would deny every sign-in — a lockout caused by a typo. The tenant endpoint
additionally refuses a list that would block the caller's own address. **An empty list allows
everything:** that is the unconfigured state, not "deny all".

The check runs **before** password verification, so a denial cannot double as an oracle for
whether the password was right.

This restricts where a session may be established, not where an existing one may be used; a
session minted from an allowed address keeps working if its holder moves. Enforcing per request
would require the policy on the hot path, which is why the UI says "sign-ins".

### Passwords

Both surfaces expose a self-service change at `POST /security/password`. Three things happen
beyond writing the new hash:

- **The current password is required.** A session alone must not be enough, or a hijacked
  session becomes a permanent takeover by locking the real owner out.
- **Failures count against the login throttle.** The endpoint verifies a credential, so without
  that it is a rate-limit-free oracle for guessing the current password from inside a stolen
  session.
- **Every other session is revoked.** Someone changing their password usually believes they are
  compromised; leaving the attacker's session alive defeats the point.

The `passwordMinLength` setting in the `security` namespace is enforced **wherever a password is
set** — self-service changes, admin-created console users, tenant team members, and seeded
tenant owners — not only on the page that displays it. A hard floor of 8 applies regardless of
the setting, and a settings-store outage falls back to that floor rather than refusing every
password change.

### Audit trail

Every administrative mutation is recorded in `audit_events` and exposed at
`GET /admin/api/audit` (filterable by action prefix and actor, paged in SQL).

Each event carries both machine identifiers and human-readable names. `action` stays a stable
key (`tenant.revoked`) because filters and alerting match on it; `actionLabel` is the same event
as a sentence ("Revoked a tenant API key"), resolved on read from a label map so wording can be
improved without breaking a saved filter. An unregistered action degrades to a humanised form of
its key rather than leaking `foo.bar_baz` into the UI.

`actorLabel` and `targetLabel` name the people and organisations involved
(`Ada Obi (ada@x.com)`, `Acme Corp (acme)`) and are **snapshotted at write time** — they must
survive the thing they name being deleted (often that deletion is the very event), and must read
as the name was _then_, not as it is after a later rename.

## Subscriptions & entitlements

A tenant may be enrolled in a **subscription** to a **plan**. The `requireSubscription`
middleware (running after `authorize`, before `rate-limit`) loads the subscription and gates
the request on plan status, function entitlement, sensitivity ceiling, and document quota — and
publishes the plan's per-minute rate ceiling onto the rate limiter.

- **Backward-compatible:** a tenant with **no subscription** (or a briefly unreachable billing
  store) is treated as **unlimited** — nothing is gated. Only an explicit subscription imposes
  limits.
- **Status gate:** `trialing`, `active`, and `past_due` are served; `expired`, `canceled`, and
  `suspended` are rejected with 402 `PAYMENT_REQUIRED`.
- **Entitlement gate:** a function outside the plan's `allowedFunctions`, or above its
  `maxSensitivity` ceiling, is rejected with 403 `FORBIDDEN`.
- **Quota gate:** an exhausted period/trial document allowance is rejected with 429
  `QUOTA_EXCEEDED` (retryable next period or after upgrade). Monthly plans with an overage
  price never hard-stop — they bill the overage.
- **Metering:** each processed document is metered against the subscription (period usage +
  per-document/overage charge + trial burn-down). The inline path meters on completion; async
  jobs are metered by the worker.

Plan tiers, prices, and limits are defined in TECHNICAL.md § Billing & subscriptions. Plans are
managed as data via the Admin API (Appendix B).

## Data lifecycle

### The document registry

Every document processed through a **`standard`**-sensitivity function is recorded in a
registry that backs the tenant portal's document list and reports. The registry holds
**metadata only** — filename, function, page count, byte size, outcome, provider, duration.
No file bytes, no extracted text, and no interpreted result are persisted by it.

Documents processed by **`pii`** or **`restricted`** functions are **not recorded at all**.
This is deliberately stricter than redacting fields: a filename is itself identifying
(`jane-smith-passport.pdf`), and the existence of a row would disclose that a named individual
was screened. Consequently the document list is _not_ a complete account of everything a tenant
submitted — the aggregate usage counters (`GET /tenant/api/billing`) remain the authoritative
total, and the portal says so on the page.

Failures are recorded alongside successes: "we sent it and it bounced" is the case a tenant is
most likely to come looking for.

### Archived source files (object storage)

When `BLOB_STORAGE_ENABLED=true`, the source file is also archived to S3-compatible object
storage and the registry row carries its `storageKey`. This is **off by default** — keeping the
bytes is a materially different privacy posture from a metadata-only registry, so it is switched
on deliberately rather than arriving with a deploy. The sensitivity rule still governs:
`pii`/`restricted` documents are never recorded and never uploaded.

Keys are `documents/<tenant>/<date>/<uuid>/<name>`; the uuid carries uniqueness, not the
(attacker-controlled) filename, which is sanitised against traversal. Upload runs off the
response path and is best-effort — the OCR request has already succeeded, so a storage outage
leaves the document recorded with no key rather than failing the call.

Downloads are issued as **short-lived presigned URLs**
(`GET /tenant/api/documents/:id/download`, `S3_DOWNLOAD_URL_TTL_SECONDS`, default 300) so the
bytes travel from the store to the browser without occupying an API process. Tenant ownership is
checked when the link is minted; the link itself is a bearer URL, hence the short window.

The same code path talks to MinIO locally and real S3 in production — only `S3_ENDPOINT` differs.

### Retention

Records are deleted by an hourly **retention sweep** running in the worker, governed by the
`retention` settings namespace (`documentRetentionDays`, default 90; `auditRetentionDays`,
default 365; `enabled`, which suspends the sweep). It covers document records **and their
archived files**, audit events, webhook deliveries, and request logs — the row is only an index,
so purging it alone would leave documents in the bucket forever while the console reported them
gone.

The cutoff is recomputed from the current policy on every run rather than stamped onto each row
at insert, so **shortening a window trims the existing backlog** rather than applying only to new
records. Replicas coordinate through a Redis lock so one sweep runs per window, and a Redis
outage skips the sweep rather than running it unguarded. `POST /admin/api/retention/sweep`
(manager, audited) runs it immediately.

### Tenant request logs

`GET /tenant/api/logs` returns the org's own API call history — method, path, function, status,
error code, duration, and request id. No request or response body is recorded.

This is deliberately **not** the platform log stream (`GET /admin/api/logs`), which is
operator-facing and spans every tenant. It is also not the document registry: that records
documents that were _processed_, whereas this records _requests_, so it is the only place a
tenant can see the calls that never became documents — a 402 over quota, a 429, an unsupported
file type. Those are precisely what debugging an integration turns on.

Recorded by middleware mounted above the auth and entitlement guards, so refusals are captured
too, and written on response `finish` so it stays off the response path. A request that failed
**authentication** is not recorded: there is no tenant to attribute it to, and inferring one
from a rejected key would be worse than the gap.

### Tenant data export

`GET /tenant/api/backup/export` (owner only) returns the org's own documents, API key metadata
and team members as JSON.

**It is an export, not a restorable backup, and the difference is by design.** Two of the three
sections are deliberately unrecoverable:

- **API keys** are stored as sha256 of the raw key, which is shown once at creation and never
  again. The export carries the hash, limits and expiry — nothing that authenticates a request.
- **Team members** are stored with argon2id password hashes. Those are credential material;
  writing them into a file a browser downloads would hand anyone who obtained it an offline
  cracking target for every account in the org. They are omitted entirely.

Restoring this file would therefore produce keys that do not work and users who cannot sign in.
Rather than offer a restore that silently cannot restore the parts that matter, the endpoint is
framed as record-keeping and portability, and the file restates its own exclusions in an
`excluded` field so a reader of the JSON — not just of the UI — knows what it is. Source
documents are excluded too (each is individually downloadable); the document history is capped,
with a `truncated` flag so a short file is never mistaken for a complete one.

The download is **audited** (`tenant.export.downloaded`): it is the single request that reads
out everything the org holds, which is the shape of an exfiltration, and an owner should be able
to see when one happened and who asked.

This is unrelated to the admin-side configuration backup (`/admin/api/backups`), which snapshots
the platform catalog, contains no credentials, and genuinely restores.

## Webhooks

A tenant may register endpoints (`/tenant/api/webhooks`, **owner only** — an endpoint receives
the org's event stream, so adding one is a data-egress decision) subscribed to
`document.processed` and `document.failed`. URLs must be `https` outside development.

**Plan-gated.** Webhooks are a plan feature (`business` and `enterprise`); the routes that create
or widen delivery — create, update, rotate-secret, test — answer `403 NOT_ENTITLED` without it,
and dispatch checks entitlement too, so a downgrade stops delivery rather than leaving
grandfathered endpoints firing. List, the delivery log and delete stay open on every plan:
a tenant who downgrades must still be able to see what they have and take it down. A tenant
with no subscription row at all is unlimited, as everywhere else. `503 PROVIDER_UNAVAILABLE`
if the billing store cannot be read — the gate fails closed.

**Destination guard.** In production a webhook URL may not point at a private, loopback,
link-local (including `169.254.169.254`), CGNAT or multicast address, whether given as an IP
literal or reached by DNS; `400 INVALID_ARGS` at registration. The same check runs again before
every send, because a hostname that resolved publicly when it was saved can be re-pointed
afterwards — a delivery blocked at that point is marked `dead` immediately rather than retried.
A host that fails to resolve is *not* blocked: that is a normal transient condition the retry
path already handles. Combined with `redirect: "manual"` in the worker, this closes both the
direct and redirect-based routes to internal services.

**At most 10 endpoints per org** (`409 LIMIT_REACHED`): every endpoint multiplies the outbound
fan-out of every document processed.

**Signing.** Every delivery carries `X-Heirs-Signature: t=<unix>,v1=<hmac>`, an HMAC-SHA256 over
`<timestamp>.<body>` keyed by the endpoint's secret, plus `X-Heirs-Delivery` (stable across
retries, so receivers can dedupe) and `X-Heirs-Event`. The timestamp is **inside** the signed
material: signing the body alone would make any captured delivery replayable forever, whereas
here a receiver can reject anything older than its tolerance and an attacker cannot advance the
clock without invalidating the MAC. The secret is returned at creation and on rotation only — it
is not recoverable, and rotating invalidates the previous one immediately.

**Payloads follow the registry's privacy rule.** `fileName` is omitted for `pii`/`restricted`
functions. The event still fires — the tenant learns a document was processed, not what it was
called. The reasoning is the document registry's, and it binds harder here because a webhook
sends the value to a third-party URL rather than storing it.

**Delivery** runs in the worker as an outbox: `webhook_deliveries` is both the queue and the
log, because the retry state a worker needs is the same state the tenant's deliveries page
displays, and splitting them would mean keeping two copies in step. Rows are claimed with
`FOR UPDATE ... SKIP LOCKED` so several workers never send the same delivery.

Failures — **including 4xx**, which is usually a deploy in flight rather than a permanent
refusal — retry with exponential backoff (10s doubling) up to 6 attempts, after which the
delivery is marked `dead`. An unbounded retry queue against a host that is not coming back is
how a webhook system becomes an outage of its own. Deliveries whose endpoint was deleted are
marked dead rather than left pending forever. `POST /tenant/api/webhooks/:id/test` queues a
synthetic event so a receiver can be verified end to end, signature included, without waiting
for a real document.

## Error handling and status codes

All errors are returned as a single uniform envelope. A raw provider or internal error is
never surfaced; every error is mapped to a typed code that callers can switch on.

**Error envelope:**

```json
{
  "error": {
    "code": "FILE_TOO_LARGE",
    "message": "Human-readable explanation.",
    "requestId": "req_9f2a1c…",
    "retryable": false,
    "details": null
  }
}
```

`retryable` tells the caller whether a straight retry may succeed. `details` is optional and,
when present, carries structured validation issues.

**Codes and HTTP status:**

| Code                       | HTTP | Retryable | When                                                                        |
| -------------------------- | ---- | --------- | --------------------------------------------------------------------------- |
| `UNAUTHORIZED`             | 401  | no        | Missing, invalid, or revoked API key.                                       |
| `PAYMENT_REQUIRED`         | 402  | no        | No active/paid subscription (expired, canceled, or suspended).              |
| `FORBIDDEN`                | 403  | no        | Key/plan not authorized for the function, or above the sensitivity ceiling. |
| `NOT_FOUND`                | 404  | no        | Unknown job id (or one belonging to another tenant).                        |
| `INVALID_ARGS`             | 400  | no        | Unknown function, missing file, or bad args.                                |
| `FILE_TOO_LARGE`           | 413  | no        | Upload exceeds `MAX_FILE_SIZE_BYTES` or the plan's file cap.                |
| `UNSUPPORTED_MEDIA_TYPE`   | 415  | no        | Sniffed type unsupported or not in the function's `accepts`.                |
| `PAGE_LIMIT_EXCEEDED`      | 422  | no        | Document exceeds the function's (or plan's) `maxPages`.                     |
| `NO_TEXT_DETECTED`         | 422  | no        | Extraction produced no usable text.                                         |
| `SCHEMA_VALIDATION_FAILED` | 422  | no        | Function output failed its result schema/business rules.                    |
| `RATE_LIMITED`             | 429  | yes       | Per-tenant/plan rate limit exceeded.                                        |
| `QUOTA_EXCEEDED`           | 429  | yes       | Plan/trial document allowance exhausted (retry next period or upgrade).     |
| `EXTRACTION_FAILED`        | 502  | yes       | All providers in the fallback chain failed.                                 |
| `INTERPRETATION_FAILED`    | 502  | no        | The function's execute/LLM step failed.                                     |
| `PROVIDER_UNAVAILABLE`     | 503  | yes       | Auth store, queue, or a required provider is unreachable.                   |
| `INTERNAL`                 | 500  | no        | Unexpected server-side fault (a bug, not a provider/input problem).         |

**Fallback behaviour.** During extraction, if the primary provider errors, the service tries
each configured fallback in turn. A successful fallback stamps `meta.fellBackFrom` with the
primary provider's name; only if the entire chain fails is `EXTRACTION_FAILED` returned.

## Function catalog

The live `GET /v1/ocr/functions` response is authoritative. Summary of the thirteen functions:

| Function key              | Purpose                                                                | Accepts                | LLM    | Sensitivity | Returns (`result` top level)                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------- | ---------------------- | ------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TEXT_EXTRACTION`         | Return the canonical extracted text/markdown.                          | pdf, image, docx, text | no     | standard    | `text`, `format`, `pageCount`, `blocks?`                                                                                                                   |
| `DOCUMENT_CLASSIFICATION` | Classify the document into a type.                                     | pdf, image, docx, text | yes    | standard    | `label`, `confidence`, `alternatives`, `rationale`                                                                                                         |
| `RECEIPT_PARSING`         | Structured line items, totals, tax reconciliation.                     | pdf, image             | yes    | standard    | `merchant`, `dateTime`, `currency`, `lineItems`, `subtotal`, `tax`, `tip`, `total`, `paymentMethod`, `confidence`, `warnings`                              |
| `FORM_DATA_EXTRACTION`    | Extract caller-specified fields (dynamic schema).                      | pdf, image, docx, text | yes    | standard    | `fields` — one key per requested field                                                                                                                     |
| `RESUME_PARSING`          | Structured résumé (contact, experience, education).                    | pdf, image, docx, text | yes    | standard    | `contact`, `summary`, `experience`, `education`, `certifications`, `professionalBodies`, `languages`, `skills`                                             |
| `ID_VERIFICATION`         | Read ID fields + MRZ; verify against expected values.                  | pdf, image             | yes    | **pii**     | `documentType`, `fields`, `checks`, `assuranceLevel`                                                                                                       |
| `SIGNING`                 | Detect signatures/seals and execution status.                          | pdf, image             | vision | standard    | `fullyExecuted`, `blocks`, `unsignedBlocks`, `confidence`, `warnings`                                                                                      |
| `DOCUMENT_AUTHENTICITY`   | Deterministic tamper analysis on raw bytes (no OCR, no LLM).           | pdf, image             | no     | standard    | `verdict`, `score`, `signals`, `analyzer`, `assuranceLevel`, `notes?`                                                                                      |
| `AUTO_EXTRACTION`         | Classify the document, then route it to the matching parser.           | pdf, image, docx       | yes    | **pii**     | `documentType`, `handler`, `classification`, `data`, `validation`                                                                                          |
| `BUDGET_ANALYSIS`         | Categorized budget line items + deterministic totals reconciliation.   | pdf, image, docx       | yes    | standard    | `title`, `period`, `currency`, `lineItems`, `totals`, `confidence`, `warnings`                                                                             |
| `EXPENSE_CLAIM`           | Claimant, line items, totals + reconciliation + missing-receipt check. | pdf, image, docx       | yes    | standard    | `claimant`, `title`, `dateSubmitted`, `currency`, `lineItems`, `subtotal`, `tax`, `total`, `confidence`, `warnings`                                        |
| `LOAN_REVIEW`             | Borrower financials + deterministic affordability recommendation.      | pdf, image             | yes    | **pii**     | `borrower`, `requestedAmount`, `tenorMonths`, `income`, `obligations`, `affordability`, `recommendation`, `riskFlags`, `summary`, `confidence`, `warnings` |
| `BANK_STATEMENT_ANALYSIS` | Transactions/balances + inflow/outflow reconciliation.                 | pdf, image             | yes    | **pii**     | `accountHolder`, `accountNumber`, `bank`, `period`, `openingBalance`, `closingBalance`, `currency`, `transactions`, `summary`, `confidence`, `warnings`    |

`pii` functions are never cached or queued and always run inline.

### Expected responses

Every function returns the same envelope — `requestId`, `function`, `meta`, and a
per-function `result` — so only `result` is shown below. Fields typed `nullable` in the
schema are **always present** and come back `null` when the document does not carry them;
only fields marked `?` here are omitted entirely. Arrays come back `[]`, never `null`.
The live JSON Schemas at `GET /v1/ocr/functions` remain authoritative.

Where a `confidence` field appears it is a **deterministic** verdict recomputed in code
(totals reconciliation, MRZ checksums, detection path), not the model's self-assessment —
`"low"` means the recomputation disagreed or could not run, and `warnings` says why.

#### `TEXT_EXTRACTION`

`blocks` is returned only when the request set `includeBlocks: true`; `bbox` only when the
provider reported layout geometry.

```json
{
  "text": "# Invoice\n\nAcme Ltd\n\n| Item | Amount |\n| ---- | ------ |",
  "format": "markdown",
  "pageCount": 2,
  "blocks": [
    { "index": 0, "page": 1, "label": "text", "bbox": [0.08, 0.05, 0.92, 0.11], "content": "# Invoice" }
  ]
}
```

#### `DOCUMENT_CLASSIFICATION`

```json
{
  "label": "Receipt",
  "confidence": 0.94,
  "alternatives": [{ "label": "Invoice", "confidence": 0.05 }],
  "rationale": "Merchant header, itemized lines and a VAT total."
}
```

#### `RECEIPT_PARSING`

```json
{
  "merchant": { "name": "Shoprite", "address": "12 Awolowo Rd, Lagos", "tin": "01234567-0001" },
  "dateTime": "2026-02-14T18:32:00+01:00",
  "currency": "NGN",
  "lineItems": [{ "description": "Milk 1L", "qty": 2, "unitPrice": 1500, "total": 3000 }],
  "subtotal": 3000,
  "tax": 225,
  "tip": null,
  "total": 3225,
  "paymentMethod": "card",
  "confidence": "high",
  "warnings": []
}
```

With `lineItemMode: "single"` the same response carries exactly one synthesized line
holding the subtotal — see [`RECEIPT_PARSING` — itemized or single-line](#receipt_parsing--itemized-or-single-line).
With a `fieldMap` the keys are the caller's own — see
[`RECEIPT_PARSING` — caller field names](#receipt_parsing--caller-field-names).

#### `FORM_DATA_EXTRACTION`

The shape is the caller's own: one key under `fields` per requested field, typed as the
spec declared it. Required fields are non-null; optional ones come back `null` when absent.

```json
{ "fields": { "policyNumber": "PL-88213", "premium": 45000, "renewalDate": "2026-11-01", "lapsed": false } }
```

#### `RESUME_PARSING`

```json
{
  "contact": {
    "name": "Ada Obi", "email": "ada@example.com", "phone": "+234...", "location": "Lagos",
    "address": null, "state": "Lagos", "country": "Nigeria", "zip": null, "nationality": "Nigerian",
    "links": ["https://linkedin.com/in/..."]
  },
  "summary": "Backend engineer, 8 years.",
  "experience": [
    { "company": "Acme", "title": "Senior Engineer", "startDate": "2021-03", "endDate": null, "current": true, "description": "Payments platform." }
  ],
  "education": [
    { "institution": "University of Lagos", "degree": "BSc", "field": "Computer Science", "startDate": "2013", "endDate": "2017" }
  ],
  "certifications": [{ "name": "AWS SAA", "issuer": "Amazon", "date": "2023-06" }],
  "professionalBodies": ["NCS"],
  "languages": [{ "name": "English", "level": "native" }],
  "skills": [{ "name": "TypeScript", "level": "expert" }]
}
```

#### `ID_VERIFICATION`

`checks.nameMatch` / `dobMatch` / `numberMatch` are `null` unless the request supplied the
corresponding expected value; `mrzValid` is `null` when the document carries no MRZ.
`assuranceLevel` is fixed at `"document-content-only"` — this verifies the document's own
consistency, never that the holder is who they claim to be.

```json
{
  "documentType": "PASSPORT",
  "fields": {
    "fullName": "ADA OBI", "dateOfBirth": "1995-04-02", "documentNumber": "A01234567",
    "issueDate": "2021-05-10", "expiryDate": "2031-05-09", "nationality": "NGA",
    "sex": "F", "placeOfBirth": "LAGOS", "address": null,
    "licenceCategory": null, "issuingAuthority": "NIS"
  },
  "checks": {
    "expired": false, "expiryDate": "2031-05-09",
    "nameMatch": true, "dobMatch": true, "numberMatch": null, "mrzValid": true
  },
  "assuranceLevel": "document-content-only"
}
```

#### `SIGNING`

`bbox`, `signatoryName`, `signedDate` and `cropUrl` are omitted when the path that ran could
not establish them — the whole-page fallback has no geometry. Read `confidence` before
acting on `fullyExecuted`; see [`SIGNING` — two detection paths](#signing--two-detection-paths).

```json
{
  "fullyExecuted": false,
  "blocks": [
    { "label": "Lessor", "page": 3, "bbox": [0.1, 0.72, 0.45, 0.8], "signed": true, "signatoryName": "Ada Obi", "signedDate": "2026-01-12", "hasSeal": true },
    { "label": "Lessee", "page": 3, "bbox": [0.55, 0.72, 0.9, 0.8], "signed": false, "hasSeal": false }
  ],
  "unsignedBlocks": ["Lessee"],
  "confidence": "high",
  "warnings": []
}
```

#### `DOCUMENT_AUTHENTICITY`

No OCR and no LLM: the verdict comes from raw-bytes heuristics, so `assuranceLevel` is
pinned to `"heuristic-only"` and a `clean` verdict is not a guarantee of authenticity.

```json
{
  "verdict": "suspicious",
  "score": 0.62,
  "signals": [
    { "code": "PDF_INCREMENTAL_UPDATE", "severity": "medium", "detail": "3 incremental saves after the original." }
  ],
  "assuranceLevel": "heuristic-only",
  "analyzer": "pdf",
  "notes": ["Producer metadata rewritten."]
}
```

#### `AUTO_EXTRACTION`

An envelope around whichever parser ran. `data` holds that parser's own result — its shape
follows `handler` (`resume` → `RESUME_PARSING`, `id` → `ID_VERIFICATION`, `receipt` →
`RECEIPT_PARSING`, `template` → `FORM_DATA_EXTRACTION`), so branch on `handler` before
reading it. When classification confidence is too low to route, `documentType` is
`"unknown"`, `handler` is `"none"`, and `data` and `validation` are `null`.

```json
{
  "documentType": "Receipt",
  "handler": "receipt",
  "classification": {
    "confidence": 0.93,
    "alternatives": [{ "label": "Invoice", "confidence": 0.04 }],
    "rationale": "Merchant header with itemized lines."
  },
  "data": { "merchant": { "name": "Shoprite" }, "total": 3225, "confidence": "high" },
  "validation": null
}
```

#### `BUDGET_ANALYSIS`

```json
{
  "title": "Q1 Marketing Budget",
  "period": "2026-Q1",
  "currency": "NGN",
  "lineItems": [
    { "category": "Advertising", "description": "Paid social", "planned": 500000, "actual": 540000, "variance": -40000 }
  ],
  "totals": { "planned": 500000, "actual": 540000, "variance": -40000 },
  "confidence": "high",
  "warnings": []
}
```

#### `EXPENSE_CLAIM`

```json
{
  "claimant": { "name": "Ada Obi", "employeeId": "EMP-102", "department": "Engineering" },
  "title": "Client visit — Abuja",
  "dateSubmitted": "2026-03-04",
  "currency": "NGN",
  "lineItems": [
    { "date": "2026-03-01", "category": "Transport", "description": "Flight LOS–ABV", "amount": 180000, "receiptAttached": true },
    { "date": "2026-03-02", "category": "Meals", "description": "Dinner", "amount": 22000, "receiptAttached": false }
  ],
  "subtotal": 202000,
  "tax": 0,
  "total": 202000,
  "confidence": "low",
  "warnings": ["1 line item has no supporting receipt."]
}
```

#### `LOAN_REVIEW`

`affordability` and `recommendation` are computed from the extracted income and
obligations, never taken from the model. `recommendation` is
`approve` | `review` | `decline` | `insufficient-data` — the last when the document did not
carry enough to compute a ratio at all.

```json
{
  "borrower": { "name": "Ada Obi", "dateOfBirth": "1995-04-02", "bvn": "2214****91", "employmentStatus": "employed", "employer": "Acme Ltd" },
  "requestedAmount": 5000000,
  "currency": "NGN",
  "tenorMonths": 24,
  "income": { "monthly": 900000 },
  "obligations": { "monthlyDebt": 250000 },
  "riskFlags": ["Payslip employer differs from application employer."],
  "summary": "Salaried applicant with one existing obligation.",
  "affordability": { "debtToIncome": 0.28, "disposableIncome": 650000 },
  "recommendation": "review",
  "confidence": "high",
  "warnings": []
}
```

#### `BANK_STATEMENT_ANALYSIS`

`summary` is recomputed from `transactions`; `confidence` is `"high"` only when
`openingBalance + totalCredits − totalDebits` reconciles to `closingBalance`.

```json
{
  "accountHolder": "ADA OBI",
  "accountNumber": "0123456789",
  "bank": "Heirs Bank",
  "period": { "start": "2026-01-01", "end": "2026-01-31" },
  "openingBalance": 120000,
  "closingBalance": 415000,
  "currency": "NGN",
  "transactions": [
    { "date": "2026-01-03", "description": "SALARY JAN", "debit": null, "credit": 900000, "balance": 1020000 },
    { "date": "2026-01-05", "description": "RENT", "debit": 605000, "credit": null, "balance": 415000 }
  ],
  "summary": { "totalCredits": 900000, "totalDebits": 605000, "netFlow": 295000, "transactionCount": 2 },
  "confidence": "high",
  "warnings": []
}
```

### `RECEIPT_PARSING` — itemized or single-line

Callers decide how an upload is reported with the `lineItemMode` arg:

| `lineItemMode` | `lineItems` returned                                   | Use when                                                    |
| -------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| `"multiple"`   | One entry per line printed on the receipt. *(default)* | You need the itemized basket.                               |
| `"single"`     | Exactly one entry carrying the whole receipt.          | You book the upload as one expense and the items are noise. |

This is a reporting choice, not a parsing one. The receipt is **always** parsed itemized and
collapsed only afterwards, so totals reconciliation still runs against the real printed lines
in both modes — a receipt whose items don't sum to its subtotal still comes back with
`confidence: "low"` and the same warning. Collapsing cannot make a bad receipt look clean.

The synthesized line carries the **subtotal**, not the grand total: line items sit below tax
and tip in the result shape (`lineItems → subtotal → + tax + tip → total`), so a caller that
re-adds VAT downstream does not double-count it. Its `description` is the merchant name plus
the number of lines it replaced (e.g. `"Shoprite (7 items)"`), so the collapse stays visible.
`subtotal`, `tax`, `tip`, and `total` are untouched in both modes.

Edge cases: a receipt that already had exactly one line is returned unchanged, keeping its
real description; an unitemized receipt that printed only a grand total still yields one line
(subtotal recovered as `total - tax - tip`); and a receipt with no recoverable amount returns
`lineItems: []` rather than a zero-value placeholder.

### `RECEIPT_PARSING` — caller field names

By default the response uses the canonical field names above. The optional `fieldMap` arg
reports the receipt under the caller's own names instead: **keys select** which fields come
back, **values rename** them.

```bash
curl -X POST https://<host>/v1/ocr/RECEIPT_PARSING \
  -H "Authorization: Bearer <api-key>" \
  -F "file=@receipt.jpg" \
  -F 'args={"fieldMap":{"merchant.name":"vendor","total":"amount_due","lineItems.description":"item","lineItems.total":"line_total"}}'
```

```json
{
  "vendor": "Shoprite",
  "amount_due": 3225,
  "lineItems": [{ "item": "Milk 1L", "line_total": 3000 }],
  "confidence": "high",
  "warnings": []
}
```

Valid keys are the canonical paths: `merchant.name`, `merchant.address`, `merchant.tin`,
`dateTime`, `currency`, `subtotal`, `tax`, `tip`, `total`, `paymentMethod`, `lineItems`,
`lineItems.description`, `lineItems.qty`, `lineItems.unitPrice`, `lineItems.total`,
`confidence`, `warnings`. Values must be identifiers (`[A-Za-z_][A-Za-z0-9_]*`, ≤ 64 chars).

| Mapping                   | Effect                                                                  |
| ------------------------- | ----------------------------------------------------------------------- |
| `"total": "amount_due"`   | Returns that scalar under `amount_due`; unmapped scalars are omitted.   |
| `"lineItems": "items"`    | Renames the array, keeping canonical item keys.                         |
| `"lineItems.qty": "count"`| Selects and renames within each item; the array stays named `lineItems` unless also mapped. |

Like `lineItemMode`, this is a **reporting** choice, not a parsing one. The receipt is always
parsed and reconciled canonically and only projected afterwards, so the prompt never sees the
caller's names and totals reconciliation is unaffected. The reconciliation verdict
(`confidence`, `warnings`) is therefore **always returned** — map it to rename it, but it
cannot be dropped: a caller who asked only for `total` must still be told the receipt did not
add up.

Rejected as `INVALID_ARGS` (400): an unknown field path, two fields mapped onto one output
name, an empty map, and non-identifier or reserved names (`__proto__`, `constructor`,
`prototype`). Omit `fieldMap` entirely for the canonical shape — the default is unchanged.

### `SIGNING` — two detection paths

`SIGNING` requires `layout`, and *prefers* a provider that also offers `seals` (GLM-OCR).
Which path ran is reported on every response, and callers should branch on it rather than
reading `fullyExecuted` alone:

| Path            | When                            | `confidence` | `bbox`  | Cost                |
| --------------- | ------------------------------- | ------------ | ------- | ------------------- |
| Region crops    | provider offers `seals`         | `high`       | present | one crop per slot   |
| Whole-page      | provider lacks `seals`          | `low`        | absent  | one call per page   |

The whole-page path exists so signature checking survives a GLM outage or a deliberate
`GLM_ENABLED=false`. It cannot locate regions, so it hands whole page images to the vision
model, which both finds and judges the blocks. It is less reliable and reports so: expect
`confidence: "low"` and a `warnings` entry naming the degraded path. `geometryOnly` has no
meaning on this path and returns no blocks plus an explanatory warning.

Its page budget is `maxVisionPages` (default 3). Pages whose text carries one of
`signatureCues` are scanned, latest first; a document with no cue text falls back to its last
page. When candidates exceed the budget a warning names the pages actually examined.

## Deployment topology

The image runs **two process types** from one build (12-factor VIII): `node build/index.js`
(HTTP) and `node build/worker.js` — the OCR queue, the retention sweep, and webhook delivery.

Deploying only the default command would leave every background feature silently inert: queued
documents never processed, retention never swept, webhooks queued and never sent. To make that
impossible, the web process **also runs the background work by default**
(`RUN_BACKGROUND_WORKERS`, default `true`), so a single container is a complete service. Set it
to `false` on the web process only where a dedicated worker container is deployed beside it;
`docker-compose.yml` and `docker-compose-prod.yml` both do exactly that.

Running the background work in both places is safe rather than merely tolerated: the retention
sweep takes a Redis lock, webhook delivery claims rows with `FOR UPDATE ... SKIP LOCKED`, and
BullMQ locks each job, so duplicate runners coordinate instead of double-processing.

Boot waits for Postgres and Redis before accepting traffic, retrying a transient failure (a DNS
hiccup resolving a managed host returns `EAI_AGAIN` — "try again") before giving up. A genuinely
unreachable store still ends in a non-zero exit, and both compose files set
`restart: unless-stopped` so an orchestrator or the Docker daemon brings the container back.

## Appendix A — Tenant Portal API (`/tenant/api`)

Same-origin JSON API for a tenant's own users (served behind the Next.js portal). All routes
except sign-up and login require a **tenant session cookie**; management routes require the
`owner` role. Every route is scoped to the caller's own tenant org — a tenant can never read or
mutate another org's keys or users. Errors use a `{ error: { code, message } }` shape.

| Method + path                           | Role   | Purpose                                                                  |
| --------------------------------------- | ------ | ------------------------------------------------------------------------ |
| `GET  /api/plans`                       | open   | Self-serve plan catalog for the register form (`hidden` plans excluded). |
| `POST /api/register`                    | open   | Start a sign-up: holds the details, emails a code. Creates nothing yet.  |
| `POST /api/verification`                | open   | Redeem the code — creates the org, subscription and owner; signs in.     |
| `POST /api/verification/resend`         | open   | Re-send the code for a sign-up in flight. Cooldown-limited.              |
| `POST /api/login`                       | open   | Authenticate. Returns a session, or an MFA challenge. Login-throttled.   |
| `POST /api/login/mfa`                   | open   | Redeem an MFA challenge for a session. Login-throttled.                  |
| `POST /api/logout`                      | member | Destroy the session.                                                     |
| `GET  /api/me`                          | member | Current user + tenant + role.                                            |
| `POST /api/security/password`           | member | Change own password. Revokes every other session.                        |
| `GET  /api/security/sessions`           | member | Live sign-ins for this account. Never returns tokens.                    |
| `DELETE /api/security/sessions`         | member | Sign out every other session; the caller's stays live.                   |
| `GET  /api/security/mfa`                | member | Second-factor status (`enabled`, `pending`, codes remaining).            |
| `POST /api/security/mfa`                | member | Begin enrolment — returns the secret + `otpauth://` URI.                 |
| `POST /api/security/mfa/verify`         | member | Confirm enrolment; returns one-time recovery codes.                      |
| `DELETE /api/security/mfa`              | member | Disable MFA. Requires the account password.                              |
| `POST /api/security/mfa/recovery-codes` | member | Re-mint recovery codes. Requires the password.                           |
| `GET/PUT /api/security/ip-allowlist`    | owner  | The org's sign-in IP restrictions.                                       |
| `GET  /api/billing`                     | member | Current subscription plus lifetime OCR usage counters.                   |
| `GET  /api/documents`                   | member | Processed-document history (paginated; PII runs excluded).               |
| `GET  /api/documents/report`            | member | Aggregated activity over a trailing window, plus the retention policy.   |
| `GET  /api/documents/:id/download`      | member | Short-lived presigned URL for the archived source file.                  |
| `GET  /api/jobs`                        | member | Recent async OCR jobs (status, timings, attempts).                       |
| `GET  /api/logs`                        | member | The org's API request history, including refused calls.                  |
| `GET  /api/backup`                      | owner  | What a data export would contain (counts + exclusions).                  |
| `GET  /api/backup/export`               | owner  | The export itself: documents, key metadata, team. Audited.               |
| `GET/POST /api/webhooks`                | owner  | List / register endpoints. Create returns the signing secret **once**.   |
| `PATCH/DELETE /api/webhooks/:id`        | owner  | Update or remove an endpoint.                                            |
| `POST /api/webhooks/:id/rotate-secret`  | owner  | Re-mint the secret; the previous one stops working immediately.          |
| `POST /api/webhooks/:id/test`           | owner  | Queue a synthetic event to verify a receiver.                            |
| `GET  /api/webhooks/deliveries`         | owner  | Delivery log (attempts, response status, last error).                    |
| `GET  /api/keys`                        | owner  | List API keys (hash + prefix, expiry, status; never the secret).         |
| `POST /api/keys`                        | owner  | Mint a key with optional `expiresAt` — the raw key is returned **once**. |
| `DELETE /api/keys/:hash`                | owner  | Revoke one of the org's keys.                                            |
| `GET  /api/users`                       | owner  | List team members.                                                       |
| `POST /api/users`                       | owner  | Create a team member (`owner`/`member`).                                 |
| `PATCH /api/users/:id`                  | owner  | Update a member (guards against removing the last owner).                |
| `DELETE /api/users/:id`                 | owner  | Delete a member (guards against deleting the last owner).                |
| `DELETE /api/users/:id/mfa`             | owner  | Clear a member's second factor (lockout recovery; audited).              |

## Appendix B — Admin API (`/admin/api`)

Same-origin JSON API for platform operators, backing the admin console. Login is open;
everything else requires an **admin session cookie** and the appropriate role
(`owner` > `manager` > `viewer`). Admin users and passwords (argon2id) live in Postgres; the
first owner is seeded from env at startup.

| Method + path                                             | Min role         | Purpose                                                      |
| --------------------------------------------------------- | ---------------- | ------------------------------------------------------------ |
| `POST /api/login` · `POST /api/login/mfa`                 | open             | Authenticate; redeem an MFA challenge. Login-throttled.      |
| `POST /api/logout` · `GET /api/me`                        | session          | Session lifecycle.                                           |
| `POST /api/security/password`                             | session          | Change own password. Revokes every other session.            |
| `GET/DELETE /api/security/sessions`                       | session          | The caller's live sign-ins; DELETE revokes all others.       |
| `GET/POST/DELETE /api/security/mfa`                       | session          | The caller's own second factor.                              |
| `POST /api/security/mfa/verify` · `.../recovery-codes`    | session          | Confirm enrolment; re-mint recovery codes.                   |
| `GET/POST /api/admins`, `PATCH/DELETE /api/admins/:id`    | owner            | Manage console users.                                        |
| `DELETE /api/admins/:id/mfa`                              | owner            | Clear an admin's second factor (lockout recovery; audited).  |
| `GET /api/tenants` · `GET /api/tenants/:id`               | viewer           | List tenants; one tenant with keys, users and subscription.  |
| `POST /api/tenants`, `PATCH/DELETE /api/tenants/:keyHash` | manager          | Create, edit and revoke tenants and their keys/limits.       |
| `GET /api/tenants/:tenantId/users`                        | viewer           | A tenant's portal users.                                     |
| `POST /api/tenants/:tenantId/users`                       | manager          | Seed a tenant's portal login.                                |
| `GET /api/plans`                                          | viewer           | The subscription plan catalog (DB-backed; includes hidden).  |
| `POST /api/plans`, `PUT/DELETE /api/plans/:id`            | manager          | Manage the plan catalog.                                     |
| `GET /api/subscriptions`                                  | viewer           | Every tenant's enrolment, with the derived status.           |
| `GET /api/subscriptions/summary`                          | viewer           | Estate-wide totals for the console's stat tiles.             |
| `GET /api/tenants/:tenantId/subscription`                 | viewer           | One tenant's subscription.                                   |
| `PUT /api/tenants/:tenantId/subscription`                 | manager          | Assign a plan (catalog plans only).                          |
| `GET /api/functions`                                      | viewer           | The function catalog (as `/v1/ocr/functions`).               |
| `GET /api/metrics/summary`                                | viewer           | Request counts, error rate, tokens, fallbacks, per function. |
| `GET /api/usage`                                          | viewer           | Per-tenant usage counters.                                   |
| `GET /api/documents`                                      | viewer           | Processed-document registry across all tenants.              |
| `GET /api/queue`                                          | viewer           | BullMQ queue depth + recent jobs.                            |
| `GET /api/health`                                         | viewer           | Health/provider matrix.                                      |
| `GET /api/audit`                                          | viewer           | Audit trail, filterable by action prefix and actor.          |
| `GET /api/logs`                                           | viewer           | Platform log tail (Redis ring buffer), filterable by level.  |
| `GET/PUT /api/settings/notifications`                     | viewer / manager | Notification channels and event toggles.                     |
| `GET/PUT /api/settings/api-integrations`                  | viewer / manager | Outbound integration registry.                               |
| `GET/PUT /api/settings/platform`                          | viewer / manager | Maintenance mode, default limits, feature flags.             |
| `GET/PUT /api/settings/retention`                         | viewer / manager | Retention windows for documents and audit events.            |
| `POST /api/retention/sweep`                               | manager          | Run the retention sweep immediately (audited).               |
| `GET/PUT /api/security`                                   | viewer / manager | Security policy, plus a read-only live posture snapshot.     |
| `GET/POST /api/backups`                                   | viewer / manager | List and create configuration snapshots.                     |
| `GET /api/backups/:id`                                    | viewer           | Download one snapshot.                                       |
| `POST /api/backups/:id/restore`                           | manager          | Idempotently restore plans, subscriptions and settings.      |

## Glossary

| Term                    | Definition                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Function**            | A named interpretation task (e.g. `RECEIPT_PARSING`) selected via the URL path.                                                    |
| **Capability**          | A skill a provider offers (`text`, `layout`, `tables`, `handwriting`, `seals`); a function declares which it `requires` and which it `prefers`. |
| **RecognizedDocument**  | The canonical extraction output (markdown, plain text, pages, layout blocks) every provider returns.                               |
| **Provider**            | An extraction engine (pdf-parse, Mammoth, Tesseract, GLM-OCR, plain-text) that produces a `RecognizedDocument`.                    |
| **Fallback chain**      | The ordered list of providers tried on error before an extraction is declared failed.                                              |
| **Tenant**              | The identity resolved from an API key; scopes authorization, rate limiting, subscription, and caching.                             |
| **Subscription / Plan** | A tenant's live enrolment in a catalog plan; drives entitlements, quotas, and rate ceilings.                                       |
| **Sensitivity**         | A per-function classification (`standard`/`pii`/`restricted`) that centrally drives logging, caching, queueing, and cache-control. |
| **MRZ**                 | Machine-Readable Zone — the checksum-bearing text band on passports/IDs, parsed and verified by `ID_VERIFICATION`.                 |
| **Sniff**               | Determining a file's true type from its magic bytes rather than the client-supplied name/MIME.                                     |
| **Structured output**   | Azure OpenAI generation constrained to a JSON Schema derived from the function's Zod result schema.                                |
