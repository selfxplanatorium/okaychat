import type { LocaleLoaders, Translation } from "./index";

/**
 * Translations other than English, one file per BCP 47 tag (`locales/de.ts`, `locales/pt-BR.ts`), each a
 * default-exported `Translation`. Each becomes its own chunk, fetched only for users who need it.
 */
const modules = import.meta.glob<{ default: Translation }>("./locales/*.ts");

export const localeLoaders: LocaleLoaders = Object.fromEntries(
  Object.entries(modules).map(([path, load]) => [path.replace(/^.*\/|\.ts$/g, ""), load]),
);
