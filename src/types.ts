// Shared data shapes that flow between pipeline stages.

/** Plain text extracted from an uploaded file. */
export interface ParsedDocument {
  documentId: string;
  filename: string;
  text: string;
}

/** A piece of a document, ready to be embedded and stored. */
export interface Chunk {
  id: string; // `${documentId}:${index}`
  documentId: string;
  filename: string;
  index: number;
  /** Heading breadcrumb the chunk sits under, e.g. "Wisetap > 3. Core Flows". Empty for unstructured text. */
  heading: string;
  /** Text that is embedded and shown to the LLM (heading breadcrumb + body). */
  text: string;
  uploadedAt: string; // ISO timestamp
}

/** A chunk returned by retrieval, with its cosine distance (lower = closer). */
export interface RetrievedChunk extends Chunk {
  section: string;
  distance: number;
}

export interface Source {
  n: number; // citation number used in the answer, [n]
  section: string;
  filename: string;
  heading: string;
  snippet: string;
  distance: number;
  cited: boolean;
}

export interface Routing {
  /** auto = the server picked the section(s); manual = the user picked them. */
  mode: "auto" | "manual";
  /** Every searched section with its closest-chunk distance; `selected` ones were used for the answer. */
  sections: Array<{ name: string; displayName: string; bestDistance: number; selected: boolean }>;
}

export interface Answer {
  answer: string;
  sources: Source[];
  routing: Routing;
}
