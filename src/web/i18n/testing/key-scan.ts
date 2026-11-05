/// <reference types="node" />
/**
 * Test-only scanners for the key gates. The catalogs themselves (English, translations), this directory,
 * and tests never count as usage, so a key that only a translation or a test mentions is reported unused.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const KEY = String.raw`[a-z][A-Za-z0-9]*\.[A-Za-z0-9]+`;

/** Directories under `src/web` whose files never count as using or requesting a key. */
const EXCLUDED_DIRS = ["i18n/en", "i18n/locales", "i18n/testing"];

/** Runtime web source files, relative paths with `/`, for the key scans. */
export function runtimeSources(webRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(webRoot, path).split("\\").join("/");
      if (statSync(path).isDirectory()) {
        if (!EXCLUDED_DIRS.includes(rel) && name !== "fixtures") walk(path);
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel);
    }
  };
  walk(webRoot);
  return out.sort();
}

export const readSources = (webRoot: string, files: readonly string[]) => files.map((file) => readFileSync(join(webRoot, file), "utf8")).join("\n");

/** Keys of `catalog` that no runtime source mentions as a quoted literal. */
export function unusedKeys(catalog: Record<string, Record<string, unknown>>, code: string): string[] {
  return Object.entries(catalog)
    .flatMap(([ns, entries]) => Object.keys(entries).map((key) => `${ns}.${key}`))
    .filter((key) => !code.includes(`"${key}"`));
}

/**
 * Keys the code asks for: literal `t("…")`, `<Trans k="…">`, `…Key: "…"` properties, and the values of typed
 * `PlainMessageKey` tables. A bare `t(` also matches `commandTarget(`, and `data-command="…"` holds command
 * ids, so the patterns require a non-identifier character before `t(` and a standalone `k=`.
 */
export function requestedKeys(code: string): Set<string> {
  const patterns = [
    new RegExp(String.raw`(?:^|[^\w$])t\("(${KEY})"`, "g"),
    new RegExp(String.raw`(?:^|[^\w-])k="(${KEY})"`, "g"),
    new RegExp(String.raw`\b[a-z][A-Za-z]*Key:\s*"(${KEY})"`, "g"),
  ];
  const keys = new Set(patterns.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[1]!)));
  const tables = [
    /Record<[^>]*,\s*PlainMessageKey>\s*=\s*\{([^{}]*)\}/g,
    /\{([^{}]*)\}\s*(?:as const\s*)?satisfies\s+Record<[^>]*,\s*PlainMessageKey>/g,
  ];
  for (const table of tables) {
    for (const match of code.matchAll(table)) {
      for (const value of match[1]!.matchAll(new RegExp(String.raw`:\s*"(${KEY})"`, "g"))) keys.add(value[1]!);
    }
  }
  return keys;
}

export function missingKeys(catalog: Record<string, Record<string, unknown>>, keys: Iterable<string>): string[] {
  return [...keys].filter((key) => {
    const dot = key.indexOf(".");
    const entries = catalog[key.slice(0, dot)];
    return !entries || !Object.prototype.hasOwnProperty.call(entries, key.slice(dot + 1));
  });
}
