import { z } from "zod";

export const textExtractionArgsSchema = z.object({
  format: z
    .enum(["markdown", "plain"])
    .default("markdown")
    .describe("How the text comes back: 'markdown' keeps headings and tables, 'plain' is text only."),
  pageRange: z
    .tuple([z.number().int().positive(), z.number().int().positive()])
    .optional()
    .describe("Only read part of the document, as a first and last page number. Omit to read all of it."),
  includeBlocks: z
    .boolean()
    .default(false)
    .describe("Also return where each piece of text sits on the page. Useful for highlighting, larger response."),
});

export type TextExtractionArgs = z.infer<typeof textExtractionArgsSchema>;
