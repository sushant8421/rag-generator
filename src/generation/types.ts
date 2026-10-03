import type { RetrievedChunk } from "../types.js";

export interface AnswerGenerator {
  generate(question: string, context: RetrievedChunk[]): Promise<string>;
}
