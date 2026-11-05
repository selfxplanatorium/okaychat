/// <reference types="node" />
/**
 * Test-only catalog rules shared by the i18n tests. Nothing in the app imports this module; it lives
 * outside `locales/` so the lazy glob never ships it, and the unused-key scan skips `testing/`.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { en } from "../en/index.js";
import type { Translation } from "../index.js";
import { SOURCE_LOCALE, UI_LOCALES, type UiLocaleRow } from "../../../shared/ui-locales.js";

type Source = Record<string, Record<string, unknown>>;
export const SOURCE = en as Source;

/** Namespaces every non-English shipped locale translates completely. */
export const CORE_NAMESPACES = [
  "video", "common", "shell", "auth", "sidebar", "composer", "thread", "messageDetails", "generation", "annotations",
  "translation", "settings", "general", "account", "usage", "format", "errors", "services", "tags", "ui", "webhooks",
] as const;

/** Feature namespaces a `wave` locale also translates completely. */
export const WAVE_NAMESPACES = ["channels", "roomArchives", "knowledge", "customTools", "evaluations", "notifications"] as const;

/** Keys `legacy` locales already translated outside CORE; they must not regress to English. */
export const LEGACY_SUPPLEMENT = [
  "channels.presenceOnline", "channels.presenceAway", "channels.presenceOffline", "channels.presenceUnavailable",
  "channels.presenceLabel", "channels.typingOne", "channels.typingTwo", "channels.typingMany", "channels.activitySettings",
  "keyboard.cmdMessageTranslate", "keyboard.cmdMessageTranslateChoose",
] as const;

/** Keys a `wave` locale translates from namespaces that otherwise stay optional. */
export const WAVE_SUPPLEMENT = [
  "admin.webhooksTitle", "admin.webhooksDescription", "admin.webhooksEmpty", "admin.webhooksRefresh", "admin.webhooksTotals",
  "admin.webhooksOwner", "admin.webhooksEndpoint", "admin.webhooksPending", "admin.webhooksDead", "admin.webhooksDropped",
  "admin.webhooksOldest", "admin.webhooksAutoDisabled", "admin.webhooksState",
  "permissions.featureKnowledgeLabel", "permissions.featureKnowledgeHelp", "permissions.featureEvaluationsLabel",
  "permissions.featureEvaluationsHelp", "permissions.featureOutgoingWebhooksLabel", "permissions.featureOutgoingWebhooksHelp",
  "permissions.featureChannels", "permissions.featureChannelsHelp", "permissions.featureCustomTools", "permissions.featureCustomToolsHelp",
  "keyboard.cmdMessageTranslate", "keyboard.cmdMessageTranslateChoose",
] as const;

/** Only these rows may keep partial feature coverage; every later row is a full `wave` locale. */
export const LEGACY_TAGS = ["de", "es"] as const;

const namespaceKeys = (namespaces: readonly string[]) =>
  namespaces.flatMap((ns) => Object.keys(SOURCE[ns] ?? {}).map((key) => `${ns}.${key}`));

/** Every key a locale with this coverage must supply. */
export function requiredKeys(coverage: UiLocaleRow["coverage"]): string[] {
  if (coverage === "source") return [];
  if (coverage === "legacy") return [...new Set([...namespaceKeys(CORE_NAMESPACES), "permissions.featureVideosLabel", "permissions.featureVideosHelp", "assistants.familyVideos", ...LEGACY_SUPPLEMENT])];
  return [...new Set([...namespaceKeys(CORE_NAMESPACES), "permissions.featureVideosLabel", "permissions.featureVideosHelp", "assistants.familyVideos", ...namespaceKeys(WAVE_NAMESPACES), ...WAVE_SUPPLEMENT])];
}

export const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
const sourceTexts = (value: unknown): string[] => (typeof value === "string" ? [value] : Object.values(value as Record<string, string>));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

export type CatalogOptions = {
  /** Keys that must be present (own properties). */
  required?: readonly string[];
  /** Plural entries must supply every category of the target language, not only `other`. */
  allCategories?: boolean;
};

/**
 * Checks every supplied entry against English: known namespace and key, the same string/plural shape,
 * non-blank strings, `other` plus only the target language's categories, no unknown placeholder, and every
 * non-`count` placeholder in each form. Returns readable problems; an empty array means valid.
 */
export function catalogProblems(tag: string, translation: unknown, options: CatalogOptions = {}): string[] {
  const problems: string[] = [];
  if (!isRecord(translation)) return [`${tag}: the catalog is not an object`];
  const rules = new Intl.PluralRules(tag);
  const categories = new Set<string>(rules.resolvedOptions().pluralCategories);
  // French selects the singular for zero ("0 message"), so a `one` form that spells out "1" would lie for
  // zero. Other locales (it, pt-PT, de, es) select `other` for zero and may spell the single case out.
  const singularZero = rules.select(0) === "one";
  for (const [ns, entries] of Object.entries(translation)) {
    const source = SOURCE[ns];
    if (!source || !own(SOURCE, ns)) {
      problems.push(`${tag}: unknown namespace ${ns}`);
      continue;
    }
    if (!isRecord(entries)) {
      problems.push(`${tag}: ${ns} is not an object`);
      continue;
    }
    for (const [key, value] of Object.entries(entries)) {
      const id = `${tag}: ${ns}.${key}`;
      if (!own(source, key)) {
        problems.push(`${id} is not an English key`);
        continue;
      }
      const english = source[key];
      const englishTexts = sourceTexts(english);
      const allowed = new Set(englishTexts.flatMap(placeholders));
      const needed = [...allowed].filter((name) => name !== "count");
      const counted = typeof english !== "string" && englishTexts.some((text) => text.includes("{count}"));
      let forms: Array<[string, unknown]>;
      if (typeof english === "string") {
        if (typeof value !== "string") {
          problems.push(`${id} must be a string like English`);
          continue;
        }
        forms = [["text", value]];
      } else {
        if (!isRecord(value)) {
          problems.push(`${id} must be plural forms like English`);
          continue;
        }
        forms = Object.entries(value);
        if (forms.length === 0) problems.push(`${id} has no plural forms`);
        if (!own(value, "other")) problems.push(`${id} needs an "other" form`);
        for (const [rule] of forms) if (!categories.has(rule)) problems.push(`${id}.${rule} is not a ${tag} plural category`);
        if (options.allCategories) for (const rule of categories) if (!own(value, rule)) problems.push(`${id} is missing the "${rule}" form`);
      }
      for (const [rule, text] of forms) {
        const where = rule === "text" ? id : `${id}.${rule}`;
        if (typeof text !== "string") {
          problems.push(`${where} is not text`);
          continue;
        }
        if (text.trim() === "") problems.push(`${where} is empty`);
        const used = new Set(placeholders(text));
        for (const name of used) if (!allowed.has(name)) problems.push(`${where} uses unknown {${name}}`);
        for (const name of needed) if (!used.has(name)) problems.push(`${where} is missing {${name}}`);
        if (rule === "one" && singularZero && counted && !used.has("count")) {
          problems.push(`${where} is missing {count} although ${tag} uses the singular for zero`);
        }
      }
    }
  }
  for (const key of options.required ?? []) {
    const dot = key.indexOf(".");
    const entries = (translation as Record<string, unknown>)[key.slice(0, dot)];
    if (!isRecord(entries) || !own(entries, key.slice(dot + 1))) problems.push(`${tag}: ${key} is missing`);
  }
  return problems;
}

/** Validates a shipped catalog against its registry row. */
export function rowProblems(row: UiLocaleRow, translation: unknown): string[] {
  return catalogProblems(row.tag, translation, { required: requiredKeys(row.coverage), allCategories: row.coverage === "wave" });
}

export const LOCALES_DIR = join(import.meta.dirname, "..", "locales");

/** Chunk basenames on disk, sorted. */
export const chunkTags = (dir = LOCALES_DIR) =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.slice(0, -3))
    .sort();

/** Loads a chunk through Node, never through the Vite glob. */
export async function loadChunk(tag: string, dir = LOCALES_DIR): Promise<Translation> {
  return ((await import(pathToFileURL(join(dir, `${tag}.ts`)).href)) as { default: Translation }).default;
}

export { SOURCE_LOCALE, UI_LOCALES };
