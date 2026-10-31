import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkDocument, estimateTokens, excerpt, TARGET_TOKENS } from "./chunker.js";

const paragraph = (n: number) => `Paragraph ${n}. ${"The quick brown fox jumps over the lazy dog. ".repeat(18)}`;

function document(): string {
  const parts: string[] = ["# Handbook", "", paragraph(1), "", paragraph(2), ""];
  parts.push("# Architecture", "", "## Storage", "", paragraph(3), "");
  parts.push("```ts", ...Array.from({ length: 60 }, (_, i) => `export const value${i} = ${i} * 2; // a line of code`), "```", "");
  parts.push("| Name | Value |", "| --- | --- |", "| alpha | 1 |", "| beta | 2 |", "");
  parts.push("## Operations", "", paragraph(4), paragraph(5), "");
  return parts.join("\n");
}

test("chunks follow structure, keep offsets, and are deterministic", () => {
  const text = document();
  const first = chunkDocument(text, { sourceId: "src-1", title: "Handbook" });
  const second = chunkDocument(text, { sourceId: "src-1", title: "Handbook" });
  assert.deepEqual(first, second, "the same source and text produce the same chunks");
  assert.ok(first.length >= 2);
  for (const [index, chunk] of first.entries()) {
    assert.equal(chunk.ordinal, index);
    assert.ok(chunk.start >= 0 && chunk.end <= text.length);
    assert.ok(chunk.end > chunk.start);
    assert.equal(text.slice(chunk.start, chunk.end), chunk.text, "offsets slice the exact original text");
    assert.ok(chunk.title.length > 0);
    assert.ok(chunk.tokens > 0);
    assert.match(chunk.id, /^k_[a-f0-9]{24}$/);
  }
  assert.equal(new Set(first.map((chunk) => chunk.id)).size, first.length, "ids are unique");
});

test("normal prose chunks land near the token target with overlap", () => {
  const text = Array.from({ length: 12 }, (_, i) => paragraph(i + 1)).join("\n\n");
  const chunks = chunkDocument(text, { sourceId: "src-2" });
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks.slice(0, -1)) {
    assert.ok(chunk.tokens >= TARGET_TOKENS * 0.6, `chunk ${chunk.ordinal} is ${chunk.tokens} tokens`);
    assert.ok(chunk.tokens <= TARGET_TOKENS * 1.35, `chunk ${chunk.ordinal} is ${chunk.tokens} tokens`);
  }
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i]!.start < chunks[i - 1]!.end, "consecutive chunks overlap");
    assert.ok(chunks[i - 1]!.end - chunks[i]!.start <= chunks[i - 1]!.end - chunks[i - 1]!.start);
  }
});

test("a long code block is split without losing lines", () => {
  const code = Array.from({ length: 700 }, (_, i) => `const line${i} = ${i};`).join("\n");
  const text = `# Sample\n\n\`\`\`ts\n${code}\n\`\`\`\n`;
  const chunks = chunkDocument(text, { sourceId: "src-code" });
  assert.ok(chunks.length >= 2);
  assert.equal(chunks.map((chunk) => chunk.text).join("\n").includes("const line699 = 699"), true);
  for (const chunk of chunks) assert.ok(chunk.tokens <= TARGET_TOKENS * 1.35);
});

test("tables stay readable and a long single paragraph is split", () => {
  const rows = Array.from({ length: 300 }, (_, i) => `| row-${i} | value-${i} |`).join("\n");
  const table = chunkDocument(`# Table\n\n| Key | Value |\n| --- | --- |\n${rows}\n`, { sourceId: "src-table" });
  assert.ok(table.length >= 2);
  assert.ok(table.some((chunk) => chunk.text.includes("row-0")));

  const long = `# Long\n\n${"word ".repeat(9_000)}`;
  const split = chunkDocument(long, { sourceId: "src-long" });
  assert.ok(split.length >= 3);
  for (const chunk of split.slice(0, -1)) assert.ok(chunk.tokens <= TARGET_TOKENS * 1.35);
});

test("empty or whitespace-only text produces no chunks, and excerpts are bounded", () => {
  assert.deepEqual(chunkDocument("", { sourceId: "x" }), []);
  assert.deepEqual(chunkDocument("   \n\n \t", { sourceId: "x" }), []);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(excerpt("abcdef", 4), "abcd…");
});
