import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { ArchiveTooLargeError, assertZipBounds } from "./zip-bounds.js";

const bomb = () => Buffer.from(zipSync({ "word/document.xml": new Uint8Array(210 * 1024 * 1024) }, { level: 9 }));

test("archives that expand past the limit are refused before any parser sees them", () => {
  assert.throws(() => assertZipBounds(bomb()), ArchiveTooLargeError);
  // Headers that understate the size are caught by the streaming count.
  const lying = bomb();
  for (let i = 0; i < lying.length - 4; i++) {
    const signature = lying.readUInt32LE(i);
    if (signature === 0x02014b50) lying.writeUInt32LE(1, i + 24);
    if (signature === 0x04034b50) lying.writeUInt32LE(1, i + 22);
  }
  assert.throws(() => assertZipBounds(lying), ArchiveTooLargeError);
});

test("normal archives and non-archives pass through", () => {
  assert.doesNotThrow(() => assertZipBounds(zipSync({ "word/document.xml": strToU8("<w:document/>"), "a.txt": strToU8("x".repeat(1_000_000)) })));
  assert.doesNotThrow(() => assertZipBounds(strToU8("not a zip")));
});
