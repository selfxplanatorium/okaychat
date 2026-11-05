import { SOURCE_LOCALE, UI_LOCALES, type UiLocaleRow } from "@shared/ui-locales";
import type { LocaleLoaders, Translation } from "./index";

type ChunkLoader = () => Promise<{ default: Translation }>;

/**
 * Maps glob-discovered chunks (`./locales/<tag>.ts` → loader) onto the shipping registry, in registry order.
 * Pure, so tests can pass synthetic maps without Vite. A registered locale without its chunk, or a chunk with
 * no registry row, is a build mistake and throws here instead of shipping a picker entry that cannot load.
 * Only the loader functions are touched; no chunk is imported.
 */
export function registryLoaders(modules: Record<string, ChunkLoader>, rows: readonly UiLocaleRow[] = UI_LOCALES): LocaleLoaders {
  const byTag = new Map(Object.entries(modules).map(([path, load]) => [path.replace(/^.*\/|\.ts$/g, ""), load]));
  const loaders: LocaleLoaders = {};
  for (const row of rows) {
    if (row.tag === SOURCE_LOCALE) continue;
    const load = byTag.get(row.tag);
    if (!load) throw new Error(`UI locale ${row.tag} is registered but locales/${row.tag}.ts is missing`);
    loaders[row.tag] = load;
    byTag.delete(row.tag);
  }
  const extra = [...byTag.keys()];
  if (extra.length) throw new Error(`locales/${extra.join(".ts, locales/")}.ts ${extra.length === 1 ? "has" : "have"} no row in src/shared/ui-locales.ts`);
  return loaders;
}
