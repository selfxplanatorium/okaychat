import assert from "node:assert/strict";
import { test } from "node:test";
import { UI_LOCALES } from "@shared/ui-locales";
import { loadChunk, SOURCE } from "./testing/catalog-rules.js";

// The error catalog and the allowance card must never describe the same state with different copy.
const PAIRS = [
  { credit: "exhausted", error: "tokenCreditExhaustedMessage" },
  { credit: "unknown", error: "tokenCreditUnknownMessage" },
  { credit: "busy", error: "tokenCreditBusyMessage" },
  { credit: "unmetered", error: "tokenCreditUnmeteredMessage" },
] as const;

test("every shipped locale translates the complete credits namespace", async () => {
  const keys = Object.keys(SOURCE.credits ?? {});
  for (const row of UI_LOCALES) {
    if (row.coverage === "source") continue;
    const entries = (await loadChunk(row.tag)).credits;
    for (const key of keys) {
      assert.ok(entries && Object.prototype.hasOwnProperty.call(entries, key), `${row.tag}: credits.${key} is missing`);
    }
  }
});

test("credit error copy matches the allowance copy in every shipped locale", async () => {
  for (const row of UI_LOCALES) {
    if (row.coverage === "source") {
      for (const { credit, error } of PAIRS) {
        assert.equal(SOURCE.credits?.[credit], SOURCE.errors?.[error], `en: ${credit}`);
      }
      continue;
    }
    const chunk = await loadChunk(row.tag);
    for (const { credit, error } of PAIRS) {
      assert.equal(chunk.credits?.[credit], chunk.errors?.[error], `${row.tag}: ${credit}`);
    }
  }
});
