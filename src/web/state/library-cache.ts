import type { LibraryPage } from "@shared/types";
import { api } from "@/lib/api";

// The Library's first page per filter set, kept for the session. Entering the Library shows the last result
// at once and refreshes it behind; the sidebar link starts the default fetch on hover so a first visit
// usually has data before it mounts. Lives outside the lazy Library chunk so the sidebar can import it.

export const DEFAULT_LIBRARY_QUERY = new URLSearchParams({ sort: "newest" }).toString();

const firstPages = new Map<string, LibraryPage>();
const inflight = new Map<string, Promise<LibraryPage>>();
let account: string | null = null;
let revision = 0;

/** Account changes also revoke requests still returning the previous account's private file list. */
export function setLibraryAccount(userId: string) {
  if (account === userId) return;
  account = userId;
  forgetLibraryPages();
}

export const cachedLibraryPage = (query: string) => firstPages.get(query);

/** Fetches a filter set's first page, sharing a request already in flight (a hover prefetch). */
export function fetchLibraryFirstPage(query: string): Promise<LibraryPage> {
  let pending = inflight.get(query);
  if (!pending) {
    const started = revision;
    pending = api<LibraryPage>(`/library?${query}`)
      .then((page) => {
        if (started === revision) firstPages.set(query, page);
        return page;
      })
      .finally(() => {
        if (inflight.get(query) === pending) inflight.delete(query);
      });
    inflight.set(query, pending);
  }
  return pending;
}

/** Only when nothing is cached: with a cached page, entering the Library refreshes it anyway. */
export function prefetchLibrary() {
  if (!firstPages.has(DEFAULT_LIBRARY_QUERY) && !inflight.has(DEFAULT_LIBRARY_QUERY)) void fetchLibraryFirstPage(DEFAULT_LIBRARY_QUERY).catch(() => {});
}

/** After deletions: a cached page would briefly show removed files on the next visit. */
export function forgetLibraryPages() {
  revision++;
  firstPages.clear();
  inflight.clear();
}
