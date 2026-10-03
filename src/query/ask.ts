import type { Embedder } from "../embedding/types.js";
import { HttpError } from "../errors.js";
import type { AnswerGenerator } from "../generation/types.js";
import type { Answer, RetrievedChunk } from "../types.js";
import type { VectorStore } from "../vectorstore/types.js";

/** embed question -> retrieve from one or more sections -> generate grounded answer. */
export class AskService {
  constructor(
    private readonly store: VectorStore,
    private readonly embedder: Embedder,
    private readonly generator: AnswerGenerator,
    private readonly topK: number,
    private readonly routingMargin: number,
  ) {}

  /**
   * @param sections sections to search. Empty = auto-route: search every section and
   * answer from the best-matching one (plus any within `routingMargin` of it).
   */
  async ask(question: string, sections: string[]): Promise<Answer> {
    const all = await this.store.listCollections();
    const unknown = sections.filter((s) => !all.some((c) => c.name === s));
    if (unknown.length) throw new HttpError(404, `Unknown section(s): ${unknown.join(", ")}`);

    const mode = sections.length ? "manual" : "auto";
    const targets = sections.length ? all.filter((c) => sections.includes(c.name)) : all;

    // Vectors from a different embedding model live in a different space; never compare them.
    const searchable = targets.filter((c) => c.embeddingModel === this.embedder.modelId);
    if (searchable.length === 0) {
      return { answer: "There are no documents to search yet. Upload some in the Documents tab first.", sources: [], routing: { mode, sections: [] } };
    }

    const qv = await this.embedder.embedQuery(question);
    const perSection = (
      await Promise.all(searchable.map(async (c) => ({ info: c, hits: await this.store.query(c.name, qv, this.topK) })))
    ).filter((s) => s.hits.length > 0);

    if (perSection.length === 0) {
      return { answer: "The selected sections have no documents yet.", sources: [], routing: { mode, sections: [] } };
    }

    // Route by each section's closest chunk. Calibrated on our docs: single-topic questions
    // separate by >= 0.06 cosine distance, while cross-topic ones land within ~0.01.
    const best = Math.min(...perSection.map((s) => s.hits[0]!.distance));
    const chosen = mode === "manual" ? perSection : perSection.filter((s) => s.hits[0]!.distance <= best + this.routingMargin);

    const hits = chosen
      .flatMap((s) => s.hits)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, this.topK);

    const answer = await this.generator.generate(question, hits);
    const cited = citedNumbers(answer);

    return {
      answer,
      sources: hits.map((h, i) => ({
        n: i + 1,
        section: h.section,
        filename: h.filename,
        heading: h.heading,
        snippet: snippet(h),
        distance: Number(h.distance.toFixed(4)),
        cited: cited.has(i + 1),
      })),
      routing: {
        mode,
        sections: perSection
          .map((s) => ({
            name: s.info.name,
            displayName: s.info.displayName,
            bestDistance: Number(s.hits[0]!.distance.toFixed(4)),
            selected: chosen.includes(s),
          }))
          .sort((a, b) => a.bestDistance - b.bestDistance),
      },
    };
  }
}

/** The full chunk body without its heading prefix (shown separately), so users can verify the cited evidence. */
function snippet(h: RetrievedChunk): string {
  return h.heading && h.text.startsWith(h.heading) ? h.text.slice(h.heading.length).trim() : h.text;
}

/** Citation numbers in the answer; handles both "[1][4]" and grouped "[1, 4]" styles. */
export function citedNumbers(answer: string): Set<number> {
  const nums = [...answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1]!.split(",").map(Number));
  return new Set(nums);
}
