/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { SOURCE_LOCALE, UI_LOCALES, uiLocaleRow, type UiLocaleRow } from "@shared/ui-locales";
import { compareText, formatLanguageName, formatNativeLanguageName } from "./format.js";
import { applyLocale, matchLocale, SOURCE_LOCALE as INDEX_SOURCE, textDirection, type Translation } from "./index.js";
import { registryLoaders } from "./locale-registry.js";
import { catalogProblems, chunkTags, LEGACY_TAGS, loadChunk, requiredKeys, rowProblems } from "./testing/catalog-rules.js";

afterEach(() => applyLocale("en", {}));

const rows: readonly UiLocaleRow[] = UI_LOCALES;

test("registry rows are canonical, unique, and English is the single first source row", () => {
  const tags = rows.map((row) => row.tag);
  for (const tag of tags) assert.equal(Intl.getCanonicalLocales(tag)[0], tag, `${tag} is canonical`);
  assert.equal(new Set(tags.map((tag) => tag.toLowerCase())).size, tags.length, "tags are unique");
  const names = rows.map((row) => row.nativeName);
  for (const name of names) assert.ok(name.trim() !== "" && name === name.trim());
  assert.equal(new Set(names).size, names.length, "names are unique");
  assert.equal(rows[0]!.tag, SOURCE_LOCALE);
  assert.equal(INDEX_SOURCE, SOURCE_LOCALE);
  assert.deepEqual(rows.filter((row) => row.coverage === "source").map((row) => row.tag), ["en"]);
  for (const row of rows) {
    assert.ok(row.direction === "ltr" || row.direction === "rtl");
    assert.equal(textDirection(row.tag), row.direction, row.tag);
    assert.ok(["source", "legacy", "wave"].includes(row.coverage));
    // Only German and Spanish are grandfathered with partial feature coverage; every other row is full wave.
    if (row.coverage === "legacy") assert.ok((LEGACY_TAGS as readonly string[]).includes(row.tag), row.tag);
    if (row.tag !== SOURCE_LOCALE && !(LEGACY_TAGS as readonly string[]).includes(row.tag)) assert.equal(row.coverage, "wave", row.tag);
  }
  assert.equal(uiLocaleRow("PT-pt")?.tag, "pt-PT");
  assert.equal(uiLocaleRow("pt"), undefined);
});

test("the release ships English, German, Spanish, French, Italian, and European Portuguese", () => {
  const tags = rows.map((row) => row.tag);
  for (const tag of ["en", "de", "es", "fr", "it", "pt-PT"]) assert.ok(tags.includes(tag), tag);
});

test("chunk files and registry rows are a bijection, and every chunk validates", async () => {
  const registered = rows.filter((row) => row.tag !== SOURCE_LOCALE).map((row) => row.tag).sort();
  const files = chunkTags();
  assert.deepEqual(files, registered);
  assert.ok(!files.includes(SOURCE_LOCALE), "English has no chunk");
  for (const row of rows.filter((r) => r.tag !== SOURCE_LOCALE)) assert.deepEqual(rowProblems(row, await loadChunk(row.tag)), [], row.tag);
});

test("translation chunks are explicit catalogs that never import or spread other catalogs", () => {
  for (const tag of chunkTags()) {
    const text = readFileSync(join(import.meta.dirname, "locales", `${tag}.ts`), "utf8");
    const imports = [...text.matchAll(/^import .*$/gm)].map((match) => match[0]);
    assert.deepEqual(imports, ['import type { Translation } from "../index";'], tag);
    assert.doesNotMatch(text, /\.\.\.\w|\bt\(/, `${tag} spreads or calls t()`);
    assert.match(text, new RegExp(String.raw`const \w+: Translation = \{`), `${tag} annotates Translation`);
  }
});

test("the runtime loader maps the lazy glob through the registry", () => {
  const source = readFileSync(join(import.meta.dirname, "locales.ts"), "utf8");
  assert.match(source, /import\.meta\.glob<\{ default: Translation \}>\("\.\/locales\/\*\.ts"\)/);
  assert.doesNotMatch(source, /eager/);
  assert.match(source, /registryLoaders\(modules\)/);
});

test("registryLoaders keeps registry order, never loads a chunk, and rejects missing or extra files", () => {
  let loaded = 0;
  const loader = async () => {
    loaded++;
    return { default: {} as Translation };
  };
  const synthetic: UiLocaleRow[] = [
    { tag: "en", nativeName: "English", direction: "ltr", coverage: "source" },
    { tag: "nl", nativeName: "Nederlands", direction: "ltr", coverage: "wave" },
    { tag: "ca", nativeName: "Català", direction: "ltr", coverage: "wave" },
  ];
  const map = registryLoaders({ "./locales/ca.ts": loader, "./locales/nl.ts": loader }, synthetic);
  assert.deepEqual(Object.keys(map), ["nl", "ca"]);
  assert.equal(loaded, 0);
  assert.throws(() => registryLoaders({ "./locales/nl.ts": loader }, synthetic), /ca is registered but locales\/ca\.ts is missing/);
  assert.throws(() => registryLoaders({ "./locales/nl.ts": loader, "./locales/ca.ts": loader, "./locales/xx.ts": loader }, synthetic), /locales\/xx\.ts has no row/);
  // The production registry against a glob of the files on disk.
  const disk = Object.fromEntries(chunkTags().map((tag) => [`./locales/${tag}.ts`, loader]));
  assert.deepEqual(Object.keys(registryLoaders(disk)), rows.filter((row) => row.tag !== SOURCE_LOCALE).map((row) => row.tag));
  assert.equal(loaded, 0);
});

test("a newly registered language is picked up by matching, coverage, and the picker without other changes", () => {
  const added: UiLocaleRow = { tag: "nl", nativeName: "Nederlands", direction: "ltr", coverage: "wave" };
  const synthetic = [...rows, added];
  const loader = async () => ({ default: {} as Translation });
  const map = registryLoaders({ ...Object.fromEntries(chunkTags().map((tag) => [`./locales/${tag}.ts`, loader])), "./locales/nl.ts": loader }, synthetic);
  assert.equal(Object.keys(map).at(-1), "nl");
  assert.equal(matchLocale(["nl-BE"], [SOURCE_LOCALE, ...Object.keys(map)]), "nl");
  // The wave policy applies by default: a partial catalog fails coverage.
  const partial = { common: { add: "Toevoegen" } };
  const problems = catalogProblems(added.tag, partial, { required: requiredKeys(added.coverage), allCategories: true });
  assert.ok(problems.includes("nl: common.back is missing"));
  assert.ok(problems.includes("nl: evaluations.title is missing") || problems.some((p) => p.startsWith("nl: evaluations.")));
  // Unregistered tags still get an autonym from Intl, in their own language.
  assert.equal(formatNativeLanguageName("nl"), new Intl.DisplayNames(["nl"], { type: "language" }).of("nl"));
});

test("autonyms are the reviewed registry names in every UI language; localized names stay localized", async () => {
  for (const active of rows) {
    applyLocale(active.tag, active.tag === SOURCE_LOCALE ? {} : await loadChunk(active.tag));
    for (const row of rows) assert.equal(formatNativeLanguageName(row.tag), row.nativeName, `${row.tag} under ${active.tag}`);
    const sorted = rows.map((row) => row.nativeName).sort(compareText);
    assert.equal(sorted.length, rows.length);
  }
  assert.equal(formatNativeLanguageName("pt-PT"), "Português (Portugal)");
  // The autonym lookup must not leak into the per-language display-name cache.
  applyLocale("de", {});
  assert.equal(formatLanguageName("es"), "Spanisch");
  assert.equal(formatNativeLanguageName("es"), "Español");
  assert.equal(formatLanguageName("es"), "Spanisch");
  applyLocale("fr", {});
  assert.equal(formatLanguageName("de"), new Intl.DisplayNames(["fr"], { type: "language" }).of("de"));
  // A malformed tag still labels its option.
  assert.equal(formatNativeLanguageName("x_y"), "x_y");
});
