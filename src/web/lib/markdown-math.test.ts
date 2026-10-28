/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { keepLineBreaks, preprocessMarkdown } from "./markdown-math.js";

test("one-line display math becomes a $$ fence", () => {
  assert.equal(preprocessMarkdown("\\[ \\frac{1}{2} \\]"), "$$\n\\frac{1}{2}\n$$");
  assert.equal(preprocessMarkdown("$$x^2$$"), "$$\nx^2\n$$");
});

test("inline math, prices, and code fences are left alone", () => {
  assert.equal(preprocessMarkdown("a $$x$$ b"), "a $$x$$ b");
  assert.equal(preprocessMarkdown("$5 and $10"), "\\$5 and \\$10");
  const code = "```\n$$x$$\n```";
  assert.equal(preprocessMarkdown(code), code);
});

test("typed line breaks become hard breaks outside code and display math", () => {
  assert.equal(keepLineBreaks("one\ntwo\n\nthree"), "one  \ntwo\n\nthree");
  assert.equal(keepLineBreaks("```\na\nb\n```"), "```\na\nb\n```");
  assert.equal(keepLineBreaks("$$\nx\ny\n$$"), "$$\nx\ny\n$$");
});
