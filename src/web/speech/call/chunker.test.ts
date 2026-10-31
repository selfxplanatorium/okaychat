/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CHUNK, SentenceChunker } from "./chunker";

test("a sentence is not emitted before the space after its punctuation arrives", () => {
  const chunker = new SentenceChunker();
  assert.deepEqual(chunker.push("Hello wor"), []);
  assert.deepEqual(chunker.push("ld."), []);
  // The reply may still be "3.14"; the next delta settles it.
  assert.deepEqual(chunker.push(" This"), ["Hello world."]);
  assert.deepEqual(chunker.push(" is the second sentence."), []);
  assert.deepEqual(chunker.flush(), ["This is the second sentence."]);
});

test("several sentences in one delta are emitted in order", () => {
  const chunker = new SentenceChunker();
  assert.deepEqual(chunker.push("One. Two! Three? "), ["One.", "Two!", "Three?"]);
  assert.deepEqual(chunker.push("Four"), []);
  assert.deepEqual(chunker.flush(), ["Four"]);
});

test("a paragraph break ends a sentence even without punctuation", () => {
  const chunker = new SentenceChunker();
  assert.deepEqual(chunker.push("A heading\n\nAnd the body"), ["A heading"]);
  assert.deepEqual(chunker.flush(), ["And the body"]);
});

test("Markdown is removed sentence by sentence, including a fenced code block's notice", () => {
  const chunker = new SentenceChunker();
  const out = chunker.push("Try **this**.\n\n```js\nconst value = 1;\n```\n\nThen stop. ");
  assert.equal(out[0], "Try this.");
  // The code block is one chunk that says something was omitted; it never splits inside the fence.
  assert.equal(out.slice(1).join(" ").includes("const value"), false);
  assert.equal(out.slice(1).join(" ").includes("code omitted"), true);
});

test("a long unpunctuated stream is cut at a word boundary below the hard cap", () => {
  const chunker = new SentenceChunker();
  const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const out = chunker.push(text);
  assert.ok(out.length >= 1);
  assert.ok(out.every((piece) => piece.length <= MAX_CHUNK));
  const all = [...out, ...chunker.flush()].join(" ");
  assert.equal(all.split(/\s+/).length, 200);
  assert.equal(all.split(/\s+/)[0], "word0");
});

test("reset forgets the pending text for a new reply", () => {
  const chunker = new SentenceChunker();
  chunker.push("unfinished");
  chunker.reset();
  assert.equal(chunker.pending, "");
  assert.deepEqual(chunker.flush(), []);
});
