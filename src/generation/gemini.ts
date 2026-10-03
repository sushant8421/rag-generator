import type { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { withRetry } from "../retry.js";
import type { RetrievedChunk } from "../types.js";
import type { AnswerGenerator } from "./types.js";

const SYSTEM_PROMPT = `You answer questions using ONLY the provided context excerpts.
- If the excerpts do not contain the answer, say you could not find it in the documents. Do not use outside knowledge or guess.
- If the excerpts only partially answer the question, answer what they support and say what is missing.
- Cite the excerpts you used inline right after the claim they support, one bracket per excerpt: [1] or [1][3], never [1, 3].
- Be concise and direct. Use Markdown (short paragraphs, bullet lists, tables, \`code\`) where it helps readability.
- Never use LaTeX; write symbols as plain Unicode (≤, →, ×) exactly as the excerpts do.`;

export class GeminiAnswerGenerator implements AnswerGenerator {
  constructor(
    private readonly ai: GoogleGenAI,
    private readonly model: string,
    private readonly thinkingLevel?: string,
  ) {}

  async generate(question: string, context: RetrievedChunk[]): Promise<string> {
    const excerpts = context
      .map((c, i) => `[${i + 1}] (section: ${c.section}; file: ${c.filename})\n${c.text}`)
      .join("\n\n---\n\n");

    const res = await withRetry(() =>
      this.ai.models.generateContent({
        model: this.model,
        contents: `Context excerpts:\n\n${excerpts}\n\nQuestion: ${question}`,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.2,
          ...(this.thinkingLevel && { thinkingConfig: { thinkingLevel: this.thinkingLevel as ThinkingLevel } }),
        },
      }),
    );
    return res.text?.trim() ?? "";
  }
}
