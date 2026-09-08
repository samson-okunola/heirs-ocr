import { describe, expect, it } from "vitest";

import { buildArgs, defaultArgs, hasArgsForm, hasNoArgs } from "../web/packages/ui/src/lib/schema-args";
import { buildCatalog } from "../src/functions/registry";

/**
 * The OCR console used to fall back to a raw JSON textarea for any function whose
 * arguments were not all primitives — six of the thirteen, including the two people
 * reach for most. These assert the form now covers the real catalog, and that the
 * comma-separated lines it asks for parse into exactly the JSON the API validates.
 *
 * Driven off `buildCatalog()` rather than hand-written fixtures, so a new function
 * whose args the form cannot draw fails here rather than in front of a customer.
 */
const catalog = buildCatalog();
const schemaFor = (key: string): unknown => {
  const entry = catalog.find((c) => c.key === key);
  if (!entry) throw new Error(`No such function '${key}'`);
  return entry.argsSchema;
};

describe("form coverage of the live catalog", () => {
  it("can draw a form for every function that takes arguments", () => {
    const undrawable = catalog.filter((entry) => !hasArgsForm(entry.argsSchema) && !hasNoArgs(entry.argsSchema));
    expect(undrawable.map((e) => e.key)).toEqual([]);
  });

  it("recognises the one function with no arguments at all", () => {
    expect(hasNoArgs(schemaFor("DOCUMENT_AUTHENTICITY"))).toBe(true);
    expect(hasArgsForm(schemaFor("DOCUMENT_AUTHENTICITY"))).toBe(false);
  });

  it("seeds each control from the schema's own defaults", () => {
    // A list default comes back as the line a person would have typed.
    expect(defaultArgs(schemaFor("SIGNING"))).toMatchObject({
      geometryOnly: false,
      signatureCues: "Signature, Signed by, For and on behalf of, Witness, Director",
      maxVisionPages: "3",
    });
  });
});

describe("comma-separated lists", () => {
  const schema = schemaFor("DOCUMENT_CLASSIFICATION");

  it("splits on commas and trims", () => {
    const { args, errors } = buildArgs(schema, { candidateLabels: " invoice , receipt ,contract " });
    expect(errors).toEqual({});
    expect(args.candidateLabels).toEqual(["invoice", "receipt", "contract"]);
  });

  it("ignores trailing commas and empty entries mid-edit", () => {
    expect(buildArgs(schema, { candidateLabels: "invoice, ,receipt," }).args.candidateLabels).toEqual([
      "invoice",
      "receipt",
    ]);
  });

  it("omits an empty field so the backend default applies", () => {
    const { args, errors } = buildArgs(schema, { candidateLabels: "  ", minConfidence: "" });
    expect(errors).toEqual({});
    expect(args).not.toHaveProperty("candidateLabels");
    expect(args).not.toHaveProperty("minConfidence");
  });
});

describe("a page range", () => {
  const schema = schemaFor("TEXT_EXTRACTION");

  it("reads two numbers as a tuple", () => {
    const { args, errors } = buildArgs(schema, { pageRange: "1, 5" });
    expect(errors).toEqual({});
    expect(args.pageRange).toEqual([1, 5]);
  });

  it("says so in plain words when the count is wrong", () => {
    expect(buildArgs(schema, { pageRange: "3" }).errors.pageRange).toBe(
      'Enter 2 numbers separated by a comma — for example "1, 5".',
    );
  });

  it("rejects a non-number and names the offending entry", () => {
    expect(buildArgs(schema, { pageRange: "1, five" }).errors.pageRange).toBe('"five" is not a number.');
  });

  it("rejects a fractional page", () => {
    expect(buildArgs(schema, { pageRange: "1, 5.5" }).errors.pageRange).toBe('"5.5" must be a whole number.');
  });
});

describe("a rename map", () => {
  const schema = schemaFor("RECEIPT_PARSING");

  it("reads colon-separated pairs", () => {
    const { args, errors } = buildArgs(schema, {
      fieldMap: "merchant.name: vendor, total: amount_due, lineItems.description: item",
    });
    expect(errors).toEqual({});
    expect(args.fieldMap).toEqual({
      "merchant.name": "vendor",
      total: "amount_due",
      "lineItems.description": "item",
    });
  });

  it("explains a missing colon rather than silently dropping the entry", () => {
    expect(buildArgs(schema, { fieldMap: "total amount_due" }).errors.fieldMap).toBe(
      'Write each one as "original: your name" — "total amount_due" has no colon.',
    );
  });

  it("carries the other options through alongside it", () => {
    const { args } = buildArgs(schema, { currency: "USD", expectedTaxRate: "0.2", lineItemMode: "single" });
    expect(args).toEqual({ currency: "USD", expectedTaxRate: 0.2, lineItemMode: "single" });
  });

  it("holds a numeric option to the schema's own bounds", () => {
    expect(buildArgs(schema, { expectedTaxRate: "1.5" }).errors.expectedTaxRate).toBe("Must be 1 or less.");
  });
});

describe("a field list", () => {
  // FORM_DATA_EXTRACTION publishes a union: a field list, or a raw JSON Schema. The
  // form draws the branch a person can reasonably type.
  const schema = schemaFor("FORM_DATA_EXTRACTION");

  it("reads name: type pairs", () => {
    const { args, errors } = buildArgs(schema, { fields: "Invoice number: string, Total: number" });
    expect(errors).toEqual({});
    expect(args.fields).toEqual([
      { name: "Invoice number", type: "string" },
      { name: "Total", type: "number" },
    ]);
  });

  it("defaults a bare name to text", () => {
    expect(buildArgs(schema, { fields: "Customer name" }).args.fields).toEqual([
      { name: "Customer name", type: "string" },
    ]);
  });

  it("takes a trailing * as required, on either side of the colon", () => {
    expect(buildArgs(schema, { fields: "Total: number*, Date*: date" }).args.fields).toEqual([
      { name: "Total", type: "number", required: true },
      { name: "Date", type: "date", required: true },
    ]);
  });

  it("names the valid types when given one that isn't", () => {
    expect(buildArgs(schema, { fields: "Total: money" }).errors.fields).toBe(
      '"money" is not a type. Use string, number, boolean, date.',
    );
  });

  it("treats the field list as genuinely required — it has no default", () => {
    expect(buildArgs(schema, { fields: "" }).errors.fields).toBe("This one is needed.");
  });
});

describe("nested options", () => {
  const schema = schemaFor("ID_VERIFICATION");

  it("collects a sub-group into a nested object", () => {
    const { args, errors } = buildArgs(schema, {
      documentType: "PASSPORT",
      expected: { fullName: "Ada Okafor", dateOfBirth: "", documentNumber: "A01234567" },
    });
    expect(errors).toEqual({});
    expect(args).toEqual({
      documentType: "PASSPORT",
      expected: { fullName: "Ada Okafor", documentNumber: "A01234567" },
    });
  });

  it("leaves an untouched sub-group out rather than sending an empty object", () => {
    const { args } = buildArgs(schema, { documentType: "AUTO", expected: { fullName: "", documentNumber: "" } });
    expect(args).toEqual({ documentType: "AUTO" });
  });
});

describe("reporting problems", () => {
  it("collects every field's problem, not just the first", () => {
    const { errors } = buildArgs(schemaFor("SIGNING"), { maxVisionPages: "99", signatureCues: "Signature" });
    expect(errors).toEqual({ maxVisionPages: "Must be 10 or less." });

    const both = buildArgs(schemaFor("TEXT_EXTRACTION"), { pageRange: "nope", format: "markdown" });
    expect(Object.keys(both.errors)).toEqual(["pageRange"]);
  });

  it("keys a nested problem by its dotted path", () => {
    const schema = {
      type: "object",
      properties: {
        expected: { type: "object", properties: { pages: { type: "integer", minimum: 1 } } },
      },
    };
    expect(buildArgs(schema, { expected: { pages: "0" } }).errors).toEqual({ "expected.pages": "Must be 1 or more." });
  });
});
