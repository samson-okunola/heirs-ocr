import { z } from "zod";

/** Guard rails: an unbounded caller schema is a prompt-size and DoS surface. */
export const MAX_FIELDS = 50;
export const MAX_NESTING_DEPTH = 3;
/** Hard ceiling on the serialized caller schema — a prompt-size + DoS bound. */
export const MAX_SCHEMA_BYTES = 20_000;

type SchemaBounds = { depth: number; nodes: number; bytes: number };

/** Walks an arbitrary JSON value, measuring nesting depth and node count. */
const measureBounds = (value: unknown, depth = 1): { depth: number; nodes: number } => {
  if (value === null || typeof value !== "object") return { depth, nodes: 1 };
  let maxDepth = depth;
  let nodes = 1;
  for (const child of Object.values(value as Record<string, unknown>)) {
    const m = measureBounds(child, depth + 1);
    if (m.depth > maxDepth) maxDepth = m.depth;
    nodes += m.nodes;
  }
  return { depth: maxDepth, nodes };
};

const boundsOf = (schema: Record<string, unknown>): SchemaBounds => {
  const { depth, nodes } = measureBounds(schema);
  return { depth, nodes, bytes: JSON.stringify(schema).length };
};

export const fieldSpecSchema = z.object({
  name: z.string().min(1).describe("What to call this field in the result."),
  type: z.enum(["string", "number", "boolean", "date"]).describe("What kind of value to expect."),
  description: z.string().optional().describe("A hint about where to find it, if the name alone is ambiguous."),
  required: z.boolean().default(false).describe("Flag the result when this field is missing from the document."),
  enum: z.array(z.string()).optional().describe("Restrict the answer to one of these values."),
});

export type FieldSpec = z.infer<typeof fieldSpecSchema>;

/**
 * Raw JSON Schema branch, bounded on depth, node count, and serialized size so a
 * caller can't drive prompt size / memory unbounded (docs/regression-and-security.md V5).
 */
const jsonSchemaArgSchema = z.object({ jsonSchema: z.record(z.string(), z.unknown()) }).superRefine((val, ctx) => {
  const { depth, nodes, bytes } = boundsOf(val.jsonSchema);
  if (depth > MAX_NESTING_DEPTH) {
    ctx.addIssue({
      code: "custom",
      path: ["jsonSchema"],
      message: `jsonSchema nesting exceeds ${MAX_NESTING_DEPTH} levels`,
    });
  }
  if (nodes > MAX_FIELDS) {
    ctx.addIssue({ code: "custom", path: ["jsonSchema"], message: `jsonSchema has more than ${MAX_FIELDS} nodes` });
  }
  if (bytes > MAX_SCHEMA_BYTES) {
    ctx.addIssue({
      code: "custom",
      path: ["jsonSchema"],
      message: `jsonSchema exceeds ${MAX_SCHEMA_BYTES} serialized bytes`,
    });
  }
});

/** Either a structured field spec or a bounded raw JSON Schema — exactly one. */
export const formDataExtractionArgsSchema = z.union([
  z.object({
    fields: z
      .array(fieldSpecSchema)
      .min(1)
      .max(MAX_FIELDS)
      .describe("The fields to pull off the document. Name each one and say what kind of value it holds."),
  }),
  jsonSchemaArgSchema,
]);

export type FormDataExtractionArgs = z.infer<typeof formDataExtractionArgsSchema>;
