import { randomUUID } from "node:crypto";
import type { IngestionPipeline, IngestResult, IngestStage } from "./pipeline.js";

export type JobStatus = "queued" | IngestStage | "done" | "failed";

export interface IngestJob {
  id: string;
  section: string;
  filename: string;
  status: JobStatus;
  result?: IngestResult;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

export interface EnqueueInput {
  section: string;
  filename: string;
  buffer: Buffer;
}

/** Accepts documents for background ingestion. Swap for a Redis/SQS-backed queue to scale out. */
export interface IngestionQueue {
  enqueue(input: EnqueueInput): IngestJob;
  list(section?: string): IngestJob[];
}

const FINISHED_JOB_TTL_MS = 60 * 60 * 1000;

/**
 * In-process queue: jobs run in the background on the API server, `concurrency`
 * at a time, so uploads never block query requests. Jobs (and their buffers)
 * live in memory and are lost on restart.
 */
export class InProcessQueue implements IngestionQueue {
  private readonly jobs = new Map<string, IngestJob>();
  private readonly pending: Array<{ job: IngestJob; buffer: Buffer }> = [];
  /** section/filename keys currently processing; same-file jobs must not overlap (replace-on-reupload would race). */
  private readonly active = new Set<string>();

  constructor(
    private readonly pipeline: IngestionPipeline,
    private readonly concurrency = 2,
  ) {}

  enqueue({ section, filename, buffer }: EnqueueInput): IngestJob {
    this.prune();
    const job: IngestJob = { id: randomUUID(), section, filename, status: "queued", createdAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    this.pending.push({ job, buffer });
    this.drain();
    return job;
  }

  list(section?: string): IngestJob[] {
    return [...this.jobs.values()]
      .filter((j) => !section || j.section === section)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private drain() {
    while (this.active.size < this.concurrency) {
      const i = this.pending.findIndex(({ job }) => !this.active.has(key(job)));
      if (i === -1) return;
      const [next] = this.pending.splice(i, 1);
      const k = key(next!.job);
      this.active.add(k);
      void this.process(next!.job, next!.buffer).finally(() => {
        this.active.delete(k);
        this.drain();
      });
    }
  }

  private async process(job: IngestJob, buffer: Buffer) {
    try {
      job.result = await this.pipeline.run(job.section, job.filename, buffer, (stage) => (job.status = stage));
      job.status = "done";
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      console.error(`Ingestion failed for ${job.section}/${job.filename}:`, err);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  }

  private prune() {
    const cutoff = Date.now() - FINISHED_JOB_TTL_MS;
    for (const [id, j] of this.jobs) {
      if (j.finishedAt && Date.parse(j.finishedAt) < cutoff) this.jobs.delete(id);
    }
  }
}

const key = (j: IngestJob) => `${j.section}/${j.filename}`;
