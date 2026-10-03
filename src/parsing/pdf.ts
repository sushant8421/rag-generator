import { extractText } from "unpdf";
import type { DocumentParser } from "./types.js";

export const pdfParser: DocumentParser = {
  extensions: [".pdf"],
  async parse(buffer) {
    const { text } = await extractText(new Uint8Array(buffer), { mergePages: true });
    return text;
  },
};
