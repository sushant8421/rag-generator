export interface Embedder {
  /** Identifies the model; stored on the collection so we never mix vector spaces. */
  readonly modelId: string;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
