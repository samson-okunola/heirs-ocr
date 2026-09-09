import { describe, expect, it } from "vitest";

import { SHARED_PLACEHOLDERS, type Recipient, type TemplateArgs } from "../src/notification/mail/messages";
import {
  TEMPLATE_NAMES,
  escapeHtml,
  htmlToText,
  placeholdersOf,
  renderTemplate,
  type TemplateName,
  type TemplateValues,
} from "../src/notification/mail/templates";

/**
 * Fixtures generated from the placeholders actually present in src/templates.
 *
 * The type annotation is the point of this object. Because it is a literal assigned
 * to `{ [K in TemplateName]: TemplateArgs[K] }`, TypeScript rejects it if a template
 * declares an argument these fixtures lack, and excess-property checking rejects it
 * if the fixtures carry one the argument type does not declare. So `pnpm lint`
 * fails the moment a template's HTML and its hand-written argument type disagree —
 * which is the failure mode hand-maintained placeholder lists otherwise invite.
 */
const SAMPLES: { [K in TemplateName]: TemplateArgs[K] } = {
  "account-locked": {
    Email: "recipient@example.test",
    FailedAttempts: "7",
    LockedAt: "12 August 2026, 14:03 WAT",
    LockoutMinutes: "7",
    RequestIp: "RequestIp value",
    RequestLocation: "12 August 2026, 14:03 WAT",
    ResetUrl: "https://example.test/reseturl",
    UnlocksAt: "12 August 2026, 14:03 WAT",
  },
  "api-key-created": {
    AllowedFunctions: "AllowedFunctions value",
    CreatedAt: "12 August 2026, 14:03 WAT",
    CreatedBy: "12 August 2026, 14:03 WAT",
    ExpiresAt: "12 August 2026, 14:03 WAT",
    KeyName: "KeyName value",
    KeyPrefix: "KeyPrefix value",
    KeysUrl: "https://example.test/keysurl",
    RateLimitPerMinute: "7",
  },
  "api-key-expiring": {
    CreatedAt: "12 August 2026, 14:03 WAT",
    DaysUntilExpiry: "7",
    ExpiresAt: "12 August 2026, 14:03 WAT",
    KeyName: "KeyName value",
    KeyPrefix: "KeyPrefix value",
    KeysUrl: "https://example.test/keysurl",
    LastUsedAt: "12 August 2026, 14:03 WAT",
    RecentRequests: "7",
  },
  "data-deletion-notice": {
    BillingUrl: "https://example.test/billingurl",
    DataRetentionDays: "7",
    DeletionDate: "12 August 2026, 14:03 WAT",
    DocumentCount: "7",
    ExportUrl: "https://example.test/exporturl",
    NewestAffectedDate: "12 August 2026, 14:03 WAT",
    OldestDocumentDate: "12 August 2026, 14:03 WAT",
    PlanName: "PlanName value",
  },
  "export-ready": {
    DocumentCount: "7",
    DownloadUrl: "https://example.test/downloadurl",
    ExpiresAt: "12 August 2026, 14:03 WAT",
    ExportContents: "ExportContents value",
    FileSize: "FileSize value",
    RequestedAt: "12 August 2026, 14:03 WAT",
    RequestedBy: "RequestedBy value",
  },
  "job-complete": {
    CompletedAt: "12 August 2026, 14:03 WAT",
    DataDeletionDate: "12 August 2026, 14:03 WAT",
    DataRetentionDays: "7",
    DocumentName: "DocumentName value",
    Duration: "12 August 2026, 14:03 WAT",
    FunctionName: "FunctionName value",
    JobId: "JobId value",
    JobUrl: "https://example.test/joburl",
    PageCount: "7",
    SubmittedAt: "12 August 2026, 14:03 WAT",
    WebhooksUrl: "https://example.test/webhooksurl",
  },
  "job-failure": {
    Attempts: "7",
    DocumentName: "DocumentName value",
    ErrorCode: "ErrorCode value",
    ErrorMessage: "ErrorMessage value",
    FailedAt: "12 August 2026, 14:03 WAT",
    FunctionName: "FunctionName value",
    JobId: "JobId value",
    JobUrl: "https://example.test/joburl",
    SubmittedAt: "12 August 2026, 14:03 WAT",
    SupportUrl: "https://example.test/supporturl",
  },
  "login-alert": {
    Email: "recipient@example.test",
    MfaUsed: "MfaUsed value",
    RequestIp: "RequestIp value",
    RequestLocation: "12 August 2026, 14:03 WAT",
    SecurityUrl: "https://example.test/securityurl",
    SignedInAt: "12 August 2026, 14:03 WAT",
    UserAgent: "UserAgent value",
  },
  "mfa-changed": {
    ChangedAt: "12 August 2026, 14:03 WAT",
    Email: "recipient@example.test",
    MfaChange: "MfaChange value",
    MfaMethod: "MfaMethod value",
    RequestIp: "RequestIp value",
    SecurityUrl: "https://example.test/securityurl",
    UserAgent: "UserAgent value",
  },
  "password-changed": {
    ChangedAt: "12 August 2026, 14:03 WAT",
    Email: "recipient@example.test",
    RequestIp: "RequestIp value",
    RequestLocation: "12 August 2026, 14:03 WAT",
    SecurityUrl: "https://example.test/securityurl",
    UserAgent: "UserAgent value",
  },
  "password-reset": {
    Email: "recipient@example.test",
    ExpiresAt: "12 August 2026, 14:03 WAT",
    ExpiryMinutes: "7",
    RequestIp: "RequestIp value",
    RequestLocation: "12 August 2026, 14:03 WAT",
    RequestedAt: "12 August 2026, 14:03 WAT",
    ResetUrl: "https://example.test/reseturl",
    UserAgent: "UserAgent value",
  },
  "quota-warning": {
    BillingUrl: "https://example.test/billingurl",
    DaysRemaining: "7",
    DocumentsIncluded: "7",
    DocumentsProcessed: "7",
    DocumentsRemaining: "7",
    OverageRate: "12 August 2026, 14:03 WAT",
    PagesProcessed: "7",
    PeriodEnd: "12 August 2026, 14:03 WAT",
    PeriodStart: "12 August 2026, 14:03 WAT",
    PlanName: "PlanName value",
    ReportsUrl: "https://example.test/reportsurl",
    UsagePercent: "80",
  },
  "subscription-end": {
    DataDeletionDate: "12 August 2026, 14:03 WAT",
    DataRetentionDays: "7",
    EndReason: "12 August 2026, 14:03 WAT",
    EndedAt: "12 August 2026, 14:03 WAT",
    ExportUrl: "https://example.test/exporturl",
    FinalAmount: "$49.00",
    LifetimeDocuments: "7",
    PeriodEnd: "12 August 2026, 14:03 WAT",
    PeriodStart: "12 August 2026, 14:03 WAT",
    PlanName: "PlanName value",
    ReactivateUrl: "https://example.test/reactivateurl",
  },
  "subscription-failed": {
    Amount: "$49.00",
    AttemptNumber: "7",
    AttemptedAt: "12 August 2026, 14:03 WAT",
    FailureReason: "FailureReason value",
    GracePeriodEndsAt: "12 August 2026, 14:03 WAT",
    MaxAttempts: "7",
    NextRetryAt: "12 August 2026, 14:03 WAT",
    PaymentMethod: "PaymentMethod value",
    SupportUrl: "https://example.test/supporturl",
    UpdatePaymentUrl: "https://example.test/updatepaymenturl",
  },
  "subscription-reminder": {
    Amount: "$49.00",
    BillingUrl: "https://example.test/billingurl",
    DaysUntilRenewal: "7",
    DocumentsIncluded: "7",
    DocumentsProcessed: "7",
    NextPeriodEnd: "12 August 2026, 14:03 WAT",
    NextPeriodStart: "12 August 2026, 14:03 WAT",
    OverageAmount: "$49.00",
    PagesProcessed: "7",
    PaymentMethod: "PaymentMethod value",
    PeriodEnd: "12 August 2026, 14:03 WAT",
    PeriodStart: "12 August 2026, 14:03 WAT",
    PlanName: "PlanName value",
    RenewalDate: "12 August 2026, 14:03 WAT",
  },
  "subscription-successful": {
    Amount: "$49.00",
    BillingUrl: "https://example.test/billingurl",
    DataRetentionDays: "7",
    DocumentsIncluded: "7",
    InvoiceNumber: "7",
    InvoiceUrl: "https://example.test/invoiceurl",
    MaxPagesPerDocument: "7",
    NextBillingDate: "12 August 2026, 14:03 WAT",
    OverageRate: "12 August 2026, 14:03 WAT",
    PaidAt: "12 August 2026, 14:03 WAT",
    PaymentMethod: "PaymentMethod value",
    PeriodEnd: "12 August 2026, 14:03 WAT",
    PeriodStart: "12 August 2026, 14:03 WAT",
    PlanFeatures: "12 August 2026, 14:03 WAT",
    PlanName: "PlanName value",
    RateLimitPerMinute: "7",
  },
  "team-invite": {
    Email: "recipient@example.test",
    InviterName: "InviterName value",
    PasswordExpiryMinutes: "7",
    Role: "Role value",
    SignInUrl: "https://example.test/signinurl",
    TemporaryPassword: "TemporaryPassword value",
  },
  "trial-end": {
    ContactUrl: "https://example.test/contacturl",
    DataDeletionDate: "12 August 2026, 14:03 WAT",
    DataRetentionDays: "7",
    DocumentsProcessed: "7",
    FunctionsUsed: "FunctionsUsed value",
    IncludedDocuments: "7",
    PagesProcessed: "7",
    TrialEndedAt: "12 August 2026, 14:03 WAT",
    TrialStartedAt: "12 August 2026, 14:03 WAT",
    UpgradeUrl: "https://example.test/upgradeurl",
  },
  "trial-start": {
    DataRetentionDays: "7",
    IncludedDocuments: "7",
    MaxFileSize: "MaxFileSize value",
    MaxPagesPerDocument: "7",
    TrialDays: "7",
    TrialEndsAt: "12 August 2026, 14:03 WAT",
  },
  "verify-email": {
    Email: "recipient@example.test",
    ExpiresAt: "12 August 2026, 14:03 WAT",
    ExpiryMinutes: "15",
    Otp: "042318",
    PlanName: "PlanName value",
    RequestIp: "203.0.113.7",
    VerifyUrl: "https://example.test/verifyurl",
  },
  "webhook-failing": {
    ConsecutiveFailures: "7",
    EndpointUrl: "https://example.test/endpointurl",
    FirstFailureAt: "12 August 2026, 14:03 WAT",
    LastAttemptAt: "12 August 2026, 14:03 WAT",
    LastResponseBody: "LastResponseBody value",
    LastResponseStatus: "7",
    MaxAttempts: "7",
    SubscribedEvents: "SubscribedEvents value",
    WebhooksUrl: "https://example.test/webhooksurl",
  },
  welcome: {
    ApiBaseUrl: "https://example.test/apibaseurl",
    DataRetentionDays: "7",
    DocumentsIncluded: "7",
    PlanName: "PlanName value",
    RateLimitPerMinute: "7",
  },
};

const RECIPIENT: Recipient = {
  to: "recipient@example.test",
  firstName: "Ada",
  tenantName: "Acme Documents",
};

/** Mirrors what `dispatch` injects, without going near the transport. */
const withShared = (args: object): TemplateValues => ({
  FirstName: RECIPIENT.firstName,
  TenantName: RECIPIENT.tenantName,
  DashboardUrl: "https://app.example.test/",
  DocsUrl: "https://docs.example.test",
  PreferencesUrl: "https://app.example.test/settings/notifications",
  SupportEmail: "support@example.test",
  Year: 2026,
  ...(args as TemplateValues),
});

describe("email templates", () => {
  it("covers every template on disk", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...TEMPLATE_NAMES].sort());
  });

  it.each(TEMPLATE_NAMES)("%s declares exactly the args its HTML uses", (name) => {
    const declared = Object.keys(SAMPLES[name]).sort();
    const used = placeholdersOf(name)
      .filter((p) => !SHARED_PLACEHOLDERS.includes(p as (typeof SHARED_PLACEHOLDERS)[number]))
      .sort();

    expect(declared).toEqual(used);
  });

  it.each(TEMPLATE_NAMES)("%s renders with no placeholder left behind", (name) => {
    const { subject, html, text } = renderTemplate(name, withShared(SAMPLES[name]));

    expect(html).not.toMatch(/\{\{/);
    expect(subject).not.toMatch(/\{\{/);
    expect(subject.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
  });

  it("takes the subject from the template's own <title>", () => {
    expect(renderTemplate("welcome", withShared(SAMPLES.welcome)).subject).toBe("Welcome to Heirs OCR");
  });

  it("interpolates values into a dynamic subject and decodes its entities", () => {
    const subject = renderTemplate(
      "quota-warning",
      withShared({ ...SAMPLES["quota-warning"], UsagePercent: 92 }),
    ).subject;

    // The template spells the apostrophe &rsquo;, which must not reach the header raw.
    expect(subject).toBe("You’ve used 92% of this period’s documents");
  });

  it("throws rather than emailing a literal placeholder", () => {
    const { ErrorMessage: _dropped, ...incomplete } = SAMPLES["job-failure"];

    expect(() => renderTemplate("job-failure", withShared(incomplete))).toThrow(/ErrorMessage/);
  });
});

describe("escaping", () => {
  it("escapes markup in attacker-influenced values", () => {
    const { html } = renderTemplate(
      "job-failure",
      withShared({
        ...SAMPLES["job-failure"],
        ErrorMessage: "</td></table><script>alert(1)</script>",
      }),
    );

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes ampersands inside href values", () => {
    expect(escapeHtml("https://x.test/?a=1&b=2")).toBe("https://x.test/?a=1&amp;b=2");
  });

  it("strips markup for the plain-text alternative", () => {
    expect(htmlToText("<p>Hello <strong>Ada</strong></p><p>Bye</p>")).toBe("Hello Ada\nBye");
  });
});
