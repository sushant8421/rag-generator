import type { GoogleGenAI } from "@google/genai";
import { withRetry } from "../retry.js";
import type { Embedder } from "./types.js";

const MAX_BATCH = 100; // API rejects more than 100 inputs per call

export class GeminiEmbedder implements Embedder {
  constructor(
    private readonly ai: GoogleGenAI,
    readonly modelId: string,
  ) {}

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      out.push(...(await this.embed(texts.slice(i, i + MAX_BATCH), "RETRIEVAL_DOCUMENT")));
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([text], "RETRIEVAL_QUERY");
    return vector!;
  }

  private async embed(texts: string[], taskType: string): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Each text must be its own Content object. Passing a bare string[] makes
    // some models (e.g. gemini-embedding-2) return a single combined vector.
    const res = await withRetry(() =>
      this.ai.models.embedContent({
        model: this.modelId,
        contents: texts.map((text) => ({ role: "user", parts: [{ text }] })),
        config: { taskType },
      }),
    );
    const vectors = (res.embeddings ?? []).map((e) => e.values ?? []);
    if (vectors.length !== texts.length || vectors.some((v) => v.length === 0)) {
      throw new Error(`Embedding API returned ${vectors.length} vectors for ${texts.length} inputs`);
    }
    return vectors;
  }
}
