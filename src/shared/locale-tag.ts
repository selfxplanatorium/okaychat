/** A BCP 47 tag we accept as a UI or translation language. Structural only; the catalog decides UI support. */
export const LOCALE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
export const MAX_LOCALE_TAG = 35;

/** Canonical form (`de-at` → `de-AT`), or null when the tag is malformed or unknown to ICU. */
export function canonicalLocaleTag(value: string): string | null {
  // Length first: `getCanonicalLocales` accepts long private-use tags, and the limits above are ours.
  if (value.length > MAX_LOCALE_TAG || !LOCALE_TAG.test(value)) return null;
  try {
    // Node 22 and current browsers ship full ICU, so this rejects nonsense rather than guessing.
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
}

/** Languages offered by the Translate language picker, beyond the shipped UI locales. Not exhaustive:
 *  the server accepts any valid tag, so a later custom entry keeps working. */
export const TRANSLATION_LANGUAGES = [
  "en", "de", "es", "fr", "it", "pt", "pt-BR", "nl", "pl", "ru", "uk", "tr",
  "ar", "he", "fa", "hi", "ja", "ko", "zh-CN", "zh-TW", "vi", "th", "id",
  "sv", "da", "fi", "cs", "el", "ro", "hu",
] as const;
