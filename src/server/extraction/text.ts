import { assertReadableText } from "./errors.js";

/** UTF-8 text with a real binary check; the dispatcher applies the character cap. */
export function extractPlainText(data: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(data).replace(/^﻿/, "");
  assertReadableText(text);
  return text;
}

export function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(data).replace(/^﻿/, "");
}
