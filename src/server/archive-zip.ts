import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { crc32, inflateRawSync } from "node:zlib";

/**
 * Strict ZIP transport for room archives. This is deliberately not the loose personal-archive reader or
 * the document bounds helper: a room archive is untrusted third-party data, so the central directory,
 * every local header, the declared sizes, the CRC, and the byte ranges are all checked before one entry
 * is inflated. Inflate is capped per entry and in total, so a lying header cannot allocate its way out.
 *
 * The reader works on an in-memory upload (already capped at 64 MiB, streamed to disk by the route) and
 * inflates one entry at a time. The writer emits stored entries only; the importer accepts stored and
 * deflated entries.
 */

export class ZipFormatError extends Error {}

interface ZipEntry {
  name: string;
  method: 0 | 8;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  dataOffset: number;
  /** Exclusive end of this entry's compressed bytes. */
  dataEnd: number;
}

export interface ZipReadLimits {
  maxInputBytes: number;
  maxExpandedBytes: number;
  maxEntryBytes: number;
  maxEntries: number;
  /** Only these names may appear; anything else fails the whole archive. */
  allow: (name: string) => boolean;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
const MAX_NAME_BYTES = 512;

function fail(message: string): never {
  throw new ZipFormatError(message);
}

const u16 = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8);
const u32 = (bytes: Uint8Array, at: number) => (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;

/** UTF-8 names only, and no path escape: the archive never names a file on disk by itself. */
function checkName(raw: Uint8Array): string {
  if (!raw.byteLength || raw.byteLength > MAX_NAME_BYTES) fail("An entry name is empty or too long.");
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    fail("An entry name is not valid UTF-8.");
  }
  if (name.includes("\\")) fail("An entry name contains a backslash.");
  if (name.includes("\u0000")) fail("An entry name contains a NUL.");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) fail("An entry name is absolute.");
  if (name.endsWith("/")) fail("The archive contains a directory entry.");
  const parts = name.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) fail("An entry name escapes its folder.");
  return name;
}

function checkExternalAttributes(value: number): void {
  if (value & 0x10) fail("The archive contains a directory entry.");
  const mode = (value >>> 16) & 0xffff;
  if (!mode) return;
  const kind = mode & 0xf000;
  if (kind === 0xa000) fail("The archive contains a symbolic link.");
  if (kind !== 0 && kind !== 0x8000) fail("The archive contains a non-regular entry.");
}

/**
 * Parses and validates the whole container without inflating anything. Returns entries in central
 * directory order; callers decide which ones to read.
 */
export function inspectZip(bytes: Uint8Array, limits: ZipReadLimits): ZipEntry[] {
  if (!bytes.byteLength) fail("The archive is empty.");
  if (bytes.byteLength > limits.maxInputBytes) fail("The archive is too large.");

  // End of central directory, within the only place it can legally be (comment bytes are refused).
  if (bytes.byteLength < 22) fail("The file is not a complete ZIP archive.");
  let eocdAt = -1;
  for (let at = bytes.byteLength - 22; at >= 0 && at >= bytes.byteLength - 22 - 0xffff; at--) {
    if (u32(bytes, at) === EOCD) {
      eocdAt = at;
      break;
    }
    if (u32(bytes, at) === ZIP64_LOCATOR) fail("ZIP64 archives are not supported.");
  }
  if (eocdAt < 0) fail("The file is not a complete ZIP archive.");
  // No archive comment and no bytes after the end record: both are trailing-data smuggling vectors.
  if (u16(bytes, eocdAt + 20) !== 0 || eocdAt + 22 !== bytes.byteLength) fail("The archive has trailing data after its directory.");
  const disk = u16(bytes, eocdAt + 4);
  const centralDisk = u16(bytes, eocdAt + 6);
  const entriesOnDisk = u16(bytes, eocdAt + 8);
  const totalEntries = u16(bytes, eocdAt + 10);
  const centralSize = u32(bytes, eocdAt + 12);
  const centralOffset = u32(bytes, eocdAt + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) fail("Split or multi-disk archives are not supported.");
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail("ZIP64 archives are not supported.");
  if (totalEntries > limits.maxEntries) fail("The archive contains too many entries.");
  if (centralOffset < 0 || centralSize < 0 || centralOffset + centralSize !== eocdAt) fail("The archive directory is inconsistent or truncated.");

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let at = centralOffset;
  for (let index = 0; index < totalEntries; index++) {
    if (at + 46 > eocdAt || u32(bytes, at) !== CENTRAL) fail("The archive directory is malformed.");
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const crc = u32(bytes, at + 16);
    const compressedSize = u32(bytes, at + 20);
    const size = u32(bytes, at + 24);
    const nameLen = u16(bytes, at + 28);
    const extraLen = u16(bytes, at + 30);
    const commentLen = u16(bytes, at + 32);
    const diskStart = u16(bytes, at + 34);
    const externalAttributes = u32(bytes, at + 38);
    const localOffset = u32(bytes, at + 42);
    const next = at + 46 + nameLen + extraLen + commentLen;
    if (next > eocdAt) fail("The archive directory is truncated.");
    if (diskStart !== 0) fail("Split archives are not supported.");
    // Only the UTF-8 name flag may be set. Encryption, data descriptors, and masked headers are refused.
    if (flags & ~0x800) fail("The archive uses an unsupported ZIP flag.");
    if (method !== 0 && method !== 8) fail("The archive uses an unsupported compression method.");
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) fail("ZIP64 archives are not supported.");
    if (extraLen) {
      // The only ZIP64 tell that survives a 32-bit field check is the 0x0001 extra header.
      let extra = at + 46 + nameLen;
      const extraEnd = extra + extraLen;
      while (extra + 4 <= extraEnd) {
        const id = u16(bytes, extra);
        const length = u16(bytes, extra + 2);
        if (id === 0x0001) fail("ZIP64 archives are not supported.");
        extra += 4 + length;
      }
    }
    checkExternalAttributes(externalAttributes);
    const name = checkName(bytes.subarray(at + 46, at + 46 + nameLen));
    if (!limits.allow(name)) fail("The archive contains an unexpected entry.");
    if (names.has(name)) fail("The archive contains duplicate entries.");
    names.add(name);
    if (size > limits.maxEntryBytes) fail("An entry exceeds the per-file limit.");
    if (method === 0 && compressedSize !== size) fail("A stored entry's sizes disagree.");

    if (localOffset + 30 > centralOffset || u32(bytes, localOffset) !== LOCAL) fail("An entry's local header is malformed.");
    const localFlags = u16(bytes, localOffset + 6);
    const localMethod = u16(bytes, localOffset + 8);
    const localCrc = u32(bytes, localOffset + 14);
    const localCompressed = u32(bytes, localOffset + 18);
    const localSize = u32(bytes, localOffset + 22);
    const localNameLen = u16(bytes, localOffset + 26);
    const localExtraLen = u16(bytes, localOffset + 28);
    if (localFlags !== flags || localMethod !== method || localCrc !== crc || localCompressed !== compressedSize || localSize !== size) {
      fail("An entry's local header disagrees with the archive directory.");
    }
    const localName = checkName(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLen));
    if (localName !== name) fail("An entry's local name disagrees with the archive directory.");
    const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > centralOffset || dataEnd < dataOffset) fail("An entry's bytes run outside the archive.");
    entries.push({ name, method, flags, crc, compressedSize, size, localOffset, dataOffset, dataEnd });
    at = next;
  }
  if (at !== eocdAt) fail("The archive directory has trailing data.");

  // Overlapping entries are a classic confused-deputy trick; ranges must be disjoint and in order.
  const ordered = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  let previousEnd = 0;
  for (const entry of ordered) {
    if (entry.localOffset < previousEnd) fail("The archive entries overlap.");
    previousEnd = entry.dataEnd;
  }

  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total > limits.maxExpandedBytes) fail("The archive expands beyond the supported size.");
  return entries;
}

function inflateEntry(bytes: Uint8Array, entry: ZipEntry, limits: ZipReadLimits): Uint8Array {
  const compressed = bytes.subarray(entry.dataOffset, entry.dataEnd);
  let data: Uint8Array;
  if (entry.method === 0) {
    data = compressed;
  } else {
    try {
      data = inflateRawSync(compressed, { maxOutputLength: Math.min(entry.size, limits.maxEntryBytes) || 1 });
    } catch {
      fail("An archive entry could not be decompressed.");
    }
  }
  if (data.byteLength !== entry.size) fail("An entry's declared size does not match its bytes.");
  if (data.byteLength > limits.maxEntryBytes) fail("An entry exceeds the per-file limit.");
  if ((crc32(data) >>> 0) !== entry.crc) fail("An entry failed its integrity check.");
  return new Uint8Array(data);
}

/** Reads one already-validated entry. Used so the importer never holds every expanded asset at once. */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry, limits: ZipReadLimits): Uint8Array {
  return inflateEntry(bytes, entry, limits);
}

/** Convenience for tests and the manifest: expands every entry in a validated container. */
export function readZipAll(bytes: Uint8Array, limits: ZipReadLimits): Map<string, Uint8Array> {
  const entries = inspectZip(bytes, limits);
  const out = new Map<string, Uint8Array>();
  let total = 0;
  for (const entry of entries) {
    const data = inflateEntry(bytes, entry, limits);
    total += data.byteLength;
    if (total > limits.maxExpandedBytes) fail("The archive expands beyond the supported size.");
    out.set(entry.name, data);
  }
  return out;
}

export function readZipFile(file: string, limits: ZipReadLimits): Uint8Array {
  const size = statSync(file, { bigint: false }).size;
  if (size > limits.maxInputBytes) fail("The archive is too large.");
  return new Uint8Array(readFileSync(file));
}

export interface ZipWriteEntry {
  name: string;
  bytes: Uint8Array;
}

/**
 * Stored-format ZIP writer. Names are supplied by the caller from server-generated hashes only, and
 * are checked again here so a future caller cannot smuggle a path through.
 */
export function writeStoredZip(files: ZipWriteEntry[], mtime = new Date()): Uint8Array {
  if (!files.length) throw new ZipFormatError("An archive needs at least one entry.");
  const seen = new Set<string>();
  const localParts: Uint8Array[] = [];
  let localSize = 0;
  const central: Array<{ name: Uint8Array; crc: number; size: number; offset: number }> = [];
  const date = dosDateTime(mtime);
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    checkName(name);
    if (seen.has(file.name)) throw new ZipFormatError("Duplicate archive entry.");
    seen.add(file.name);
    if (file.bytes.byteLength > 0xffffffff) throw new ZipFormatError("An entry is too large.");
    const crc = crc32(file.bytes) >>> 0;
    const local = new Uint8Array(30 + name.byteLength);
    const view = new DataView(local.buffer);
    view.setUint32(0, LOCAL, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x800, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, date.time, true);
    view.setUint16(12, date.day, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, file.bytes.byteLength, true);
    view.setUint32(22, file.bytes.byteLength, true);
    view.setUint16(26, name.byteLength, true);
    view.setUint16(28, 0, true);
    local.set(name, 30);
    central.push({ name, crc, size: file.bytes.byteLength, offset: localSize });
    localParts.push(local, file.bytes);
    localSize += local.byteLength + file.bytes.byteLength;
  }
  const centralSize = central.reduce((sum, entry) => sum + 46 + entry.name.byteLength, 0);
  if (localSize + centralSize + 22 > 0xffffffff) throw new ZipFormatError("The archive is too large.");
  const out = new Uint8Array(localSize + centralSize + 22);
  let at = 0;
  for (const part of localParts) {
    out.set(part, at);
    at += part.byteLength;
  }
  const centralStart = at;
  for (const entry of central) {
    const view = new DataView(out.buffer, at);
    view.setUint32(0, CENTRAL, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x800, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, date.time, true);
    view.setUint16(14, date.day, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.size, true);
    view.setUint32(24, entry.size, true);
    view.setUint16(28, entry.name.byteLength, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0o100644 << 16, true);
    view.setUint32(42, entry.offset, true);
    out.set(entry.name, at + 46);
    at += 46 + entry.name.byteLength;
  }
  const end = new DataView(out.buffer, at);
  end.setUint32(0, EOCD, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, central.length, true);
  end.setUint16(10, central.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true);
  return out;
}

function dosDateTime(mtime: Date): { time: number; day: number } {
  const year = Math.max(1980, Math.min(2107, mtime.getUTCFullYear()));
  return {
    time: (mtime.getUTCHours() << 11) | (mtime.getUTCMinutes() << 5) | Math.floor(mtime.getUTCSeconds() / 2),
    day: ((year - 1980) << 9) | ((mtime.getUTCMonth() + 1) << 5) | mtime.getUTCDate(),
  };
}

export const zipAssetName = (hash: string): string => `assets/${hash}`;
export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
