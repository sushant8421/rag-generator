import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  CHROMA_URL: z.url().default("http://localhost:8000"),
  CHUNK_SIZE: z.coerce.number().int().positive().default(1000),
  CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(150),
  TOP_K: z.coerce.number().int().positive().default(5),
  // Auto-routing: also use sections whose best match is within this cosine distance of the best section.
  ROUTING_MARGIN: z.coerce.number().nonnegative().default(0.04),
  MAX_PDF_PAGES: z.coerce.number().int().positive().default(100),
  MAX_PDF_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024), // 20 MB
  MAX_TEXT_BYTES: z.coerce.number().int().positive().default(300 * 1024), // ~100 pages at ~3,000 chars/page
  MAX_FILES_PER_UPLOAD: z.coerce.number().int().positive().default(10),
  INGEST_CONCURRENCY: z.coerce.number().int().positive().default(2),
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),
  GENERATION_MODEL: z.string().default("gemini-3.8-flash"),
  // LOW cut answer latency ~3.9s -> ~1.4s on gemini-3.8-flash. Empty = model default (for models without thinking levels).
  GENERATION_THINKING_LEVEL: z.enum(["", "LOW", "MEDIUM", "HIGH"]).default("LOW"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration:", z.prettifyError(parsed.error));
  process.exit(1);
}
if (parsed.data.CHUNK_OVERLAP >= parsed.data.CHUNK_SIZE) {
  console.error("Invalid configuration: CHUNK_OVERLAP must be smaller than CHUNK_SIZE");
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
