/**
 * The UI languages okaychat ships, in picker and tie-break order. Pure metadata, safe on the server and in
 * the browser: no translation text, storage, or bundler imports. Adding a language is one row here
 * (`coverage: "wave"`) plus one `src/web/i18n/locales/<tag>.ts` file named by the exact canonical tag.
 *
 * - `nativeName` is the reviewed autonym shown in the language picker, the same in every UI language.
 * - `direction` is the expected text direction; tests check it against the runtime resolver.
 * - `coverage` selects the required-key policy in the i18n tests: `source` is the English catalog itself,
 *   `legacy` (German and Spanish only) covers the core namespaces, `wave` covers core plus the feature
 *   namespaces. This is not a server allowlist: any valid BCP 47 tag may be stored as an account language.
 */
export const UI_LOCALES = [
  { tag: "en", nativeName: "English", direction: "ltr", coverage: "source" },
  { tag: "de", nativeName: "Deutsch", direction: "ltr", coverage: "legacy" },
  { tag: "es", nativeName: "Español", direction: "ltr", coverage: "legacy" },
  { tag: "fr", nativeName: "Français", direction: "ltr", coverage: "wave" },
  { tag: "it", nativeName: "Italiano", direction: "ltr", coverage: "wave" },
  { tag: "pt-PT", nativeName: "Português (Portugal)", direction: "ltr", coverage: "wave" },
] as const satisfies readonly UiLocaleRow[];

export type UiLocaleRow = {
  readonly tag: string;
  readonly nativeName: string;
  readonly direction: "ltr" | "rtl";
  readonly coverage: "source" | "legacy" | "wave";
};
export type UiLocale = (typeof UI_LOCALES)[number]["tag"];

export const SOURCE_LOCALE = "en" satisfies UiLocale;

/** The registry row for an exact tag (case-insensitive), or undefined for an unshipped language. */
export const uiLocaleRow = (tag: string): UiLocaleRow | undefined => {
  const lower = tag.toLowerCase();
  return (UI_LOCALES as readonly UiLocaleRow[]).find((row) => row.tag.toLowerCase() === lower);
};
