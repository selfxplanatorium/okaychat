import { unzipSync } from "fflate";
import { ArchiveTooLargeError } from "../documents/zip-bounds.js";
import { ExtractionError, TOO_LARGE_PART } from "./errors.js";

export { ArchiveTooLargeError, assertZipBounds } from "../documents/zip-bounds.js";

// Selective ZIP reads. fflate inflates each selected entry into a buffer of its declared size, so a header that
// understates an entry cannot grow memory beyond the declared caps checked here. A stored entry is instead copied
// at its compressed size, which overlapping directory entries can each set to the whole file, so the caps use the
// larger of the two sizes.

const MAX_ENTRIES = 10_000;
export const DAMAGED_ZIP = "This file could not be opened. It may be damaged.";

interface ZipFile {
  name: string;
  size: number;
  originalSize: number;
}

/** The bytes fflate allocates for one selected entry. */
const allocated = (file: ZipFile) => Math.max(file.size, file.originalSize);

function unzip(data: Uint8Array, filter: (file: ZipFile) => boolean): Record<string, Uint8Array> {
  try {
    return unzipSync(data, { filter });
  } catch (error) {
    if (error instanceof ArchiveTooLargeError || error instanceof ExtractionError) throw error;
    throw new ExtractionError("damaged", DAMAGED_ZIP);
  }
}

/** Entry names from the central directory, without inflating anything. A directory over 10,000 entries is refused. */
export function zipEntryNames(data: Uint8Array): string[] {
  const names: string[] = [];
  unzip(data, (file) => {
    if (names.length >= MAX_ENTRIES) throw new ArchiveTooLargeError();
    names.push(file.name);
    return false;
  });
  return names;
}

/** One entry, or undefined when it is absent or declares more than `max` bytes. Never a partial entry. */
export function readZipEntry(data: Uint8Array, name: string, max: number): Uint8Array | undefined {
  let entries = 0;
  let found = false;
  const files = unzip(data, (file) => {
    if (++entries > MAX_ENTRIES) throw new ArchiveTooLargeError();
    // Only the first entry of that name, so repeated directory entries cannot allocate it again and again.
    if (found || file.name !== name || allocated(file) > max) return false;
    found = true;
    return true;
  });
  const entry = files[name];
  return entry && entry.byteLength <= max ? entry : undefined;
}

/** The entries `select` picks, each at most `perPart` bytes and `total` together. Call `assertZipBounds` first. */
export function inflateSelected(data: Uint8Array, select: (name: string) => boolean, perPart: number, total: number): Map<string, Uint8Array> {
  let selected = 0;
  let entries = 0;
  const files = unzip(data, (file) => {
    if (++entries > MAX_ENTRIES) throw new ArchiveTooLargeError();
    if (!select(file.name)) return false;
    const size = allocated(file);
    selected += size;
    if (size > perPart || selected > total) throw new ExtractionError("too_large", TOO_LARGE_PART);
    return true;
  });
  return new Map(Object.entries(files));
}
