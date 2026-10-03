import { ChromaClient, type Collection } from "chromadb";
import type { Chunk, RetrievedChunk } from "../types.js";
import type { CollectionInfo, DocumentInfo, VectorStore } from "./types.js";

const UPSERT_BATCH = 500;

export function createChromaClient(url: string): ChromaClient {
  const u = new URL(url);
  const ssl = u.protocol === "https:";
  return new ChromaClient({
    host: u.hostname,
    port: u.port ? Number(u.port) : ssl ? 443 : 80,
    ssl,
  });
}

interface ChunkMetadata {
  documentId: string;
  filename: string;
  index: number;
  heading: string;
  uploadedAt: string;
  [key: string]: string | number;
}

export class ChromaVectorStore implements VectorStore {
  constructor(private readonly client: ChromaClient) {}

  async ping() {
    await this.client.heartbeat();
  }

  async listCollections(): Promise<CollectionInfo[]> {
    const cols = await this.client.listCollections();
    return cols.map(toInfo).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async getCollection(name: string): Promise<CollectionInfo | undefined> {
    const col = await this.find(name);
    return col && toInfo(col);
  }

  async ensureCollection(info: CollectionInfo): Promise<CollectionInfo> {
    const col = await this.client.getOrCreateCollection({
      name: info.name,
      metadata: { displayName: info.displayName, embeddingModel: info.embeddingModel },
      configuration: { hnsw: { space: "cosine" } },
      embeddingFunction: null, // we always supply our own embeddings
    });
    return toInfo(col);
  }

  async deleteCollection(name: string) {
    await this.client.deleteCollection({ name });
  }

  async listDocuments(collection: string): Promise<DocumentInfo[]> {
    const col = await this.open(collection);
    const res = await col.get<ChunkMetadata>({ include: ["metadatas"] });
    const docs = new Map<string, DocumentInfo>();
    for (const m of res.metadatas) {
      if (!m) continue;
      const d = docs.get(m.documentId);
      if (d) d.chunkCount++;
      else docs.set(m.documentId, { documentId: m.documentId, filename: m.filename, uploadedAt: m.uploadedAt, chunkCount: 1 });
    }
    return [...docs.values()].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }

  async deleteDocument(collection: string, documentId: string) {
    const col = await this.open(collection);
    await col.delete({ where: { documentId } });
  }

  async upsert(collection: string, chunks: Chunk[], embeddings: number[][]) {
    const col = await this.open(collection);
    for (let i = 0; i < chunks.length; i += UPSERT_BATCH) {
      const batch = chunks.slice(i, i + UPSERT_BATCH);
      await col.upsert({
        ids: batch.map((c) => c.id),
        embeddings: embeddings.slice(i, i + UPSERT_BATCH),
        documents: batch.map((c) => c.text),
        metadatas: batch.map((c) => ({
          documentId: c.documentId,
          filename: c.filename,
          index: c.index,
          heading: c.heading,
          uploadedAt: c.uploadedAt,
        })),
      });
    }
  }

  async query(collection: string, embedding: number[], topK: number): Promise<RetrievedChunk[]> {
    const col = await this.open(collection);
    const res = await col.query<ChunkMetadata>({
      queryEmbeddings: [embedding],
      nResults: topK,
      include: ["documents", "metadatas", "distances"],
    });
    const ids = res.ids[0] ?? [];
    return ids.map((id, i) => {
      const m = res.metadatas[0]![i]!;
      return {
        id,
        section: collection,
        documentId: m.documentId,
        filename: m.filename,
        index: m.index,
        heading: m.heading,
        uploadedAt: m.uploadedAt,
        text: res.documents[0]![i] ?? "",
        distance: res.distances[0]![i] ?? 1,
      };
    });
  }

  private async find(name: string): Promise<Collection | undefined> {
    const cols = await this.client.listCollections();
    return cols.find((c) => c.name === name);
  }

  private async open(name: string): Promise<Collection> {
    return this.client.getCollection({ name });
  }
}

function toInfo(col: Collection): CollectionInfo {
  const md = col.metadata ?? {};
  return {
    name: col.name,
    displayName: typeof md.displayName === "string" ? md.displayName : col.name,
    embeddingModel: typeof md.embeddingModel === "string" ? md.embeddingModel : "unknown",
  };
}
