/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSlashToken, slashTokenAt, slashTokenKey } from "./prompt-slash.js";

test("only `/` plus letters, digits, and hyphens is a token", () => {
  assert.deepEqual(parseSlashToken("/"), { query: "" });
  assert.deepEqual(parseSlashToken("/summarize"), { query: "summarize" });
  assert.deepEqual(parseSlashToken("/Release-2"), { query: "release-2" });
  for (const input of ["", "summarize", "/sum marize", "/sum/", "/sum\n", "/sum?", " /sum", "hello /sum"]) {
    assert.equal(parseSlashToken(input), null, JSON.stringify(input));
  }
});

test("a token needs the whole input and a collapsed selection at its end", () => {
  assert.deepEqual(slashTokenAt("/sum", 4, 4), { query: "sum" });
  assert.equal(slashTokenAt("/sum", 2, 2), null, "the caret is not at the end");
  assert.equal(slashTokenAt("/sum", 2, 4), null, "a selection is not a token");
  assert.equal(slashTokenAt("/sum", 4, 4, true), null, "an IME composition suppresses the menu");
  assert.equal(slashTokenAt("/sum", 4, 4, false)?.query, "sum");
});

test("the suppression key changes with the text or the caret", () => {
  assert.equal(slashTokenKey("/sum", 4), slashTokenKey("/sum", 4));
  assert.notEqual(slashTokenKey("/sum", 4), slashTokenKey("/sum", 3));
  assert.notEqual(slashTokenKey("/sum", 4), slashTokenKey("/summ", 5));
});
