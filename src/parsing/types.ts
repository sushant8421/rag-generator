/** Turns raw file bytes into plain text. One implementation per file type. */
export interface DocumentParser {
  /** File extensions this parser handles, lowercase with dot, e.g. [".pdf"]. */
  readonly extensions: string[];
  parse(buffer: Buffer): Promise<string>;
}
