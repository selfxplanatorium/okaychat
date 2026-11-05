import { ExtractionError } from "./errors.js";
import type { PartResult } from "./index.js";
import { assertZipBounds } from "./zip.js";

export async function extractDocx(data: Uint8Array): Promise<PartResult> {
  assertZipBounds(data);
  const { default: mammoth } = await import("mammoth");
  try {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    return { text: value };
  } catch {
    throw new ExtractionError("damaged", "Could not open this Word document. It may be damaged.");
  }
}
