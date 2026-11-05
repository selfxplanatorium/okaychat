/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { UI_LOCALES } from "@shared/ui-locales";
import { en } from "./en/index.js";
import {
  compareText,
  formatBytes,
  formatCost,
  formatDate,
  formatDateTime,
  formatDuration,
  formatLanguageName,
  formatList,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTime,
  formatTokens,
} from "./format.js";
import { applyLocale, loadLocale, matchLocale, t, textDirection, type LocaleLoaders, type Translation } from "./index.js";
import { catalogProblems, loadChunk, LEGACY_SUPPLEMENT, requiredKeys, rowProblems, SOURCE } from "./testing/catalog-rules.js";
import { missingKeys, readSources, requestedKeys, runtimeSources, unusedKeys } from "./testing/key-scan.js";

afterEach(() => applyLocale("en", {}));

const webRoot = join(import.meta.dirname, "..");
const nonSource = UI_LOCALES.filter((row) => row.coverage !== "source");

test("t fills placeholders, formats numbers, and picks plural forms", () => {
  assert.equal(t("common.cancel"), "Cancel");
  assert.equal(t("composer.deleteChatBody", { title: "Plans" }).startsWith("“Plans”"), true);
  assert.equal(t("composer.deleteChatsTitle", { count: 1 }), "Delete 1 chat permanently?");
  assert.equal(t("composer.deleteChatsTitle", { count: 1200 }), "Delete 1,200 chats permanently?");
});

test("a missing namespace and a missing entry in a supplied namespace both fall back to English", () => {
  const de: Translation = { common: { cancel: "Abbrechen" }, composer: { deleteChatsTitle: { one: "{count} Chat löschen?", other: "{count} Chats löschen?" } } };
  applyLocale("de", de);
  assert.equal(t("common.cancel"), "Abbrechen");
  assert.equal(t("common.save"), "Save");
  assert.equal(t("sidebar.chats"), en.sidebar.chats);
  assert.equal(t("composer.deleteChatsTitle", { count: 1200 }), "1.200 Chats löschen?");
});

test("English fallback plurals use English rules; translated plurals use the active language and their own other", () => {
  const french = new Intl.NumberFormat("fr");
  applyLocale("fr", {});
  // English picks "other" for 0, French would pick "one": the fallback keeps English rules.
  assert.equal(t("composer.deleteChatsTitle", { count: 0 }), "Delete 0 chats permanently?");
  // Numeric placeholders still use the active locale inside English text.
  assert.equal(t("composer.deleteChatsTitle", { count: 1_234_567 }), `Delete ${french.format(1_234_567)} chats permanently?`);
  applyLocale("fr", { composer: { deleteChatsTitle: { one: "ONE {count}", other: "OTHER {count}" } } });
  assert.equal(t("composer.deleteChatsTitle", { count: 0 }), "ONE 0");
  assert.equal(t("composer.deleteChatsTitle", { count: 1.5 }), `ONE ${french.format(1.5)}`);
  // 1,000,000 is French "many"; the entry omits it, so it uses its own "other", never English.
  assert.equal(new Intl.PluralRules("fr").select(1_000_000), "many");
  assert.equal(t("composer.deleteChatsTitle", { count: 1_000_000 }), `OTHER ${french.format(1_000_000)}`);
  applyLocale("ru", { composer: { deleteChatsTitle: { one: "{count} чат", few: "{count} чата", other: "{count} чатов" } } });
  assert.equal(t("composer.deleteChatsTitle", { count: 21 }), "21 чат");
  assert.equal(t("composer.deleteChatsTitle", { count: 2 }), "2 чата");
});

test("locale matching prefers exact tags, then the language subtag, in the given order", () => {
  const available = UI_LOCALES.map((row) => row.tag);
  for (const [want, got] of [
    [["fr-CA"], "fr"], [["it-CH"], "it"], [["pt"], "pt-PT"], [["pt-BR"], "pt-PT"], [["PT-pt"], "pt-PT"], [["de-AT"], "de"],
    [["ja", "it-IT"], "it"], [["ja", "ko"], "en"], [["ES"], "es"],
  ] as const) assert.equal(matchLocale(want, available), got, want.join(","));
  assert.equal(textDirection("ar-EG"), "rtl");
  assert.equal(textDirection("de"), "ltr");
});

test("the English source catalog is text or plural forms with `other`, with plain keys", () => {
  for (const [ns, entries] of Object.entries(en)) {
    assert.match(ns, /^\w+$/);
    for (const [key, value] of Object.entries(entries)) {
      assert.match(key, /^\w+$/, `${ns}.${key}`);
      if (typeof value === "string") continue;
      assert.equal(typeof (value as Record<string, unknown>).other, "string", `${ns}.${key} needs an "other" form`);
      for (const [rule, form] of Object.entries(value as Record<string, unknown>)) {
        assert.ok(["one", "other"].includes(rule), `${ns}.${key}.${rule}`);
        assert.equal(typeof form, "string");
      }
    }
  }
});

test("every catalog key is used literally in runtime web code", () => {
  // Catalogs, the registry, test helpers, fixtures, and tests are excluded, so a translation can never make an
  // unused English key look used.
  const code = readSources(webRoot, runtimeSources(webRoot));
  assert.deepEqual(unusedKeys(SOURCE, code), []);
});

test("every key the runtime code requests exists in the English catalog", () => {
  const files = runtimeSources(webRoot);
  assert.ok(files.includes("i18n/format.ts") && files.includes("i18n/react.tsx"));
  assert.deepEqual(missingKeys(SOURCE, requestedKeys(readSources(webRoot, files))), []);
});

test("the key scanners ignore catalogs, tests, and fixtures and count literal tables", () => {
  const root = mkdtempSync(join(tmpdir(), "okaychat-key-scan-"));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  try {
    write("i18n/locales/xx.ts", 'export default { common: { add: "common.add" } };');
    write("i18n/en/common.ts", 'export default { add: "common.add" };');
    write("i18n/testing/rules.ts", 'const k = "common.add";');
    write("components/fixtures/demo.ts", 'const k = "common.add";');
    write("components/demo.test.ts", 't("common.add");');
    write("components/table.tsx", 'const LABELS = { a: "common.back" } as const satisfies Record<Kind, PlainMessageKey>;\nconst MORE: Record<Kind, PlainMessageKey> = { b: "common.nope" };');
    write("components/calls.tsx", 'commandTarget("common.zzz"); <b data-command="common.yyy" />; t("common.close"); <Trans k="common.open" />; ({ labelKey: "common.more" });');
    const files = runtimeSources(root);
    assert.deepEqual(files, ["components/calls.tsx", "components/table.tsx"]);
    const code = readSources(root, files);
    const catalog = { common: { add: "", back: "", close: "", open: "", more: "" } };
    assert.deepEqual(unusedKeys(catalog, code), ["common.add"]);
    assert.deepEqual([...requestedKeys(code)].sort(), ["common.back", "common.close", "common.more", "common.nope", "common.open"]);
    assert.deepEqual(missingKeys(catalog, requestedKeys(code)), ["common.nope"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the validator rejects each malformed shape independently", () => {
  const cases: Array<[string, unknown, string]> = [
    ["unknown namespace", { nope: { a: "x" } }, "unknown namespace nope"],
    ["unknown key", { common: { nope: "x" } }, "common.nope is not an English key"],
    ["plural for text", { common: { add: { other: "x" } } }, "must be a string"],
    ["text for plural", { sidebar: { selectedCount: "{count}" } }, "must be plural forms"],
    ["array", { sidebar: { selectedCount: ["{count}"] } }, "must be plural forms"],
    ["null", { common: { add: null } }, "must be a string"],
    ["empty plural", { sidebar: { selectedCount: {} } }, "has no plural forms"],
    ["missing other", { sidebar: { selectedCount: { one: "{count}" } } }, 'needs an "other" form'],
    ["foreign category", { sidebar: { selectedCount: { few: "{count}", other: "{count}" } } }, "few is not a fr plural category"],
    ["blank", { common: { add: "  " } }, "common.add is empty"],
    ["blank form", { sidebar: { selectedCount: { one: " ", other: "{count}" } } }, "selectedCount.one is empty"],
    ["non-text form", { sidebar: { selectedCount: { other: 3 } } }, "selectedCount.other is not text"],
    ["unknown placeholder", { common: { add: "{x}" } }, "uses unknown {x}"],
    ["missing placeholder", { shell: { tabTitle: "okaychat" } }, "missing {title}"],
    ["missing placeholder in a form", { sidebar: { pinFailedSome: "{failed}" } }, "missing {total}"],
    ["namespace not an object", { common: "x" }, "common is not an object"],
  ];
  for (const [name, catalog, expected] of cases) {
    const problems = catalogProblems("fr", catalog);
    assert.ok(problems.some((problem) => problem.includes(expected)), `${name}: ${problems.join("; ")}`);
  }
  // `count` may be spelled out in a form, other placeholders may not be dropped.
  assert.deepEqual(catalogProblems("fr", { sidebar: { selectedCount: { one: "une discussion", other: "{count} discussions" } } }), []);
  const all = catalogProblems("fr", { sidebar: { selectedCount: { one: "{count}", other: "{count}" } } }, { allCategories: true });
  assert.ok(all.some((problem) => problem.includes('missing the "many" form')));
  const required = catalogProblems("fr", { common: { add: "Ajouter" } }, { required: ["common.add", "common.back"] });
  assert.deepEqual(required, ["fr: common.back is missing"]);
  // Own properties only: an inherited key is not a translation.
  const inherited = Object.create({ add: "Ajouter" }) as Record<string, string>;
  assert.deepEqual(catalogProblems("fr", { common: inherited }, { required: ["common.add"] }), ["fr: common.add is missing"]);
});

test("every chunk on disk is valid for its registry row, including optional entries", async () => {
  for (const row of nonSource) {
    const problems = rowProblems(row, await loadChunk(row.tag));
    assert.deepEqual(problems, [], row.tag);
  }
  // Legacy rows keep the activity and keyboard text they already translated.
  for (const row of nonSource.filter((r) => r.coverage === "legacy")) {
    const keys = requiredKeys(row.coverage);
    for (const key of LEGACY_SUPPLEMENT) assert.ok(keys.includes(key), `${row.tag}: ${key}`);
  }
});

test("translated plural entries pick the active language's category for representative counts", async () => {
  const counts = [0, 1, 2, 5, 1.2, 1_000_000];
  for (const row of nonSource) {
    const translation = (await loadChunk(row.tag)) as Record<string, Record<string, unknown>>;
    const rules = new Intl.PluralRules(row.tag);
    const numbers = new Intl.NumberFormat(row.tag);
    applyLocale(row.tag, translation as Translation);
    const forms = translation.sidebar!.selectedCount as Record<string, string>;
    for (const count of counts) {
      const text = forms[rules.select(count)] ?? forms.other!;
      assert.equal(t("sidebar.selectedCount", { count }), text.replace("{count}", numbers.format(count)), `${row.tag} ${count}`);
    }
  }
  // The documented distinctions of the shipped wave languages.
  for (const tag of ["fr", "it", "pt-PT"]) {
    const rules = new Intl.PluralRules(tag);
    assert.deepEqual(rules.resolvedOptions().pluralCategories.slice().sort(), ["many", "one", "other"], tag);
    assert.equal(rules.select(1), "one");
    assert.equal(rules.select(2), "other");
    assert.equal(rules.select(1_000_000), "many");
    assert.equal(rules.select(0), tag === "fr" ? "one" : "other");
    assert.equal(rules.select(1.2), tag === "fr" ? "one" : "other");
  }
});

/** Expected text of a `format.*` template from the catalog itself, filled with independently formatted numbers. */
function unit(translation: Translation, key: keyof typeof en.format, values: Record<string, string>): string {
  const text = (translation.format?.[key] ?? en.format[key]) as string;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => values[name]!);
}

test("formatters follow every registered language and match the runtime Intl", async () => {
  for (const row of UI_LOCALES) {
    const tag = row.tag;
    const translation = row.coverage === "source" ? {} : await loadChunk(tag);
    applyLocale(tag, translation);
    const number = (options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(tag, options);
    for (const n of [1_234_567.89, -1_234_567.89]) assert.equal(formatNumber(n), number().format(n), tag);
    assert.equal(formatPercent(0.425), number({ style: "percent", maximumFractionDigits: 0 }).format(0.425));
    const utc = { timeZone: "UTC" } as const;
    assert.equal(formatDate(0, { dateStyle: "medium", ...utc }), new Intl.DateTimeFormat(tag, { dateStyle: "medium", ...utc }).format(0));
    assert.equal(formatDateTime(Date.UTC(2026, 10, 5, 14, 30), { dateStyle: "medium", timeStyle: "short", ...utc }), new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short", ...utc }).format(Date.UTC(2026, 10, 5, 14, 30)));
    assert.equal(formatTime(Date.UTC(2026, 10, 5, 14, 30), { timeStyle: "short", ...utc }), new Intl.DateTimeFormat(tag, { timeStyle: "short", ...utc }).format(Date.UTC(2026, 10, 5, 14, 30)));
    const now = Date.UTC(2026, 10, 5);
    const relative = new Intl.RelativeTimeFormat(tag, { numeric: "auto" });
    assert.equal(formatRelativeTime(now - 86_400_000, now), relative.format(-1, "day"));
    assert.equal(formatRelativeTime(now + 3 * 3600_000, now), relative.format(3, "hour"));
    assert.equal(formatList(["a", "b", "c"]), new Intl.ListFormat(tag, { type: "conjunction" }).format(["a", "b", "c"]));
    assert.equal(compareText("a", "B"), new Intl.Collator(tag).compare("a", "B"));
    assert.equal(compareText("é", "f") < 0, true, `${tag} sorts accented letters with their base letter`);
    const usd = (n: number, digits: number) => number({ style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
    assert.equal(formatCost(0), usd(0, 0));
    assert.equal(formatCost(0.004), usd(0.004, 4));
    assert.equal(formatCost(0.01), usd(0.01, 2));
    assert.equal(formatCost(12.34), usd(12.34, 2));
    const d = (n: number, digits: number) => number({ maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(n);
    assert.equal(formatBytes(0), unit(translation, "bytes", { n: number().format(0) }));
    assert.equal(formatBytes(1023), unit(translation, "bytes", { n: number().format(1023) }));
    assert.equal(formatBytes(1024), unit(translation, "kilobytes", { n: d(1, 1) }));
    assert.equal(formatBytes(1536), unit(translation, "kilobytes", { n: d(1.5, 1) }));
    assert.equal(formatBytes(1024 ** 2), unit(translation, "megabytes", { n: d(1, 1) }));
    assert.equal(formatBytes(1024 ** 3), unit(translation, "gigabytes", { n: d(1, 1) }));
    assert.equal(formatTokens(950), number().format(950));
    assert.equal(formatTokens(1200), unit(translation, "thousands", { n: d(1.2, 1) }));
    assert.equal(formatTokens(41_200), unit(translation, "thousands", { n: d(41.2, 0) }));
    assert.equal(formatTokens(1_500_000), unit(translation, "millions", { n: d(1.5, 1) }));
    const i = (n: number) => number().format(n);
    assert.equal(formatDuration(0), unit(translation, "seconds", { s: i(0) }));
    assert.equal(formatDuration(59), unit(translation, "seconds", { s: i(59) }));
    assert.equal(formatDuration(60), unit(translation, "minutesSeconds", { m: i(1), s: i(0) }));
    assert.equal(formatDuration(185), unit(translation, "minutesSeconds", { m: i(3), s: i(5) }));
    assert.equal(formatDuration(3600), unit(translation, "hoursMinutes", { h: i(1), m: i(0) }));
  }
});

test("reviewed literal formats for each shipped language", async () => {
  const literal = async (tag: string) => applyLocale(tag, tag === "en" ? {} : await loadChunk(tag));
  await literal("en");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatTokens(41_200), "41k");
  assert.equal(formatCost(0.004), "$0.0040");
  assert.equal(formatDuration(185), "3m 5s");
  assert.equal(formatList(["a", "b", "c"]), "a, b, and c");
  await literal("de");
  assert.equal(formatNumber(1234.5), "1.234,5");
  assert.equal(formatBytes(1536), "1,5 KB");
  assert.equal(formatDate(0, { dateStyle: "medium", timeZone: "UTC" }), "01.01.1970");
  assert.equal(formatLanguageName("es"), "Spanisch");
  await literal("es");
  assert.equal(formatNumber(1234.5), "1234,5");
  assert.equal(formatList(["a", "b"]), "a y b");
  assert.equal(formatDate(0, { dateStyle: "medium", timeZone: "UTC" }), "1 ene 1970");
  assert.equal(formatCost(0.004), "0,0040 US$");
  await literal("fr");
  assert.equal(formatNumber(1_234_567.89), "1 234 567,89");
  assert.equal(formatList(["a", "b", "c"]), "a, b et c");
  assert.equal(formatBytes(1536), "1,5 Ko");
  assert.equal(formatPercent(0.42), "42 %");
  await literal("it");
  assert.equal(formatNumber(1_234_567.89), "1.234.567,89");
  assert.equal(formatList(["a", "b", "c"]), "a, b e c");
  assert.equal(formatCost(12.34), "12,34 USD");
  await literal("pt-PT");
  assert.equal(formatNumber(1_234_567.89), "1 234 567,89");
  assert.equal(formatDate(0, { dateStyle: "medium", timeZone: "UTC" }), "01/01/1970");
  assert.equal(formatCost(12.34), "12,34 US$");
});

test("formatter caches stay per locale", () => {
  applyLocale("fr", {});
  const french = formatNumber(1234.5);
  applyLocale("it", {});
  assert.equal(formatNumber(1234.5), new Intl.NumberFormat("it").format(1234.5));
  applyLocale("fr", {});
  assert.equal(formatNumber(1234.5), french);
});

// --- loadLocale ---------------------------------------------------------------------------------------

const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
const saved = { localStorage: globalThis.localStorage, navigator: globalThis.navigator, document: (globalThis as { document?: unknown }).document };

function environment(stored: string | null, languages: readonly string[], blocked = false) {
  const html = { lang: "", dir: "" };
  define("document", { documentElement: html });
  define("navigator", { languages, language: languages[0] ?? "en" });
  define(
    "localStorage",
    blocked
      ? { getItem: () => { throw new Error("blocked"); } }
      : { getItem: (key: string) => (key === "okaychat:locale" ? stored : null) },
  );
  return html;
}

function restore() {
  define("localStorage", saved.localStorage);
  define("navigator", saved.navigator);
  define("document", saved.document);
}

function loaders(fail: readonly string[] = []) {
  const calls: string[] = [];
  const map: LocaleLoaders = {};
  for (const row of nonSource) {
    map[row.tag] = async () => {
      calls.push(row.tag);
      if (fail.includes(row.tag)) throw new Error("chunk failed");
      return { default: { common: { cancel: `cancel:${row.tag}` } } };
    };
  }
  return { calls, map };
}

test("loadLocale resolves stored choice, then browser languages, by exact tag then base language", { concurrency: false }, async () => {
  try {
    for (const [stored, languages, expected] of [
      [null, ["fr-CA", "en"], "fr"],
      [null, ["it-CH"], "it"],
      [null, ["pt"], "pt-PT"],
      [null, ["pt-BR"], "pt-PT"],
      [null, ["PT-pt"], "pt-PT"],
      [null, ["ja", "es-MX"], "es"],
      [null, ["ja"], "en"],
      ["it", ["fr"], "it"],
      ["pt-BR", ["fr"], "pt-PT"],
      ["ja", ["de-AT"], "de"],
    ] as const) {
      const html = environment(stored, languages);
      const { calls, map } = loaders();
      assert.equal(await loadLocale(map), expected, `${stored} ${languages.join(",")}`);
      assert.deepEqual(calls, expected === "en" ? [] : [expected], "only the selected chunk loads");
      assert.equal(html.lang, expected);
      assert.equal(html.dir, "ltr");
      assert.equal(t("common.cancel"), expected === "en" ? "Cancel" : `cancel:${expected}`);
    }
  } finally {
    restore();
  }
});

test("loadLocale falls back to English for a failed chunk and survives blocked storage", { concurrency: false }, async () => {
  try {
    let html = environment(null, ["fr"]);
    const failing = loaders(["fr"]);
    assert.equal(await loadLocale(failing.map), "en");
    assert.deepEqual(failing.calls, ["fr"]);
    assert.equal(html.lang, "en");
    assert.equal(html.dir, "ltr");
    assert.equal(t("common.cancel"), "Cancel");
    html = environment("de", ["it"], true);
    const blocked = loaders();
    assert.equal(await loadLocale(blocked.map), "it");
    assert.equal(html.lang, "it");
  } finally {
    restore();
  }
});
