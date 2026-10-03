import { extname } from "node:path";
import { pdfParser } from "./pdf.js";
import { textParser } from "./text.js";
import type { DocumentParser } from "./types.js";

const parsers: DocumentParser[] = [textParser, pdfParser];

export const supportedExtensions = parsers.flatMap((p) => p.extensions);

/** Returns the parser for a filename, or undefined if the type is unsupported. */
export function parserFor(filename: string): DocumentParser | undefined {
  const ext = extname(filename).toLowerCase();
  return parsers.find((p) => p.extensions.includes(ext));
}
