/**
 * The schema half of `SchemaForm` (../components/shared/schema-form.tsx): which
 * control a JSON-Schema property maps to, how its comma-separated line is parsed,
 * and how form state becomes an args payload.
 *
 * Kept apart from the component because it is the part with rules worth testing —
 * a page range that must be two whole numbers, a field list whose types come from
 * the schema — and none of it needs React to be exercised.
 */

/** Minimal view of the JSON Schema (draft 2020-12) the OCR catalog emits per function. */
export interface SchemaProp {
  type?: string | string[];
  description?: string;
  default?: unknown;
  examples?: unknown[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: SchemaProp;
  prefixItems?: SchemaProp[];
  properties?: Record<string, SchemaProp>;
  required?: string[];
  additionalProperties?: SchemaProp | boolean;
}

export interface ObjectSchema {
  type?: string;
  properties?: Record<string, SchemaProp>;
  required?: string[];
  anyOf?: ObjectSchema[];
}

/**
 * Form state.
 *
 * Every text-driven control keeps its **raw string** here rather than a parsed
 * value: parsing on each keystroke would rewrite `1,` back to `1` mid-edit, and a
 * half-typed list is a normal state to be in, not an error to correct. Switches and
 * dropdowns are stored as-is, nested objects as their own `ArgValues`. Conversion to
 * the JSON the API wants happens once, in {@link buildArgs}.
 */
export type ArgValues = Record<string, unknown>;

/** Field-level messages from {@link buildArgs}, keyed by dotted path (`expected.fullName`). */
export type ArgErrors = Record<string, string>;

/**
 * The controls this form can draw.
 *
 * Anything that isn't a single primitive is entered as one comma-separated line — a
 * list of labels, a page range, a rename map, the fields to pull off a form. Between
 * them these cover every argument in the catalog except a raw JSON Schema, which
 * means running a document no longer requires anyone to hand-write JSON.
 */
export type Control =
  | { kind: "enum"; options: string[] }
  | { kind: "switch" }
  | { kind: "number"; integer: boolean }
  | { kind: "text" }
  /** `string[]` — "invoice, receipt, contract" */
  | { kind: "list" }
  /** Numbers, fixed-length when the schema is a tuple — "1, 5" for a page range */
  | { kind: "numbers"; count: number | null; integer: boolean }
  /** `Record<string, string>` — "total: amount_due, merchant.name: vendor" */
  | { kind: "pairs" }
  /** A list of field specs — "Invoice number: string, Total: number*" */
  | { kind: "specs"; types: string[] }
  /** A nested object of primitives, drawn as an indented sub-group */
  | { kind: "group"; properties: Record<string, SchemaProp>; required: string[] };

const propType = (prop: SchemaProp): string | undefined =>
  Array.isArray(prop.type) ? prop.type.find((t) => t !== "null") : prop.type;

const isNumeric = (prop: SchemaProp): boolean => {
  const t = propType(prop);
  return t === "number" || t === "integer";
};

/**
 * The declared types of an array-of-`{ name, type, … }` schema — the shape
 * FORM_DATA_EXTRACTION uses for its field list. Matched on structure rather than on
 * the function key, so anything else describing fields the same way gets the same
 * control for free.
 */
const specTypes = (item: SchemaProp): string[] | null => {
  if (propType(item) !== "object" || !item.properties) return null;
  const name = item.properties.name;
  const type = item.properties.type;
  if (!name || propType(name) !== "string") return null;
  if (!type || !Array.isArray(type.enum) || type.enum.length === 0) return null;
  return type.enum.map(String);
};

export const controlFor = (prop: SchemaProp): Control | null => {
  if (prop.enum) return { kind: "enum", options: prop.enum.map(String) };

  const t = propType(prop);
  if (t === "boolean") return { kind: "switch" };
  if (t === "number" || t === "integer") return { kind: "number", integer: t === "integer" };
  if (t === "string") return { kind: "text" };

  if (t === "array") {
    // A tuple (`pageRange`): as many slots as `prefixItems` entries.
    if (prop.prefixItems?.length) {
      if (!prop.prefixItems.every(isNumeric)) return null;
      return {
        kind: "numbers",
        count: prop.prefixItems.length,
        integer: prop.prefixItems.every((p) => propType(p) === "integer"),
      };
    }
    const item = prop.items;
    if (!item) return null;
    if (propType(item) === "string" || item.enum) return { kind: "list" };
    if (isNumeric(item)) return { kind: "numbers", count: null, integer: propType(item) === "integer" };
    const types = specTypes(item);
    return types ? { kind: "specs", types } : null;
  }

  if (t === "object") {
    if (prop.properties) {
      const children = Object.values(prop.properties);
      // One level of nesting only. A group inside a group is the point where a form
      // stops being clearer than the JSON, and the page keeps that escape hatch.
      const drawable = children.every((child) => {
        const control = controlFor(child);
        return control !== null && control.kind !== "group";
      });
      return children.length > 0 && drawable
        ? { kind: "group", properties: prop.properties, required: prop.required ?? [] }
        : null;
    }
    // An open map of string → string (`fieldMap`).
    const extra = prop.additionalProperties;
    if (extra && typeof extra === "object" && propType(extra) === "string") return { kind: "pairs" };
    return null;
  }

  return null;
};

const isDrawable = (schema: ObjectSchema): boolean => {
  const props = Object.values(schema.properties ?? {});
  return props.length > 0 && props.every((prop) => controlFor(prop) !== null);
};

/**
 * The object schema to draw a form from.
 *
 * A function may publish a *union* of accepted shapes — FORM_DATA_EXTRACTION takes
 * either a list of fields or a raw JSON Schema. Draw the first branch that can be
 * rendered; the page's JSON editor covers the rest.
 */
export const asObjectSchema = (schema: unknown): ObjectSchema | null => {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as ObjectSchema;
  if (s.type === "object" && s.properties) return s;
  if (Array.isArray(s.anyOf)) {
    for (const branch of s.anyOf) {
      const resolved = asObjectSchema(branch);
      if (resolved && isDrawable(resolved)) return resolved;
    }
  }
  return null;
};

/** True when the function declares no arguments at all — there is nothing to ask for. */
export const hasNoArgs = (schema: unknown): boolean => {
  const s = asObjectSchema(schema);
  return s !== null && Object.keys(s.properties ?? {}).length === 0;
};

/** True when every field of the schema maps to a control we can render. */
export const hasArgsForm = (schema: unknown): boolean => {
  const s = asObjectSchema(schema);
  return s !== null && isDrawable(s);
};

// ── Text ⇄ value ──────────────────────────────────────────────────────────────

/**
 * Commas separate entries, so an entry cannot contain one. That is the cost of a
 * single-line syntax, and it is the right trade here: no argument in the catalog
 * takes comma-bearing values, and the JSON editor remains for anything that does.
 */
const splitEntries = (text: string): string[] =>
  text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

/** Renders a schema default back into the line a person would have typed. */
export const toText = (control: Control, value: unknown): string => {
  if (value === undefined || value === null) return "";
  switch (control.kind) {
    case "list":
    case "numbers":
      return Array.isArray(value) ? value.map(String).join(", ") : String(value);
    case "pairs":
      return typeof value === "object"
        ? Object.entries(value as Record<string, unknown>)
            .map(([key, name]) => `${key}: ${String(name)}`)
            .join(", ")
        : "";
    case "specs":
      return Array.isArray(value)
        ? value
            .map((spec) => {
              const s = spec as { name?: unknown; type?: unknown; required?: unknown };
              return `${String(s.name ?? "")}: ${String(s.type ?? "string")}${s.required ? "*" : ""}`;
            })
            .join(", ")
        : "";
    default:
      return String(value);
  }
};

type Parsed = { value?: unknown; error?: string };

/** A `value` of `undefined` with no error means "omit it and let the backend default apply". */
const parse = (control: Control, prop: SchemaProp, raw: unknown): Parsed => {
  if (control.kind === "switch") return { value: typeof raw === "boolean" ? raw : undefined };
  if (control.kind === "enum") return { value: raw === "" || raw === undefined ? undefined : String(raw) };

  const text = raw === undefined || raw === null ? "" : String(raw).trim();
  if (text === "") return {};

  switch (control.kind) {
    case "text": {
      if (prop.minLength !== undefined && text.length < prop.minLength) {
        return { error: `Needs at least ${prop.minLength} character${prop.minLength === 1 ? "" : "s"}.` };
      }
      if (prop.maxLength !== undefined && text.length > prop.maxLength) {
        return { error: `Keep this to ${prop.maxLength} characters or fewer.` };
      }
      return { value: text };
    }

    case "number": {
      const n = Number(text);
      if (!Number.isFinite(n)) return { error: `"${text}" is not a number.` };
      if (control.integer && !Number.isInteger(n)) return { error: "Use a whole number." };
      if (prop.minimum !== undefined && n < prop.minimum) return { error: `Must be ${prop.minimum} or more.` };
      if (prop.maximum !== undefined && n > prop.maximum) return { error: `Must be ${prop.maximum} or less.` };
      return { value: n };
    }

    case "list": {
      const entries = splitEntries(text);
      if (entries.length === 0) return {};
      if (prop.maxItems !== undefined && entries.length > prop.maxItems) {
        return { error: `That is ${entries.length} entries; the limit is ${prop.maxItems}.` };
      }
      return { value: entries };
    }

    case "numbers": {
      const numbers: number[] = [];
      for (const entry of splitEntries(text)) {
        const n = Number(entry);
        if (!Number.isFinite(n)) return { error: `"${entry}" is not a number.` };
        if (control.integer && !Number.isInteger(n)) return { error: `"${entry}" must be a whole number.` };
        numbers.push(n);
      }
      if (control.count !== null && numbers.length !== control.count) {
        return { error: `Enter ${control.count} numbers separated by a comma — for example "1, 5".` };
      }
      return { value: numbers };
    }

    case "pairs": {
      const map: Record<string, string> = {};
      for (const entry of splitEntries(text)) {
        const at = entry.indexOf(":");
        if (at === -1) return { error: `Write each one as "original: your name" — "${entry}" has no colon.` };
        const key = entry.slice(0, at).trim();
        const name = entry.slice(at + 1).trim();
        if (!key || !name) return { error: `Write each one as "original: your name" — "${entry}" is incomplete.` };
        map[key] = name;
      }
      return Object.keys(map).length > 0 ? { value: map } : {};
    }

    case "specs": {
      const specs: { name: string; type: string; required?: boolean }[] = [];
      for (const entry of splitEntries(text)) {
        // A trailing `*` marks the field required — accepted on either side of the
        // colon, because both readings are natural and neither is worth correcting.
        let body = entry;
        let required = false;
        if (body.endsWith("*")) {
          required = true;
          body = body.slice(0, -1).trim();
        }
        const at = body.indexOf(":");
        let name = at === -1 ? body : body.slice(0, at).trim();
        // Text is the sensible default, so "Invoice number" on its own should work.
        const type =
          at === -1
            ? control.types[0]!
            : body
                .slice(at + 1)
                .trim()
                .toLowerCase();
        if (name.endsWith("*")) {
          required = true;
          name = name.slice(0, -1).trim();
        }
        if (!name) return { error: `"${entry}" has no field name.` };
        if (!control.types.includes(type)) {
          return { error: `"${type}" is not a type. Use ${control.types.join(", ")}.` };
        }
        specs.push(required ? { name, type, required } : { name, type });
      }
      if (specs.length === 0) return {};
      if (prop.maxItems !== undefined && specs.length > prop.maxItems) {
        return { error: `That is ${specs.length} fields; the limit is ${prop.maxItems}.` };
      }
      return { value: specs };
    }

    default:
      return {};
  }
};

// ── Public helpers ────────────────────────────────────────────────────────────

/** Seeds form state from the schema's declared defaults, in the form each control edits. */
export const defaultArgs = (schema: unknown): ArgValues => {
  const s = asObjectSchema(schema);
  if (!s) return {};
  const out: ArgValues = {};
  for (const [key, prop] of Object.entries(s.properties ?? {})) {
    const control = controlFor(prop);
    if (!control) continue;
    if (control.kind === "group") {
      const nested = defaultArgs({ type: "object", properties: control.properties });
      if (Object.keys(nested).length > 0) out[key] = nested;
      continue;
    }
    if (prop.default === undefined) continue;
    out[key] = control.kind === "switch" ? Boolean(prop.default) : toText(control, prop.default);
  }
  return out;
};

/**
 * Turns form state into the args payload, collecting every field's problem rather
 * than stopping at the first — someone who mistyped two lines should see both.
 *
 * A field left empty is **omitted**, not sent as `""`: the backend's own default then
 * applies, which is what "leave it blank for the usual behaviour" has to mean. A
 * field that is genuinely required *and* carries no default is the one case where
 * empty is an error.
 */
export const buildArgs = (schema: unknown, values: ArgValues): { args: ArgValues; errors: ArgErrors } => {
  const errors: ArgErrors = {};

  const walk = (s: ObjectSchema, current: ArgValues, prefix: string): ArgValues => {
    const args: ArgValues = {};
    const required = new Set(s.required ?? []);

    for (const [key, prop] of Object.entries(s.properties ?? {})) {
      const control = controlFor(prop);
      if (!control) continue;
      const path = prefix ? `${prefix}.${key}` : key;

      if (control.kind === "group") {
        const nested = walk(
          { type: "object", properties: control.properties, required: control.required },
          (current[key] as ArgValues) ?? {},
          path,
        );
        // An all-empty group is left out entirely rather than sent as `{}`.
        if (Object.keys(nested).length > 0) args[key] = nested;
        continue;
      }

      const { value, error } = parse(control, prop, current[key]);
      if (error) {
        errors[path] = error;
        continue;
      }
      if (value === undefined) {
        // Zod marks defaulted fields as `required` in the published schema even though
        // they are optional on input, so only a field with no default can be missing.
        if (required.has(key) && prop.default === undefined) errors[path] = "This one is needed.";
        continue;
      }
      args[key] = value;
    }
    return args;
  };

  const resolved = asObjectSchema(schema);
  return { args: resolved ? walk(resolved, values, "") : {}, errors };
};
