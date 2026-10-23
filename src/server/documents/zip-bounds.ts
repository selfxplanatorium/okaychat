import { Unzip, UnzipInflate, unzipSync } from "fflate";
import { HTTPException } from "hono/http-exception";

// DOCX and XLSX are ZIP archives. A small upload can expand to gigabytes inside mammoth, exceljs, or
// fflate, so every archive is measured before a parser sees it.
const MAX_EXPANDED_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

/** An HTTPException, so routes answer 413 with this message and tools hand it to the model. */
export class ArchiveTooLargeError extends HTTPException {
  constructor() {
    super(413, { message: `This file expands to more than ${MAX_EXPANDED_BYTES / 1024 / 1024} MB or ${MAX_ENTRIES.toLocaleString("en-US")} parts, so it was not opened.` });
  }
}

/**
 * Throws unless the archive stays within the expansion limits. The central directory sizes catch
 * overlapping-entry bombs, which parsers read through the directory; the streaming pass counts what the
 * entries really inflate to, in case a header understates it. Nothing is kept.
 */
export function assertZipBounds(data: Uint8Array): void {
  let declared = 0;
  let entries = 0;
  try {
    unzipSync(data, {
      filter: (file) => {
        declared += file.originalSize;
        if (++entries > MAX_ENTRIES || declared > MAX_EXPANDED_BYTES) throw new ArchiveTooLargeError();
        return false;
      },
    });
  } catch (error) {
    if (error instanceof ArchiveTooLargeError) throw error;
    // Not a readable ZIP. The parser reports that in its own words.
    return;
  }
  let actual = 0;
  let exceeded = false;
  // fflate swallows exceptions thrown in ondata, so the limit is a flag and the entry is stopped early.
  const unzip = new Unzip((file) => {
    file.ondata = (error, chunk) => {
      if (error || exceeded) return;
      actual += chunk.length;
      if (actual > MAX_EXPANDED_BYTES) {
        exceeded = true;
        file.terminate();
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    unzip.push(data, true);
  } catch {
    // A malformed archive is the parser's to report.
  }
  if (exceeded) throw new ArchiveTooLargeError();
}
