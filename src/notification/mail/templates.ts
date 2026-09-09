import path from "path";
import fs from "fs";

/**
 * Renderer for the HTML email templates in `src/templates`.
 *
 * The templates are plain interpolation only — `{{PascalCase}}` and nothing else,
 * no conditionals or loops — so this deliberately stays a string substitution
 * rather than pulling in a template engine. Two rules make that safe:
 *
 *   1. Every interpolated value is HTML-escaped. Several placeholders carry
 *      attacker-influenced text (`ErrorMessage`, `LastResponseBody`, `UserAgent`,
 *      `DocumentName`), and they land inside attributes and text nodes.
 *   2. A missing or unknown placeholder throws. Emailing a customer a literal
 *      `{{Amount}}` is worse than failing the send and retrying.
 */

/** The templates on disk. Each name maps to `src/templates/<name>.html`. */
export const TEMPLATE_NAMES = [
  "account-locked",
  "api-key-created",
  "api-key-expiring",
  "data-deletion-notice",
  "export-ready",
  "job-complete",
  "job-failure",
  "login-alert",
  "mfa-changed",
  "password-changed",
  "password-reset",
  "quota-warning",
  "subscription-end",
  "subscription-failed",
  "subscription-reminder",
  "subscription-successful",
  "team-invite",
  "trial-end",
  "trial-start",
  "verify-email",
  "webhook-failing",
  "welcome",
] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/** Anything that can be dropped into a template. Coerced with `String()`. */
export type TemplateValue = string | number;

export type TemplateValues = Record<string, TemplateValue>;

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

/**
 * Resolved once at module load. In development `__dirname` is `src/notification/mail`
 * and in the compiled image it is `build/notification/mail`, so the same relative hop
 * works in both — provided `scripts/copy-templates.cjs` has staged the HTML into
 * `build/`. The source fallback keeps a partially-built tree usable rather than
 * failing with a bare ENOENT.
 */
const TEMPLATE_DIR = ((): string => {
  const candidates = [path.join(__dirname, "../../templates"), path.join(__dirname, "../../../src/templates")];
  const found = candidates.find((dir) => fs.existsSync(dir));
  if (!found) {
    throw new Error(
      `Email templates not found. Looked in:\n  ${candidates.join("\n  ")}\n` +
        `The build step copies src/templates into build/ — check scripts/copy-templates.cjs ran.`,
    );
  }
  return found;
})();

/** Read-through cache. Templates are immutable at runtime, so one read each is enough. */
const cache = new Map<TemplateName, string>();

function loadTemplate(name: TemplateName): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const file = path.join(TEMPLATE_DIR, `${name}.html`);
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`Email template "${name}" is missing at ${file}`);
  }
  cache.set(name, source);
  return source;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapes for both text nodes and quoted attribute values — every placeholder in
 * these templates sits in one or the other. Escaping `&` is correct inside an
 * `href` too: `&amp;` is how a query separator is spelled in HTML.
 */
export function escapeHtml(value: TemplateValue): string {
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/** The handful of named entities the template `<title>`s actually use. */
const ENTITIES: Record<string, string> = {
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&rdquo;": "”",
  "&ldquo;": "“",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&nbsp;": " ",
  "&middot;": "·",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:[a-zA-Z]+|#\d+);/g, (entity) => ENTITIES[entity] ?? entity);
}

/** Every `{{Placeholder}}` a template references, deduplicated. */
export function placeholdersOf(name: TemplateName): string[] {
  const found = new Set<string>();
  for (const match of loadTemplate(name).matchAll(PLACEHOLDER)) {
    const key = match[1];
    if (key !== undefined) found.add(key);
  }
  return [...found].sort();
}

function interpolate(source: string, values: TemplateValues, escape: boolean, missing: Set<string>): string {
  return source.replace(PLACEHOLDER, (whole, rawKey: string) => {
    const value = values[rawKey];
    if (value === undefined || value === null) {
      missing.add(rawKey);
      return whole;
    }
    return escape ? escapeHtml(value) : String(value);
  });
}

export interface RenderedEmail {
  /** Taken from the template's own `<title>`, so subject and body cannot drift. */
  subject: string;
  html: string;
  text: string;
}

/**
 * Renders a template to the subject/HTML/text triple `send()` needs.
 *
 * The subject comes from `<title>` rather than a separate table: three templates
 * interpolate a value into it (`{{MfaChange}}`, `{{UsagePercent}}`,
 * `{{DaysUntilExpiry}}`), and keeping one source of truth means a copy edit to the
 * template updates the subject line with it. It is interpolated *unescaped* because
 * a subject header is plain text, not markup.
 *
 * @throws if the template references a placeholder no value was supplied for.
 */
export function renderTemplate(name: TemplateName, values: TemplateValues): RenderedEmail {
  const source = loadTemplate(name);
  const missing = new Set<string>();

  const html = interpolate(source, values, true, missing);

  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(source);
  const rawTitle = titleMatch?.[1] ?? "";
  const subject = decodeEntities(interpolate(rawTitle, values, false, missing))
    .replace(/\s+/g, " ")
    .trim();

  if (missing.size > 0) {
    throw new Error(
      `Cannot render email template "${name}": no value supplied for ` + `${[...missing].sort().join(", ")}`,
    );
  }

  return { subject, html, text: htmlToText(html) };
}

/**
 * A plain-text alternative. Not a faithful rendering of these fairly elaborate
 * layouts — its job is to keep the message from looking like a phish to filters
 * that score multipart/alternative, and to stay readable in a text-only client.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
