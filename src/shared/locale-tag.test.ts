import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalLocaleTag, MAX_LOCALE_TAG } from "./locale-tag.js";
import { UI_LOCALES } from "./ui-locales.js";

test("mixed-case tags canonicalize, including the shipped regional tag", () => {
  for (const [input, canonical] of [
    ["FR-fr", "fr-FR"], ["IT-it", "it-IT"], ["pt-pt", "pt-PT"], ["PT-br", "pt-BR"], ["fr-ca", "fr-CA"], ["DE", "de"], ["zh-hant-tw", "zh-Hant-TW"],
  ] as const) assert.equal(canonicalLocaleTag(input), canonical, input);
  for (const row of UI_LOCALES) assert.equal(canonicalLocaleTag(row.tag), row.tag);
});

test("valid tags outside the shipped UI languages are accepted", () => {
  for (const tag of ["pt", "pt-BR", "nl", "ja-JP", "zz"]) assert.equal(canonicalLocaleTag(tag), tag);
});

test("malformed and over-length tags are rejected", () => {
  for (const tag of ["pt_PT", "f", "fr-", "-fr", "fr--FR", "de-1996-1996", "", `en-${"a".repeat(MAX_LOCALE_TAG)}`]) {
    assert.equal(canonicalLocaleTag(tag), null, tag);
  }
});
