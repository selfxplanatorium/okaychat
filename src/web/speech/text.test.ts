import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PIECE, splitForSpeech, spokenText } from "./text";

test("spokenText drops Markdown, code, links, tables, and math", () => {
  const md = "# Title\n\nSee **[the docs](https://x.dev/a)** and `code`.\n\n```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- item $x^2$\n<details>reasoning</details>";
  const out = spokenText(md);
  assert.equal(out, "Title\n\nSee the docs and code.\n\n(code omitted)\nitem (formula)");
});

test("sentence mode merges short sentences and splits long ones", () => {
  const pieces = splitForSpeech("Hi. Yes. This first sentence is long enough to stand alone here. And here is the second full sentence of the reply.", "sentence");
  assert.deepEqual(pieces, ["Hi. Yes. This first sentence is long enough to stand alone here.", "And here is the second full sentence of the reply."]);
});

test("paragraph and whole-reply modes", () => {
  assert.deepEqual(splitForSpeech("One. Two.\n\nThree.", "paragraph"), ["One. Two.", "Three."]);
  assert.deepEqual(splitForSpeech("One. Two.\n\nThree.", "none"), ["One. Two.\n\nThree."]);
});

test("no piece exceeds the per-request limit", () => {
  const long = Array.from({ length: 800 }, (_, i) => `word${i}`).join(" ");
  const pieces = splitForSpeech(long, "none");
  assert.ok(pieces.length > 1);
  assert.ok(pieces.every((p) => p.length <= MAX_PIECE));
  assert.equal(pieces.join(" "), long);
});
