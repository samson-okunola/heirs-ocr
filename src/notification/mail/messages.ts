import { renderTemplate, type TemplateName, type TemplateValue, type TemplateValues } from "./templates";
import { send, type SendMailResult } from "./mailer";
import { env } from "../../config/env";

/**
 * One typed function per email template.
 *
 * Each takes the recipient plus only the arguments its own template actually
 * references. The seven placeholders every template shares — `FirstName`,
 * `TenantName`, `DashboardUrl`, `DocsUrl`, `PreferencesUrl`, `SupportEmail` and
 * `Year` — are filled from the recipient and config, so callers never repeat them.
 *
 * The argument names mirror the `{{Placeholders}}` in the HTML exactly. That is what
 * makes `test/mail-templates.test.ts` able to prove the two never drift: it renders
 * every template against its declared argument list and fails on any placeholder
 * that is declared-but-absent or present-but-undeclared.
 *
 * Values are interpolated verbatim, so dates and money should arrive already
 * formatted for the reader — this layer does not guess at a locale or currency.
 */

/** Who a message is addressed to, and the two per-recipient placeholders. */
export interface Recipient {
  to: string;
  /** `{{FirstName}}` — used in the greeting. */
  firstName: string;
  /** `{{TenantName}}` — the workspace the message concerns. */
  tenantName: string;
  cc?: string[];
  bcc?: string[];
  /**
   * Overrides `{{PreferencesUrl}}`. Pass a per-recipient link when unsubscribe
   * handling becomes token-based; otherwise the shared settings page is used.
   */
  preferencesUrl?: string;
}

/** Builds an absolute console URL from `APP_BASE_URL`. Exported for call sites. */
export const appUrl = (pathname = "/"): string =>
  `${env.APP_BASE_URL.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;

function baseValues(recipient: Recipient): TemplateValues {
  return {
    FirstName: recipient.firstName,
    TenantName: recipient.tenantName,
    DashboardUrl: appUrl("/"),
    DocsUrl: env.DOCS_URL,
    PreferencesUrl: recipient.preferencesUrl ?? appUrl("/settings/notifications"),
    SupportEmail: env.SUPPORT_EMAIL,
    Year: new Date().getFullYear(),
  };
}

/**
 * Renders `name` and hands it to the transport. Caller-supplied values win over the
 * defaults, so any shared placeholder can still be overridden per send.
 */
async function dispatch<N extends TemplateName>(
  name: N,
  recipient: Recipient,
  args: TemplateArgs[N],
): Promise<SendMailResult> {
  const { subject, html, text } = renderTemplate(name, {
    ...baseValues(recipient),
    ...(args as TemplateValues),
  });

  return send({
    to: recipient.to,
    cc: recipient.cc,
    bcc: recipient.bcc,
    subject,
    html,
    text,
  });
}

/** Numeric-ish placeholders accept either form; both render identically. */
type Num = TemplateValue;

// --- security -------------------------------------------------------------

export type AccountLockedArgs = {
  Email: string;
  FailedAttempts: Num;
  LockedAt: string;
  LockoutMinutes: Num;
  RequestIp: string;
  RequestLocation: string;
  ResetUrl: string;
  UnlocksAt: string;
};

export type LoginAlertArgs = {
  Email: string;
  MfaUsed: string;
  RequestIp: string;
  RequestLocation: string;
  SecurityUrl: string;
  SignedInAt: string;
  UserAgent: string;
};

export type MfaChangedArgs = {
  ChangedAt: string;
  Email: string;
  /** Interpolated into the subject line — read as "was {{MfaChange}}", e.g. "enabled". */
  MfaChange: string;
  MfaMethod: string;
  RequestIp: string;
  SecurityUrl: string;
  UserAgent: string;
};

export type PasswordChangedArgs = {
  ChangedAt: string;
  Email: string;
  RequestIp: string;
  RequestLocation: string;
  SecurityUrl: string;
  UserAgent: string;
};

export type PasswordResetArgs = {
  Email: string;
  ExpiresAt: string;
  ExpiryMinutes: Num;
  RequestedAt: string;
  RequestIp: string;
  RequestLocation: string;
  ResetUrl: string;
  UserAgent: string;
};

/** Account temporarily locked after repeated failed sign-ins. */
export const sendAccountLockedEmail = (r: Recipient, a: AccountLockedArgs) => dispatch("account-locked", r, a);

/** New sign-in from an unrecognised device or location. */
export const sendLoginAlertEmail = (r: Recipient, a: LoginAlertArgs) => dispatch("login-alert", r, a);

/** Two-factor authentication enabled, disabled or reconfigured. */
export const sendMfaChangedEmail = (r: Recipient, a: MfaChangedArgs) => dispatch("mfa-changed", r, a);

/** Confirmation that the account password changed. */
export const sendPasswordChangedEmail = (r: Recipient, a: PasswordChangedArgs) => dispatch("password-changed", r, a);

/** Password reset link. `ResetUrl` is a bearer link — keep its lifetime short. */
export const sendPasswordResetEmail = (r: Recipient, a: PasswordResetArgs) => dispatch("password-reset", r, a);

// --- API keys -------------------------------------------------------------

export type ApiKeyCreatedArgs = {
  AllowedFunctions: string;
  CreatedAt: string;
  CreatedBy: string;
  ExpiresAt: string;
  KeyName: string;
  /** The visible prefix only. Never pass the full secret — this lands in an inbox. */
  KeyPrefix: string;
  KeysUrl: string;
  RateLimitPerMinute: Num;
};

export type ApiKeyExpiringArgs = {
  CreatedAt: string;
  /** Interpolated into the subject line. */
  DaysUntilExpiry: Num;
  ExpiresAt: string;
  KeyName: string;
  KeyPrefix: string;
  KeysUrl: string;
  LastUsedAt: string;
  RecentRequests: Num;
};

/** A new API key was issued on the workspace. */
export const sendApiKeyCreatedEmail = (r: Recipient, a: ApiKeyCreatedArgs) => dispatch("api-key-created", r, a);

/** An API key is approaching its expiry date. */
export const sendApiKeyExpiringEmail = (r: Recipient, a: ApiKeyExpiringArgs) => dispatch("api-key-expiring", r, a);

// --- jobs, exports and data -----------------------------------------------

export type JobCompleteArgs = {
  CompletedAt: string;
  DataDeletionDate: string;
  DataRetentionDays: Num;
  DocumentName: string;
  Duration: string;
  FunctionName: string;
  JobId: string;
  JobUrl: string;
  PageCount: Num;
  SubmittedAt: string;
  WebhooksUrl: string;
};

export type JobFailureArgs = {
  Attempts: Num;
  DocumentName: string;
  ErrorCode: string;
  ErrorMessage: string;
  FailedAt: string;
  FunctionName: string;
  JobId: string;
  JobUrl: string;
  SubmittedAt: string;
  SupportUrl: string;
};

export type ExportReadyArgs = {
  DocumentCount: Num;
  DownloadUrl: string;
  ExpiresAt: string;
  ExportContents: string;
  FileSize: string;
  RequestedAt: string;
  RequestedBy: string;
};

export type DataDeletionNoticeArgs = {
  BillingUrl: string;
  DataRetentionDays: Num;
  DeletionDate: string;
  DocumentCount: Num;
  ExportUrl: string;
  NewestAffectedDate: string;
  OldestDocumentDate: string;
  PlanName: string;
};

/** An OCR job finished successfully. */
export const sendJobCompleteEmail = (r: Recipient, a: JobCompleteArgs) => dispatch("job-complete", r, a);

/** An OCR job exhausted its retries. `ErrorMessage` is escaped before rendering. */
export const sendJobFailureEmail = (r: Recipient, a: JobFailureArgs) => dispatch("job-failure", r, a);

/** A requested workspace export is available to download. */
export const sendExportReadyEmail = (r: Recipient, a: ExportReadyArgs) => dispatch("export-ready", r, a);

/** Documents are approaching the retention cut-off and will be deleted. */
export const sendDataDeletionNoticeEmail = (r: Recipient, a: DataDeletionNoticeArgs) =>
  dispatch("data-deletion-notice", r, a);

// --- webhooks -------------------------------------------------------------

export type WebhookFailingArgs = {
  ConsecutiveFailures: Num;
  EndpointUrl: string;
  FirstFailureAt: string;
  LastAttemptAt: string;
  /** Remote response body — attacker-influenced, and escaped before rendering. */
  LastResponseBody: string;
  LastResponseStatus: Num;
  MaxAttempts: Num;
  SubscribedEvents: string;
  WebhooksUrl: string;
};

/** Deliveries to a webhook endpoint are failing repeatedly. */
export const sendWebhookFailingEmail = (r: Recipient, a: WebhookFailingArgs) => dispatch("webhook-failing", r, a);

// --- onboarding and team --------------------------------------------------

export type WelcomeArgs = {
  ApiBaseUrl: string;
  DataRetentionDays: Num;
  DocumentsIncluded: Num;
  PlanName: string;
  RateLimitPerMinute: Num;
};

export type VerifyEmailArgs = {
  Email: string;
  /** Human-readable instant the code stops working, already formatted for the reader. */
  ExpiresAt: string;
  ExpiryMinutes: Num;
  /** Single-use credential. Never log this value — see the note in `mailer.send`. */
  Otp: string;
  PlanName: string;
  /** Where the signup was submitted from, so an unexpected mail can be judged. */
  RequestIp: string;
  VerifyUrl: string;
};

export type TeamInviteArgs = {
  Email: string;
  InviterName: string;
  PasswordExpiryMinutes: Num;
  Role: string;
  SignInUrl: string;
  /** Single-use credential. Never log this value — see the note in `mailer.send`. */
  TemporaryPassword: string;
};

/** First message after a workspace is provisioned. */
export const sendWelcomeEmail = (r: Recipient, a: WelcomeArgs) => dispatch("welcome", r, a);

/** A user was added to a workspace and needs their first-sign-in credential. */
export const sendTeamInviteEmail = (r: Recipient, a: TeamInviteArgs) => dispatch("team-invite", r, a);

/** The code that turns a pending self-serve signup into a real workspace. */
export const sendVerifyEmail = (r: Recipient, a: VerifyEmailArgs) => dispatch("verify-email", r, a);

// --- trial ----------------------------------------------------------------

export type TrialStartArgs = {
  DataRetentionDays: Num;
  IncludedDocuments: Num;
  MaxFileSize: string;
  MaxPagesPerDocument: Num;
  TrialDays: Num;
  TrialEndsAt: string;
};

export type TrialEndArgs = {
  ContactUrl: string;
  DataDeletionDate: string;
  DataRetentionDays: Num;
  DocumentsProcessed: Num;
  FunctionsUsed: string;
  IncludedDocuments: Num;
  PagesProcessed: Num;
  TrialEndedAt: string;
  TrialStartedAt: string;
  UpgradeUrl: string;
};

/** The trial has begun. */
export const sendTrialStartEmail = (r: Recipient, a: TrialStartArgs) => dispatch("trial-start", r, a);

/** The trial has expired. */
export const sendTrialEndEmail = (r: Recipient, a: TrialEndArgs) => dispatch("trial-end", r, a);

// --- billing --------------------------------------------------------------

export type QuotaWarningArgs = {
  BillingUrl: string;
  DaysRemaining: Num;
  DocumentsIncluded: Num;
  DocumentsProcessed: Num;
  DocumentsRemaining: Num;
  OverageRate: string;
  PagesProcessed: Num;
  PeriodEnd: string;
  PeriodStart: string;
  PlanName: string;
  ReportsUrl: string;
  /** Interpolated into the subject line, as a bare number — the template adds "%". */
  UsagePercent: Num;
};

export type SubscriptionSuccessfulArgs = {
  Amount: string;
  BillingUrl: string;
  DataRetentionDays: Num;
  DocumentsIncluded: Num;
  InvoiceNumber: string;
  InvoiceUrl: string;
  MaxPagesPerDocument: Num;
  NextBillingDate: string;
  OverageRate: string;
  PaidAt: string;
  PaymentMethod: string;
  PeriodEnd: string;
  PeriodStart: string;
  PlanFeatures: string;
  PlanName: string;
  RateLimitPerMinute: Num;
};

export type SubscriptionReminderArgs = {
  Amount: string;
  BillingUrl: string;
  DaysUntilRenewal: Num;
  DocumentsIncluded: Num;
  DocumentsProcessed: Num;
  NextPeriodEnd: string;
  NextPeriodStart: string;
  OverageAmount: string;
  PagesProcessed: Num;
  PaymentMethod: string;
  PeriodEnd: string;
  PeriodStart: string;
  PlanName: string;
  RenewalDate: string;
};

export type SubscriptionFailedArgs = {
  Amount: string;
  AttemptedAt: string;
  AttemptNumber: Num;
  FailureReason: string;
  GracePeriodEndsAt: string;
  MaxAttempts: Num;
  NextRetryAt: string;
  PaymentMethod: string;
  SupportUrl: string;
  UpdatePaymentUrl: string;
};

export type SubscriptionEndArgs = {
  DataDeletionDate: string;
  DataRetentionDays: Num;
  EndedAt: string;
  EndReason: string;
  ExportUrl: string;
  FinalAmount: string;
  LifetimeDocuments: Num;
  PeriodEnd: string;
  PeriodStart: string;
  PlanName: string;
  ReactivateUrl: string;
};

/** Approaching the plan's document allowance for the period. */
export const sendQuotaWarningEmail = (r: Recipient, a: QuotaWarningArgs) => dispatch("quota-warning", r, a);

/** Payment received and the subscription is active. */
export const sendSubscriptionSuccessfulEmail = (r: Recipient, a: SubscriptionSuccessfulArgs) =>
  dispatch("subscription-successful", r, a);

/** Upcoming renewal notice. */
export const sendSubscriptionReminderEmail = (r: Recipient, a: SubscriptionReminderArgs) =>
  dispatch("subscription-reminder", r, a);

/** A payment attempt failed; the account is in its grace period. */
export const sendSubscriptionFailedEmail = (r: Recipient, a: SubscriptionFailedArgs) =>
  dispatch("subscription-failed", r, a);

/** The subscription has ended. */
export const sendSubscriptionEndEmail = (r: Recipient, a: SubscriptionEndArgs) => dispatch("subscription-end", r, a);

// --- registry -------------------------------------------------------------

/**
 * Maps every template to its argument type. `dispatch` is keyed off this, and the
 * drift test walks it to check each declared argument set against the placeholders
 * actually present in the HTML.
 */
export type TemplateArgs = {
  "account-locked": AccountLockedArgs;
  "api-key-created": ApiKeyCreatedArgs;
  "api-key-expiring": ApiKeyExpiringArgs;
  "data-deletion-notice": DataDeletionNoticeArgs;
  "export-ready": ExportReadyArgs;
  "job-complete": JobCompleteArgs;
  "job-failure": JobFailureArgs;
  "login-alert": LoginAlertArgs;
  "mfa-changed": MfaChangedArgs;
  "password-changed": PasswordChangedArgs;
  "password-reset": PasswordResetArgs;
  "quota-warning": QuotaWarningArgs;
  "subscription-end": SubscriptionEndArgs;
  "subscription-failed": SubscriptionFailedArgs;
  "subscription-reminder": SubscriptionReminderArgs;
  "subscription-successful": SubscriptionSuccessfulArgs;
  "team-invite": TeamInviteArgs;
  "trial-end": TrialEndArgs;
  "trial-start": TrialStartArgs;
  "verify-email": VerifyEmailArgs;
  "webhook-failing": WebhookFailingArgs;
  welcome: WelcomeArgs;
};

/** The placeholders `dispatch` fills in for every template. */
export const SHARED_PLACEHOLDERS = [
  "DashboardUrl",
  "DocsUrl",
  "FirstName",
  "PreferencesUrl",
  "SupportEmail",
  "TenantName",
  "Year",
] as const;
