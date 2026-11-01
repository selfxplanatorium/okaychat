// Raster detection from the bytes themselves. A browser's or provider's declared type is never trusted:
// it decides only whether a file is offered as an image, never how it is decoded or served.

export type RasterMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/avif";

export const RASTER_EXTENSION: Record<RasterMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

/** Detect a raster format from magic bytes. SVG and everything else return null and are never decoded. */
export function sniffRaster(buf: Uint8Array): RasterMime | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 6 && b.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  // ISO-BMFF: `ftyp` box at offset 4 with an AVIF brand. HEIC is not offered (browsers cannot show it).
  if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp" && /^avi[fs]$/.test(b.toString("latin1", 8, 12))) return "image/avif";
  return null;
}

/**
 * Header dimensions, without decoding. Only metadata for layout and early pixel bounds: a header can lie, so
 * every decode still goes through sharp's own pixel limit.
 */
export function headerDimensions(buf: Uint8Array, mime: RasterMime): { width: number; height: number } | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  try {
    switch (mime) {
      case "image/png":
        return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
      case "image/gif":
        return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
      case "image/webp": {
        const chunk = b.toString("latin1", 12, 16);
        if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
        if (chunk === "VP8L") {
          const bits = b.readUInt32LE(21);
          return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
        }
        return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      }
      case "image/jpeg": {
        let i = 2;
        while (i + 9 < b.length) {
          if (b[i] !== 0xff) return null;
          const marker = b[i + 1]!;
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
          i += 2 + b.readUInt16BE(i + 2);
        }
        return null;
      }
      case "image/avif":
        // `ispe` box: version/flags (4 bytes), then width and height.
        for (let i = b.indexOf("ispe", 0, "latin1"); i !== -1 && i + 16 <= b.length; i = b.indexOf("ispe", i + 4, "latin1")) {
          return { width: b.readUInt32BE(i + 8), height: b.readUInt32BE(i + 12) };
        }
        return null;
    }
  } catch {
    return null;
  }
}
