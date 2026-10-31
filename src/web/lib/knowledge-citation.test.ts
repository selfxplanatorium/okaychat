import assert from "node:assert/strict";
import { test } from "node:test";
import { isKnowledgeHref, parseKnowledgeCitation } from "./knowledge-citation.js";

const id = `k_${"a1b2c3d4e5f60718293a4b5c"}`;

test("valid knowledge citations decode to their chunk id", () => {
  assert.equal(parseKnowledgeCitation(`oknowledge:${id}`), id);
  assert.equal(parseKnowledgeCitation(`OKNOWLEDGE:${encodeURIComponent(id)}`), id);
  assert.equal(parseKnowledgeCitation(`oknowledge:${id}?x=1#passage`), id);
  assert.equal(parseKnowledgeCitation(`oknowledge:%20${id}%20`), id);
});

test("malformed model text never throws and is not a citation", () => {
  for (const href of [
    undefined,
    null,
    "",
    "oknowledge:%ZZ",
    "oknowledge:%E0%A4%A",
    "oknowledge:",
    "oknowledge:k_not-hex",
    `oknowledge:k_${"A".repeat(24)}`,
    `oknowledge:k_${"a".repeat(23)}`,
    `oknowledge:k_${"a".repeat(25)}`,
    "https://example.com/oknowledge",
  ]) {
    assert.doesNotThrow(() => parseKnowledgeCitation(href));
    assert.equal(parseKnowledgeCitation(href), null);
  }
});

test("only the knowledge scheme is recognised, and malformed links are still inert", () => {
  assert.equal(isKnowledgeHref(`oknowledge:${id}`), true);
  assert.equal(isKnowledgeHref("oknowledge:%ZZ"), true, "the renderer must not create a normal link");
  assert.equal(isKnowledgeHref("https://example.com"), false);
  assert.equal(isKnowledgeHref(undefined), false);
});
