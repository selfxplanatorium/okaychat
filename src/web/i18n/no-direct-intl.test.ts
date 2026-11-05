/// <reference types="node" />
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

// Formatting belongs to `@/i18n/format`. A direct `Intl` call or a raw `localeCompare` in the UI would
// silently ignore the active UI language, so the rule is enforced instead of reviewed. The i18n module
// itself owns the formatters, the vendored glass engine is third-party, and the theme editor is a
// separate port that predates the rule (see docs/implementation/i18n.md).
const webRoot = join(import.meta.dirname, "..");
const FORBIDDEN = [
  "toLocaleString(",
  "toLocaleDateString(",
  "toLocaleTimeString(",
  "toLocaleUpperCase(",
  "toLocaleLowerCase(",
  "new Intl.",
  "localeCompare(",
];

const allowed = (path: string) =>
  path.startsWith("i18n/") ||
  path.startsWith("vendor/") ||
  path.startsWith("theme/") ||
  path.startsWith("components/settings/theme/") ||
  /\.test\.tsx?$/.test(path);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(webRoot, path).split("\\").join("/");
    if (statSync(path).isDirectory()) {
      if (!allowed(`${rel}/`)) sources(path, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

test("web code formats and compares through the i18n helpers", () => {
  const offenders = sources(webRoot).flatMap((file) => {
    const text = readFileSync(join(webRoot, file), "utf8");
    return FORBIDDEN.filter((needle) => text.includes(needle)).map((needle) => `${file}: ${needle}`);
  });
  assert.deepEqual(offenders, []);
});
