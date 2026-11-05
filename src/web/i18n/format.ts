import { uiLocaleRow } from "@shared/ui-locales";
import { t } from "./index";
import { currentLocale } from "./locale";

/**
 * Locale-aware formatting. Use these instead of `toLocaleString()`, `toFixed()` in visible text, or
 * hand-built date strings, so numbers, dates, and lists follow the UI language.
 */
const cache = new Map<
  string,
  Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.ListFormat | Intl.Collator | Intl.DisplayNames
>();
function cached<
  T extends Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.ListFormat | Intl.Collator | Intl.DisplayNames,
>(
  kind: string,
  options: object | undefined,
  make: (locale: string) => T,
): T {
  const key = `${currentLocale()}|${kind}|${JSON.stringify(options ?? {})}`;
  let value = cache.get(key) as T | undefined;
  if (!value) cache.set(key, (value = make(currentLocale())));
  return value;
}

type DateInput = number | string | Date;
const toDate = (value: DateInput) => (value instanceof Date ? value : new Date(value));

export const formatNumber = (n: number, options?: Intl.NumberFormatOptions) =>
  cached("number", options, (locale) => new Intl.NumberFormat(locale, options)).format(n);

export const formatPercent = (fraction: number, options?: Intl.NumberFormatOptions) =>
  formatNumber(fraction, { style: "percent", maximumFractionDigits: 0, ...options });

/** A date without time. Defaults to the medium style ("Oct 30, 2026" in English). */
export const formatDate = (value: DateInput, options: Intl.DateTimeFormatOptions = { dateStyle: "medium" }) =>
  cached("date", options, (locale) => new Intl.DateTimeFormat(locale, options)).format(toDate(value));

export const formatDateTime = (value: DateInput, options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }) =>
  formatDate(value, options);

export const formatTime = (value: DateInput, options: Intl.DateTimeFormatOptions = { timeStyle: "short" }) => formatDate(value, options);

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/** "3 minutes ago", "in 2 days", "yesterday", relative to `now`. */
export function formatRelativeTime(value: DateInput, now = Date.now(), options: Intl.RelativeTimeFormatOptions = { numeric: "auto" }) {
  const seconds = (toDate(value).getTime() - now) / 1000;
  const [unit, size] = UNITS.find(([, size]) => Math.abs(seconds) >= size) ?? ["second", 1];
  return cached("relative", options, (locale) => new Intl.RelativeTimeFormat(locale, options)).format(Math.round(seconds / size), unit);
}

/** "a, b, and c" in the UI language. */
export const formatList = (items: readonly string[], options: Intl.ListFormatOptions = { type: "conjunction" }) =>
  cached("list", options, (locale) => new Intl.ListFormat(locale, options)).format(items);

/** Sorts text the way the UI language does. */
export const compareText = (a: string, b: string, options?: Intl.CollatorOptions) =>
  cached("collator", options, (locale) => new Intl.Collator(locale, options)).compare(a, b);

/** The language's own name in the UI language ("German", "Deutsch"), falling back to the tag. */
export const formatLanguageName = (tag: string): string => {
  try {
    return cached("language", { type: "language" }, (locale) => new Intl.DisplayNames([locale], { type: "language" })).of(tag) ?? tag;
  } catch {
    // An unknown or malformed tag must still label its option; the tag itself is the honest fallback.
    return tag;
  }
};

const autonyms = new Map<string, string>();

/**
 * A language's name in that language ("Deutsch", "Français"), the same in every UI language, for the UI
 * language picker. Shipped tags use the reviewed registry name; any other tag asks `Intl` in its own language
 * and falls back to the tag. Kept apart from `cached`, whose entries are per UI language.
 */
export const formatNativeLanguageName = (tag: string): string => {
  const row = uiLocaleRow(tag);
  if (row && row.tag === tag) return row.nativeName;
  let name = autonyms.get(tag);
  if (name === undefined) {
    try {
      name = new Intl.DisplayNames([tag], { type: "language" }).of(tag) ?? tag;
    } catch {
      name = tag;
    }
    autonyms.set(tag, name);
  }
  return name;
};

/** Capitalizes the first character for the UI language, leaving the rest of the text alone. */
export const formatSentenceCase = (text: string): string => {
  const first = text.charAt(0);
  return first ? first.toLocaleUpperCase(currentLocale()) + text.slice(1) : text;
};

const decimals = (n: number, digits: number) => formatNumber(n, { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** File and storage sizes in binary units: "512 B", "1.5 KB", "12 MB", "2.4 GB". */
export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return t("format.gigabytes", { n: decimals(n / 1024 ** 3, n >= 10 * 1024 ** 3 ? 0 : 1) });
  if (n >= 1024 ** 2) return t("format.megabytes", { n: decimals(n / 1024 ** 2, n >= 100 * 1024 ** 2 ? 0 : 1) });
  if (n >= 1024) return t("format.kilobytes", { n: decimals(n / 1024, 1) });
  return t("format.bytes", { n: formatNumber(n) });
}

/** Token counts: "950", "1.2k", "41k", "1.5M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return t("format.millions", { n: decimals(n / 1_000_000, n >= 10_000_000 ? 0 : 1) });
  if (n >= 1000) return t("format.thousands", { n: decimals(n / 1000, n >= 10_000 ? 0 : 1) });
  return formatNumber(n);
}

/** US-dollar cost. Below a cent it keeps four decimals so small turns do not read as free. */
export const formatCost = (n: number) =>
  formatNumber(n, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: n === 0 ? 0 : n < 0.01 ? 4 : 2,
    maximumFractionDigits: n === 0 ? 0 : n < 0.01 ? 4 : 2,
  });

/** Short elapsed time: "41s", "3m 5s", "1h 2m". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return t("format.seconds", { s });
  if (s < 3600) return t("format.minutesSeconds", { m: Math.floor(s / 60), s: s % 60 });
  return t("format.hoursMinutes", { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
}
