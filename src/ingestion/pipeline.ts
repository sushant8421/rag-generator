import { randomUUID } from "node:crypto";
import type { Chunker } from "../chunking/types.js";
import type { Embedder } from "../embedding/types.js";
import { parserFor } from "../parsing/index.js";
import type { VectorStore } from "../vectorstore/types.js";

export type IngestStage = "parsing" | "chunking" | "embedding" | "storing";

export interface IngestResult {
  documentId: string;
  chunks: number;
  replaced: boolean;
}

/** parse -> chunk -> embed -> store, for one file into one (existing) collection. */
export class IngestionPipeline {
  constructor(
    private readonly store: VectorStore,
    private readonly chunker: Chunker,
    private readonly embedder: Embedder,
  ) {}

  async run(
    section: string,
    filename: string,
    buffer: Buffer,
    onStage: (stage: IngestStage) => void = () => {},
  ): Promise<IngestResult> {
    onStage("parsing");
    const parser = parserFor(filename);
    if (!parser) throw new Error(`No parser for ${filename}`);
    const text = await parser.parse(buffer);
    if (!text.trim()) throw new Error("No extractable text (scanned/image-only PDF?)");

    onStage("chunking");
    const documentId = randomUUID();
    const chunks = this.chunker.chunk({ documentId, filename, text });
    if (chunks.length === 0) throw new Error("Document produced no chunks");

    onStage("embedding");
    const embeddings = await this.embedder.embedDocuments(chunks.map((c) => c.text));

    // Re-uploading a file with the same name replaces the old version. Done only
    // after embedding succeeds, so a failed upload never loses the old copy.
    onStage("storing");
    const previous = (await this.store.listDocuments(section)).filter((d) => d.filename === filename);
    await this.store.upsert(section, chunks, embeddings);
    for (const d of previous) await this.store.deleteDocument(section, d.documentId);

    return { documentId, chunks: chunks.length, replaced: previous.length > 0 };
  }
}
