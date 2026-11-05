/// <reference types="node" />
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { en } from "./en/index.js";
import { formatBytes, formatCost, formatDate, formatDuration, formatLanguageName, formatList, formatNumber, formatTokens } from "./format.js";
import { applyLocale, matchLocale, t, textDirection, type Translation } from "./index.js";

afterEach(() => applyLocale("en", {}));

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
const texts = (value: unknown): string[] => (typeof value === "string" ? [value] : Object.values(value as Record<string, string>));

test("t fills placeholders, formats numbers, and picks plural forms", () => {
  assert.equal(t("common.cancel"), "Cancel");
  assert.equal(t("composer.deleteChatBody", { title: "Plans" }).startsWith("“Plans”"), true);
  assert.equal(t("composer.deleteChatsTitle", { count: 1 }), "Delete 1 chat permanently?");
  assert.equal(t("composer.deleteChatsTitle", { count: 1200 }), "Delete 1,200 chats permanently?");
});

test("a translation overrides English and falls back to it per key", () => {
  const de: Translation = { common: { cancel: "Abbrechen" }, composer: { deleteChatsTitle: { one: "{count} Chat löschen?", other: "{count} Chats löschen?" } } };
  applyLocale("de", de);
  assert.equal(t("common.cancel"), "Abbrechen");
  assert.equal(t("common.save"), "Save");
  assert.equal(t("composer.deleteChatsTitle", { count: 1200 }), "1.200 Chats löschen?");
});

test("English fallback keeps English plural rules while translated entries use the active language", () => {
  applyLocale("ja", {});
  assert.equal(t("composer.deleteChatsTitle", { count: 1 }), "Delete 1 chat permanently?");
  applyLocale("ru", { composer: { deleteChatsTitle: { one: "{count} чат", few: "{count} чата", other: "{count} чатов" } } });
  assert.equal(t("composer.deleteChatsTitle", { count: 21 }), "21 чат");
  assert.equal(t("composer.deleteChatsTitle", { count: 2 }), "2 чата");
  applyLocale("ru", {});
  assert.equal(t("composer.deleteChatsTitle", { count: 21 }), "Delete 21 chats permanently?");
});

test("locale matching prefers exact tags, then the language", () => {
  assert.equal(matchLocale(["pt-BR", "en"], ["en", "pt-PT"]), "pt-PT");
  assert.equal(matchLocale(["de-AT"], ["en", "de"]), "de");
  assert.equal(matchLocale(["ja"], ["en", "de"]), "en");
  assert.equal(textDirection("ar-EG"), "rtl");
  assert.equal(textDirection("de"), "ltr");
});

test("formatters follow the locale", () => {
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatTokens(41_200), "41k");
  assert.equal(formatCost(0.004), "$0.0040");
  assert.equal(formatDuration(185), "3m 5s");
  assert.equal(formatList(["a", "b", "c"]), "a, b, and c");
  applyLocale("de", {});
  assert.equal(formatBytes(1536), "1,5 KB");
});

test("catalog entries are text or plural forms with `other`, with plain keys", () => {
  for (const [ns, entries] of Object.entries(en)) {
    assert.match(ns, /^\w+$/);
    for (const [key, value] of Object.entries(entries)) {
      assert.match(key, /^\w+$/, `${ns}.${key}`);
      if (typeof value === "string") continue;
      assert.equal(typeof (value as Record<string, unknown>).other, "string", `${ns}.${key} needs an "other" form`);
      for (const [rule, form] of Object.entries(value as Record<string, unknown>)) {
        assert.ok(["zero", "one", "two", "few", "many", "other"].includes(rule), `${ns}.${key}.${rule}`);
        assert.equal(typeof form, "string");
      }
    }
  }
});

const webRoot = join(import.meta.dirname, "..");
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (path !== import.meta.dirname) sources(path, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

test("every key is used literally somewhere in the web code", () => {
  // Literal keys keep the catalog searchable and let unused text be found; dynamic keys hide both.
  const code = sources(webRoot).map((path) => readFileSync(path, "utf8")).join("\n") + readFileSync(join(import.meta.dirname, "format.ts"), "utf8");
  const unused = Object.entries(en).flatMap(([ns, entries]) => Object.keys(entries).map((key) => `${ns}.${key}`)).filter((key) => !code.includes(`"${key}"`));
  assert.deepEqual(unused, []);
});

test("translations only use English keys and placeholders", async () => {
  const dir = join(import.meta.dirname, "locales");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
    const translation = ((await import(join(dir, file))) as { default: Translation }).default;
    for (const [ns, entries] of Object.entries(translation)) {
      const source = (en as Record<string, Record<string, unknown>>)[ns];
      assert.ok(source, `${file}: unknown namespace ${ns}`);
      for (const [key, value] of Object.entries(entries ?? {})) {
        assert.ok(key in source, `${file}: unknown key ${ns}.${key}`);
        const allowed: Set<string> = new Set(texts(source[key]).flatMap(placeholders));
        for (const text of texts(value)) for (const name of placeholders(text)) assert.ok(allowed.has(name), `${file}: ${ns}.${key} uses {${name}}`);
      }
    }
  }
});

/** The namespaces every shipped locale must translate completely; the rest fall back to English per key. */
const LOCALE_COVERAGE_REQUIRED = [
  "common", "shell", "auth", "sidebar", "composer", "thread", "messageDetails", "generation", "annotations",
  "translation", "settings", "general", "account", "usage", "format", "errors", "services", "tags",
] as const;

test("every literal t() key exists in the English catalog", () => {
  // The unused-key test catches text nobody shows; this catches text somebody shows but nobody wrote.
  const code = sources(webRoot).map((path) => readFileSync(path, "utf8")).join("\n");
  // A bare `t(` also matches `commandTarget(` and `useShortcut(`, which take command ids: require a
  // non-identifier character before it, and a standalone `k=` so `data-command=` cannot slip in.
  const patterns = [
    /(?:^|[^\w$])t\("([a-z][A-Za-z0-9]*\.[A-Za-z0-9]+)"/g,
    /(?:^|[^\w-])k="([a-z][A-Za-z0-9]*\.[A-Za-z0-9]+)"/g,
    /labelKey:\s*"([a-z][A-Za-z0-9]*\.[A-Za-z0-9]+)"/g,
  ];
  const keys = new Set(patterns.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[1]!)));
  const catalog = en as Record<string, Record<string, unknown>>;
  const missing = [...keys].filter((key) => {
    const dot = key.indexOf(".");
    const ns = key.slice(0, dot);
    return !(ns in catalog) || !(key.slice(dot + 1) in catalog[ns]!);
  });
  assert.deepEqual(missing, []);
});

test("shipped locales are complete for the required namespaces and use their own plurals", async () => {
  const dir = join(import.meta.dirname, "locales");
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length >= 2, "German and Spanish ship");
  const catalog = en as Record<string, Record<string, unknown>>;
  for (const file of files) {
    const tag = file.replace(/\.ts$/, "");
    const translation = ((await import(join(dir, file))) as { default: Translation }).default as Record<string, Record<string, unknown>>;
    const categories = new Set(new Intl.PluralRules(tag).resolvedOptions().pluralCategories);
    assert.equal(textDirection(tag), "ltr");
    for (const ns of LOCALE_COVERAGE_REQUIRED) {
      const source = catalog[ns]!;
      const entries = translation[ns];
      for (const key of Object.keys(source)) assert.ok(entries && key in entries, `${file}: ${ns}.${key} is missing`);
      for (const [key, value] of Object.entries(entries ?? {})) {
        const english = source[key];
        assert.ok(english !== undefined, `${file}: unknown key ${ns}.${key}`);
        const textsOfEntry = texts(value);
        const allowed = new Set(texts(english).flatMap(placeholders));
        const required = new Set(texts(english).flatMap(placeholders).filter((name) => name !== "count"));
        if (typeof value !== "string") {
          const forms = value as Record<string, string>;
          assert.ok("other" in forms, `${file}: ${ns}.${key} needs an "other" form`);
          for (const rule of Object.keys(forms)) {
            assert.ok(categories.has(rule as Intl.LDMLPluralRule), `${file}: ${ns}.${key}.${rule} is not a ${tag} plural category`);
          }
        }
        for (const text of textsOfEntry) {
          assert.ok(text.trim() !== "", `${file}: ${ns}.${key} is empty`);
          const used = new Set(placeholders(text));
          for (const name of used) assert.ok(allowed.has(name), `${file}: ${ns}.${key} uses {${name}}`);
          for (const name of required) assert.ok(used.has(name), `${file}: ${ns}.${key} is missing {${name}}`);
        }
      }
    }
  }
});

test("formatters follow German and Spanish", async () => {
  const de = ((await import("./locales/de.js")) as { default: Translation }).default;
  const es = ((await import("./locales/es.js")) as { default: Translation }).default;
  applyLocale("de", de);
  assert.equal(formatNumber(1234.5), "1.234,5");
  assert.equal(formatBytes(1536), "1,5 KB");
  assert.equal(formatDate(0, { dateStyle: "medium", timeZone: "UTC" }), "01.01.1970");
  assert.equal(formatLanguageName("es"), "Spanisch");
  applyLocale("es", es);
  assert.equal(formatNumber(1234.5), "1234,5");
  assert.equal(formatList(["a", "b"]), "a y b");
  assert.equal(formatDate(0, { dateStyle: "medium", timeZone: "UTC" }), "1 ene 1970");
  assert.equal(formatCost(0.004), "0,0040\u00A0US$");
});
