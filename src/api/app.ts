import { basename, join } from "node:path";
import express, { type ErrorRequestHandler, type Request } from "express";
import multer from "multer";
import { z } from "zod";
import type { Config } from "../config.js";
import { HttpError } from "../errors.js";
import type { IngestionQueue } from "../ingestion/queue.js";
import { validateUpload } from "../ingestion/validate.js";
import { supportedExtensions } from "../parsing/index.js";
import type { AskService } from "../query/ask.js";
import type { VectorStore } from "../vectorstore/types.js";

export interface AppDeps {
  config: Config;
  store: VectorStore;
  queue: IngestionQueue;
  askService: AskService;
  embeddingModel: string;
}

const createSectionBody = z.object({ displayName: z.string().trim().min(1).max(100) });
const askBody = z.object({
  question: z.string().trim().min(1).max(2000),
  sections: z.array(z.string()).default([]),
});

export function createApp({ config, store, queue, askService, embeddingModel }: AppDeps) {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use(express.static(join(import.meta.dirname, "../../public")));
  app.use("/vendor/marked.js", express.static(join(import.meta.dirname, "../../node_modules/marked/lib/marked.umd.js")));
  app.use("/vendor/purify.js", express.static(join(import.meta.dirname, "../../node_modules/dompurify/dist/purify.min.js")));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.max(config.MAX_PDF_BYTES, config.MAX_TEXT_BYTES), files: config.MAX_FILES_PER_UPLOAD },
    defParamCharset: "utf8", // default latin1 garbles non-ASCII filenames
  });

  app.get("/health", async (_req, res) => {
    try {
      await store.ping();
      res.json({ status: "ok", chroma: "up" });
    } catch {
      res.status(503).json({ status: "degraded", chroma: "down" });
    }
  });

  app.get("/api/config", (_req, res) => {
    res.json({
      supportedExtensions,
      maxPdfPages: config.MAX_PDF_PAGES,
      maxPdfBytes: config.MAX_PDF_BYTES,
      maxTextBytes: config.MAX_TEXT_BYTES,
      maxFilesPerUpload: config.MAX_FILES_PER_UPLOAD,
    });
  });

  // ---- Sections (one Chroma collection each) ----

  app.get("/api/sections", async (_req, res) => {
    const cols = await store.listCollections();
    const sections = await Promise.all(
      cols.map(async (c) => {
        const docs = await store.listDocuments(c.name);
        return {
          ...c,
          documentCount: docs.length,
          chunkCount: docs.reduce((n, d) => n + d.chunkCount, 0),
          compatible: c.embeddingModel === embeddingModel,
        };
      }),
    );
    res.json(sections);
  });

  app.post("/api/sections", async (req, res) => {
    const { displayName } = parse(createSectionBody, req.body);
    const name = slugify(displayName);
    if (await store.getCollection(name)) throw new HttpError(409, `A section named "${displayName}" already exists`);
    const info = await store.ensureCollection({ name, displayName, embeddingModel });
    res.status(201).json(info);
  });

  app.delete("/api/sections/:name", async (req, res) => {
    await requireSection(req);
    await store.deleteCollection(req.params.name as string);
    res.status(204).end();
  });

  // ---- Documents ----

  app.get("/api/sections/:name/documents", async (req, res) => {
    await requireSection(req);
    res.json(await store.listDocuments(req.params.name as string));
  });

  app.delete("/api/sections/:name/documents/:documentId", async (req, res) => {
    await requireSection(req);
    await store.deleteDocument(req.params.name as string, req.params.documentId as string);
    res.status(204).end();
  });

  /** Validates files synchronously, then hands them to the background queue. Returns 202 with job ids. */
  app.post("/api/sections/:name/documents", upload.array("files"), async (req, res) => {
    const section = await requireSection(req);
    if (section.embeddingModel !== embeddingModel) {
      throw new HttpError(409, `Section was built with ${section.embeddingModel}; server is using ${embeddingModel}`);
    }
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) throw new HttpError(400, 'No files uploaded (use multipart field "files")');

    const jobs = [];
    const rejected = [];
    for (const f of files) {
      const filename = basename(f.originalname);
      try {
        await validateUpload(filename, f.buffer, {
          maxPdfPages: config.MAX_PDF_PAGES,
          maxPdfBytes: config.MAX_PDF_BYTES,
          maxTextBytes: config.MAX_TEXT_BYTES,
        });
        jobs.push(queue.enqueue({ section: section.name, filename, buffer: f.buffer }));
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        rejected.push({ filename, error: err.message });
      }
    }
    res.status(jobs.length ? 202 : 422).json({ jobs, rejected });
  });

  app.get("/api/jobs", (req, res) => {
    const section = typeof req.query.section === "string" ? req.query.section : undefined;
    res.json(queue.list(section));
  });

  // ---- Q&A ----

  app.post("/api/ask", async (req, res) => {
    const { question, sections } = parse(askBody, req.body);
    res.json(await askService.ask(question, sections));
  });

  app.use("/api", (_req, _res) => {
    throw new HttpError(404, "Not found");
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
    } else if (err instanceof multer.MulterError) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? `A file exceeds the ${Math.round(Math.max(config.MAX_PDF_BYTES, config.MAX_TEXT_BYTES) / 1024 / 1024)} MB upload limit`
          : err.code === "LIMIT_FILE_COUNT"
            ? `At most ${config.MAX_FILES_PER_UPLOAD} files per upload`
            : err.message;
      res.status(status).json({ error: message });
    } else {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  };
  app.use(onError);

  async function requireSection(req: Request) {
    const section = await store.getCollection(req.params.name as string);
    if (!section) throw new HttpError(404, `Section "${req.params.name}" not found`);
    return section;
  }

  return app;
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, z.prettifyError(r.error));
  return r.data;
}

/** Display name -> Chroma-safe collection name: 3-63 chars of [a-z0-9-], alphanumeric at both ends. */
export function slugify(displayName: string): string {
  const slug = displayName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  if (slug.length < 3) throw new HttpError(400, "Section name needs at least 3 letters or digits");
  return slug;
}
