import { SOURCE_LOCALE } from "@shared/ui-locales";
import type { LocaleLoaders, Translation } from "./index";
import { registryLoaders } from "./locale-registry";

/**
 * Translations other than English, one file per registered tag (`locales/de.ts`, `locales/pt-PT.ts`), each a
 * default-exported `Translation`. The glob is lazy: each file becomes its own chunk, fetched only for users
 * who need it. Which languages ship is decided by `src/shared/ui-locales.ts`, not by the files present.
 */
const modules = import.meta.glob<{ default: Translation }>("./locales/*.ts");

export const localeLoaders: LocaleLoaders = registryLoaders(modules);

/** English plus every shipped translation, in registry order. */
export const shippedLocales = (): string[] => [SOURCE_LOCALE, ...Object.keys(localeLoaders)];
