import type { DocumentParser } from "./types.js";

export const textParser: DocumentParser = {
  extensions: [".md", ".markdown", ".txt"],
  async parse(buffer) {
    return buffer.toString("utf8").replace(/^﻿/, ""); // strip BOM
  },
};
