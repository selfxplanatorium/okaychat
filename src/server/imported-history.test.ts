import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "ai";
import { importedHistoryText } from "./compaction.js";

const message = (parts: UIMessage["parts"]): UIMessage => ({ id: "m1", role: "assistant", parts });

test("an imported tool record becomes deterministic untrusted text, never a tool call", () => {
  const source = message([
    { type: "text", text: "Before" },
    { type: "data-imported-tool", data: { name: "email_send", state: "completed", input: { to: "a@example.test" }, output: { ok: true } } } as never,
  ]);
  const [converted] = importedHistoryText([source]);
  assert.equal(converted!.parts.length, 2);
  const text = converted!.parts[1] as { type: string; text: string };
  assert.equal(text.type, "text");
  assert.match(text.text, /<untrusted|Third-party DATA|untrusted/i);
  assert.match(text.text, /email_send/);
  // No executable shape survives.
  assert.equal(converted!.parts.some((part) => part.type.startsWith("tool-")), false);
});

test("ordinary text and other messages pass through unchanged", () => {
  const source = message([{ type: "text", text: "hello" }]);
  assert.equal(importedHistoryText([source])[0], source);
});
