import type { Chunk, ParsedDocument } from "../types.js";

export interface Chunker {
  chunk(doc: ParsedDocument, uploadedAt?: string): Chunk[];
}
