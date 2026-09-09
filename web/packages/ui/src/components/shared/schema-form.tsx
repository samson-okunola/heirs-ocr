"use client";

import {
  type ArgErrors,
  type ArgValues,
  type Control,
  type ObjectSchema,
  type SchemaProp,
  asObjectSchema,
  controlFor,
  toText,
} from "../../lib/schema-args";
import { capitalize, fromCamelCase } from "../../lib/string";
import { Textarea } from "../ui/textarea";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { cn } from "../../lib/utils";
import { Field } from "./field";

export type { ArgErrors, ArgValues } from "../../lib/schema-args";
export { buildArgs, defaultArgs, hasArgsForm, hasNoArgs } from "../../lib/schema-args";

// ── Rendering ─────────────────────────────────────────────────────────────────

const labelFor = (key: string): string => capitalize(fromCamelCase(key));

/**
 * How to type this control, in the words of someone who has never seen JSON. Sits
 * after the schema's own `description`, which says *what* the field does.
 */
const syntaxHint = (control: Control, prop: SchemaProp): string | undefined => {
  switch (control.kind) {
    case "list":
      return "Separate each entry with a comma.";
    case "numbers":
      return control.count === 2
        ? "Two numbers separated by a comma — the first and the last, e.g. 1, 5."
        : "Numbers separated by commas.";
    case "pairs":
      return 'One rename per comma, written as "original: your name".';
    case "specs":
      return `One field per comma, written as "Field name: type". Types: ${control.types.join(", ")}. Add * to mark a field as required.`;
    default:
      return prop.minimum !== undefined && prop.maximum !== undefined
        ? `Between ${prop.minimum} and ${prop.maximum}.`
        : undefined;
  }
};

/** An example line — from the schema when it offers one, invented when it doesn't. */
const placeholderFor = (control: Control, prop: SchemaProp): string | undefined => {
  const example = prop.examples?.[0];
  if (example !== undefined) return toText(control, example);
  if (prop.default !== undefined && control.kind !== "switch") return toText(control, prop.default);
  switch (control.kind) {
    case "list":
      return "first entry, second entry";
    case "numbers":
      return control.count === 2 ? "1, 5" : "1, 2, 3";
    case "pairs":
      return "original: your name";
    case "specs":
      return "Invoice number: string, Total: number*";
    default:
      return undefined;
  }
};

const isMultiline = (control: Control): boolean =>
  control.kind === "list" || control.kind === "pairs" || control.kind === "specs";

interface SchemaFormProps {
  schema: unknown;
  values: ArgValues;
  onChange: (values: ArgValues) => void;
  /** Per-field messages from {@link buildArgs}, keyed by the same dotted paths. */
  errors?: ArgErrors;
}

export const SchemaForm = ({ schema, values, onChange, errors = {} }: SchemaFormProps) => {
  const resolved = asObjectSchema(schema);
  if (!resolved) return null;
  return <Group schema={resolved} values={values} onChange={onChange} errors={errors} prefix="" />;
};

const Group = ({
  schema,
  values,
  onChange,
  errors,
  prefix,
}: {
  schema: ObjectSchema;
  values: ArgValues;
  onChange: (values: ArgValues) => void;
  errors: ArgErrors;
  prefix: string;
}) => {
  const required = new Set(schema.required ?? []);
  const set = (key: string, value: unknown) => onChange({ ...values, [key]: value });

  return (
    <div className="space-y-3">
      {Object.entries(schema.properties ?? {}).map(([key, prop]) => {
        const control = controlFor(prop);
        if (!control) return null;

        const path = prefix ? `${prefix}.${key}` : key;
        const label = labelFor(key);
        const error = errors[path];
        // A field carrying a default is never really required of the person filling
        // the form in, whatever the published schema says.
        const mustFill = required.has(key) && prop.default === undefined;
        const hint = [prop.description, syntaxHint(control, prop)].filter(Boolean).join(" ") || undefined;

        if (control.kind === "group") {
          return (
            <div key={key} className="border-border space-y-3 rounded-md border border-dashed p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{label}</p>
                {prop.description && <p className="text-muted-foreground text-xs text-pretty">{prop.description}</p>}
              </div>
              <Group
                schema={{ type: "object", properties: control.properties, required: control.required }}
                values={(values[key] as ArgValues) ?? {}}
                onChange={(nested) => set(key, nested)}
                errors={errors}
                prefix={path}
              />
            </div>
          );
        }

        if (control.kind === "switch") {
          return (
            <div key={key} className="flex items-start justify-between gap-4">
              <div className="space-y-0.5">
                <span className="text-sm font-medium">{label}</span>
                {hint && <p className="text-muted-foreground text-xs text-pretty">{hint}</p>}
              </div>
              <Switch checked={Boolean(values[key])} onCheckedChange={(checked) => set(key, checked)} />
            </div>
          );
        }

        if (control.kind === "enum") {
          return (
            <Field
              key={key}
              label={label}
              hint={hint}
              error={error}
              required={mustFill}
              renderControl={(id) => (
                <select
                  id={id}
                  value={String(values[key] ?? "")}
                  onChange={(e) => set(key, e.target.value)}
                  className={cn(
                    "border-input h-8 w-full rounded-md border bg-transparent px-2.5 text-sm outline-none",
                    "focus-visible:border-ring",
                  )}
                >
                  {control.options.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              )}
            />
          );
        }

        const text = values[key] === undefined ? "" : String(values[key]);
        const placeholder = placeholderFor(control, prop);

        return (
          <Field
            key={key}
            label={label}
            hint={hint}
            error={error}
            required={mustFill}
            renderControl={(id) =>
              isMultiline(control) ? (
                <Textarea
                  id={id}
                  value={text}
                  rows={2}
                  spellCheck={false}
                  placeholder={placeholder}
                  onChange={(e) => set(key, e.target.value)}
                  className="text-sm"
                />
              ) : (
                <Input
                  id={id}
                  type={control.kind === "number" ? "number" : "text"}
                  value={text}
                  min={prop.minimum}
                  max={prop.maximum}
                  step={control.kind === "number" && control.integer ? 1 : "any"}
                  maxLength={control.kind === "text" ? prop.maxLength : undefined}
                  placeholder={placeholder}
                  onChange={(e) => set(key, e.target.value)}
                />
              )
            }
          />
        );
      })}
    </div>
  );
};
