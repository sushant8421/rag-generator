import { extname } from "node:path";
import { getDocumentProxy } from "unpdf";
import { HttpError } from "../errors.js";
import { parserFor, supportedExtensions } from "../parsing/index.js";

export interface UploadLimits {
  maxPdfPages: number;
  maxPdfBytes: number;
  maxTextBytes: number;
}

/**
 * Cheap checks done synchronously at upload time, so oversized or unsupported
 * files are rejected immediately instead of failing later in the background job.
 */
export async function validateUpload(filename: string, buffer: Buffer, limits: UploadLimits): Promise<void> {
  if (!parserFor(filename)) {
    throw new HttpError(415, `Unsupported file type "${extname(filename) || filename}". Supported: ${supportedExtensions.join(", ")}`);
  }
  if (buffer.length === 0) throw new HttpError(400, "File is empty");

  if (extname(filename).toLowerCase() === ".pdf") {
    if (buffer.length > limits.maxPdfBytes) {
      throw new HttpError(413, `PDF is ${mb(buffer.length)}; the limit is ${mb(limits.maxPdfBytes)}`);
    }
    let pages: number;
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      pages = pdf.numPages;
    } catch {
      throw new HttpError(400, "Could not read PDF (corrupt or password-protected?)");
    }
    if (pages > limits.maxPdfPages) {
      throw new HttpError(413, `PDF has ${pages} pages; the limit is ${limits.maxPdfPages}`);
    }
    return;
  }

  if (buffer.length > limits.maxTextBytes) {
    throw new HttpError(
      413,
      `File is ${kb(buffer.length)}; the limit is ${kb(limits.maxTextBytes)} (~${limits.maxPdfPages} pages of text)`,
    );
  }
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const kb = (n: number) => `${Math.round(n / 1024)} KB`;
