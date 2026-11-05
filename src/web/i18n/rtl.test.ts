/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// RTL readiness ratchet. Logical properties (`ms-*`, `ps-*`, `start-*`, `text-start`) flip with `dir`,
// physical ones (`ml-*`, `left-*`, `text-left`) do not. Every new UI file joins this list.
const RTL_CHECKED_FILES = ["components/chat/MessageTranslation.tsx", "components/chat/TranslationDialog.tsx"];

const FORBIDDEN = [
  /\b(?:ml|mr|pl|pr)-/,
  /\b(?:left|right)-\d/,
  /text-left/,
  /text-right/,
  /border-l-/,
  /border-r-/,
  /rounded-l-/,
  /rounded-r-/,
  /space-x-/,
];

test("translation UI uses logical direction properties", () => {
  const webRoot = join(import.meta.dirname, "..");
  const offenders: string[] = [];
  for (const file of RTL_CHECKED_FILES) {
    const text = readFileSync(join(webRoot, file), "utf8");
    for (const pattern of FORBIDDEN) {
      const match = pattern.exec(text);
      if (match) offenders.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});
