import { SOURCE_LOCALE } from "@shared/ui-locales";
import { en } from "./en";
import { currentLocale, setActiveLocale } from "./locale";

/**
 * UI text lookup. English (`en/`) is the source catalog and is bundled; other locales are partial
 * overrides loaded before the app renders (`loadLocale` in `main.tsx`), with English filling every gap.
 * The locale is fixed for the page's lifetime: `setLocale` stores the choice and reloads, so `t()` is a
 * plain function usable in components, hooks, stores, and event handlers. Never call it at module top level:
 * modules evaluate before `loadLocale` resolves, so such text would stay English. Keep a `MessageKey` there
 * and call `t()` where the text is shown.
 */
export type Catalog = typeof en;
type Namespace = keyof Catalog & string;
/** One entry: plain text, or plural forms chosen by `count` with `Intl.PluralRules`. */
export type PluralForms = { readonly other: string } & { readonly [rule in Intl.LDMLPluralRule]?: string };
type Entry = string | PluralForms;

export type MessageKey = { [N in Namespace]: `${N}.${keyof Catalog[N] & string}` }[Namespace];
type EntryOf<K extends string> = K extends `${infer N}.${infer R}`
  ? N extends Namespace
    ? R extends keyof Catalog[N]
      ? Catalog[N][R]
      : never
    : never
  : never;
type TextOf<E> = E extends string ? E : E[keyof E & string];
type Placeholders<S> = S extends `${string}{${infer P}}${infer Rest}` ? P | Placeholders<Rest> : never;
type Value = string | number;
export type MessageParams<K extends MessageKey> = { [P in Placeholders<TextOf<EntryOf<K>>>]: Value } & (EntryOf<K> extends string
  ? unknown
  : { count: number });
/** Keys without placeholders take no params; the rest require every placeholder (plurals also `count`). */
/** Params for `<Trans>`: the same names, any ReactNode-like value. */
export type MessageNodeParams<K extends MessageKey, Node> = { [P in Placeholders<TextOf<EntryOf<K>>>]: Node } & (EntryOf<K> extends string
  ? unknown
  : { count: number });
export type MessageArgs<K extends MessageKey> = keyof MessageParams<K> extends never ? [] : [params: MessageParams<K>];
/** Keys that take no params. Type lookup tables with this, so `t(TABLE[id])` needs no arguments. */
export type PlainMessageKey = { [K in MessageKey]: keyof MessageParams<K> extends never ? K : never }[MessageKey];

/** A translation: any subset of the English keys, plurals with the target language's own categories. */
export type Translation = {
  [N in Namespace]?: { [K in keyof Catalog[N]]?: Catalog[N][K] extends string ? string : PluralForms };
};

export { SOURCE_LOCALE };
export const LOCALE_STORAGE_KEY = "okaychat:locale";

let overrides: Translation = {};
const sourcePlurals = new Intl.PluralRules(SOURCE_LOCALE);
let plurals = sourcePlurals;
let numbers = new Intl.NumberFormat(SOURCE_LOCALE);

function entry(key: string): { value: Entry | undefined; rules: Intl.PluralRules } {
  const dot = key.indexOf(".");
  const ns = key.slice(0, dot) as Namespace;
  const name = key.slice(dot + 1);
  const translated = (overrides[ns] as Record<string, Entry> | undefined)?.[name];
  return translated === undefined
    ? { value: (en[ns] as Record<string, Entry> | undefined)?.[name], rules: sourcePlurals }
    : { value: translated, rules: plurals };
}

/** Fills `{name}` placeholders. Unknown names stay literal, so text may contain braces. */
export function interpolate(text: string, params: Record<string, Value> | undefined): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : typeof value === "number" ? numbers.format(value) : value;
  });
}

/** The template for a key, with the plural form picked by `params.count`. */
export function template(key: string, count?: number): string {
  const { value, rules } = entry(key);
  if (value === undefined) return key;
  if (typeof value === "string") return value;
  return (count === undefined ? undefined : value[rules.select(count)]) ?? value.other;
}

export function t<K extends MessageKey>(key: K, ...args: MessageArgs<K>): string {
  const params = args[0] as Record<string, Value> | undefined;
  const count = params?.count;
  return interpolate(template(key, typeof count === "number" ? count : undefined), params);
}

export type LocaleLoaders = Record<string, () => Promise<{ default: Translation }>>;

/** Picks the first preferred language we have, by exact tag and then by language subtag. */
export function matchLocale(preferred: readonly string[], available: readonly string[]): string {
  const lower = available.map((tag) => tag.toLowerCase());
  for (const want of preferred) {
    const exact = lower.indexOf(want.toLowerCase());
    if (exact >= 0) return available[exact]!;
    const base = want.toLowerCase().split("-")[0]!;
    const partial = lower.findIndex((tag) => tag.split("-")[0] === base);
    if (partial >= 0) return available[partial]!;
  }
  return SOURCE_LOCALE;
}

const stored = () => {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
};

/** Resolves the locale (stored choice, then browser languages), loads its translation, and sets `<html lang/dir>`. */
export async function loadLocale(loaders: LocaleLoaders): Promise<string> {
  const available = [SOURCE_LOCALE, ...Object.keys(loaders)];
  const choice = stored();
  const preferred = [...(choice ? [choice] : []), ...(typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language])];
  const next = matchLocale(preferred, available);
  let translation: Translation = {};
  if (next !== SOURCE_LOCALE) {
    try {
      translation = (await loaders[next]!()).default;
    } catch {
      // A failed chunk load leaves the UI in English rather than blank.
      return applyLocale(SOURCE_LOCALE, {});
    }
  }
  return applyLocale(next, translation);
}

/** Sets the active locale directly. Exposed for tests; the app goes through `loadLocale`. */
export function applyLocale(tag: string, translation: Translation): string {
  setActiveLocale(tag);
  overrides = translation;
  plurals = new Intl.PluralRules(tag);
  numbers = new Intl.NumberFormat(tag);
  if (typeof document !== "undefined") {
    document.documentElement.lang = tag;
    document.documentElement.dir = textDirection(tag);
  }
  return tag;
}

export function textDirection(tag: string): "ltr" | "rtl" {
  try {
    const info = new Intl.Locale(tag) as Intl.Locale & { getTextInfo?: () => { direction?: string }; textInfo?: { direction?: string } };
    const direction = info.getTextInfo?.().direction ?? info.textInfo?.direction;
    if (direction) return direction === "rtl" ? "rtl" : "ltr";
  } catch {
    // Fall through to the language list.
  }
  return /^(ar|fa|he|ps|ur|yi|dv|ckb|sd|ug)(-|$)/i.test(tag) ? "rtl" : "ltr";
}

/**
 * Stores the device language choice (`null` follows the browser) and reloads, since text is read once per
 * page. `account-locale.ts` is the only caller that should save an account language; components use it so
 * the server value is written first.
 */
export function setLocale(tag: string | null) {
  try {
    if (tag) localStorage.setItem(LOCALE_STORAGE_KEY, tag);
    else localStorage.removeItem(LOCALE_STORAGE_KEY);
  } catch {
    // Without storage the browser language keeps applying.
  }
  location.reload();
}

export { currentLocale };
