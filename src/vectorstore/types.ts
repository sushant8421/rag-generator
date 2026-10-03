import type { Chunk, RetrievedChunk } from "../types.js";

export interface CollectionInfo {
  name: string;
  displayName: string;
  embeddingModel: string;
}

export interface DocumentInfo {
  documentId: string;
  filename: string;
  chunkCount: number;
  uploadedAt: string;
}

/** A collection holds one "section": a set of documents users can query together. */
export interface VectorStore {
  ping(): Promise<void>;
  listCollections(): Promise<CollectionInfo[]>;
  getCollection(name: string): Promise<CollectionInfo | undefined>;
  /** Creates the collection if missing; returns its info either way. */
  ensureCollection(info: CollectionInfo): Promise<CollectionInfo>;
  deleteCollection(name: string): Promise<void>;
  listDocuments(collection: string): Promise<DocumentInfo[]>;
  deleteDocument(collection: string, documentId: string): Promise<void>;
  upsert(collection: string, chunks: Chunk[], embeddings: number[][]): Promise<void>;
  query(collection: string, embedding: number[], topK: number): Promise<RetrievedChunk[]>;
}
