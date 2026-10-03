import type { Chunk, ParsedDocument } from "../types.js";
import type { Chunker } from "./types.js";

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const SEPARATORS = ["\n\n", "\n", ". ", " ", ""];
const MIN_BODY_BUDGET = 200;

interface Section {
  headings: string[];
  body: string;
}

/**
 * Splits text along Markdown headings, then splits each section recursively
 * (paragraph > line > sentence > word > char) into chunks of at most `size`
 * characters with `overlap` characters of carry-over.
 *
 * Every chunk is prefixed with its heading breadcrumb, so a chunk taken from
 * deep inside a section still says what it's about. Text without headings
 * (PDFs, plain text) is treated as a single section.
 */
export class MarkdownChunker implements Chunker {
  constructor(
    private readonly size: number,
    private readonly overlap: number,
  ) {}

  chunk(doc: ParsedDocument, uploadedAt = new Date().toISOString()): Chunk[] {
    const chunks: Chunk[] = [];
    for (const { headings, body } of splitSections(doc.text)) {
      if (!body.trim()) continue;
      const heading = headings.join(" > ");
      const prefix = heading ? `${heading}\n\n` : "";
      const budget = Math.max(this.size - prefix.length, MIN_BODY_BUDGET);
      const overlap = Math.min(this.overlap, Math.floor(budget / 2));
      for (const piece of splitRecursive(body.trim(), budget, overlap, SEPARATORS)) {
        const index = chunks.length;
        chunks.push({
          id: `${doc.documentId}:${index}`,
          documentId: doc.documentId,
          filename: doc.filename,
          index,
          heading,
          text: prefix + piece,
          uploadedAt,
        });
      }
    }
    return chunks;
  }
}

export function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  const stack: string[] = [];
  let body: string[] = [];
  let inFence = false;

  const flush = () => {
    sections.push({ headings: stack.filter(Boolean), body: body.join("\n") });
    body = [];
  };

  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    const m = inFence ? null : HEADING.exec(line);
    if (m) {
      flush();
      const level = m[1]!.length;
      stack.length = level - 1; // drop deeper/sibling headings
      stack[level - 1] = m[2]!;
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

export function splitRecursive(text: string, size: number, overlap: number, separators: string[]): string[] {
  if (text.length <= size) return [text];
  const [sep, ...rest] = separators;

  if (!sep) {
    // Last resort: hard cut by characters.
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size - overlap) out.push(text.slice(i, i + size));
    return out;
  }
  if (!text.includes(sep)) return splitRecursive(text, size, overlap, rest);

  const units = text
    .split(sep)
    .flatMap((part) => (part.length > size ? splitRecursive(part, size, overlap, rest) : [part]));
  return merge(units, sep, size, overlap);
}

/** Greedily packs units into chunks <= size, carrying up to `overlap` chars of trailing units into the next chunk. */
function merge(units: string[], sep: string, size: number, overlap: number): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let len = 0;
  const joinedLen = (n: number) => (cur.length ? sep.length : 0) + n;

  for (const unit of units) {
    if (cur.length && len + joinedLen(unit.length) > size) {
      chunks.push(cur.join(sep));
      while (cur.length && (len > overlap || len + joinedLen(unit.length) > size)) {
        len -= cur[0]!.length + (cur.length > 1 ? sep.length : 0);
        cur.shift();
      }
    }
    len += joinedLen(unit.length);
    cur.push(unit);
  }
  if (cur.length) chunks.push(cur.join(sep));
  return chunks.map((c) => c.trim()).filter(Boolean);
}
