/**
 * Flat thread tags. Tags are private labels: they never enter prompts, memory, search, exports,
 * archives, shares, or notifications. Stored lowercase, shown lowercase.
 */

export const MAX_TAGS_PER_THREAD = 10;
export const MAX_TAGS_IN_FILTER = 20;
export const MAX_TAG_PRESETS = 50;
export const MAX_TAG_LENGTH = 24;
export const MAX_TAG_PRESET_NAME = 40;

/** Letters, numbers, spaces, dot, underscore, and dash; must start with a letter or number. */
const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,23}$/u;

/** Trim, collapse inner whitespace to one space, lowercase, then validate. */
export function normalizeTag(raw: string): string | null {
  const normalized = raw.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized || normalized.length > MAX_TAG_LENGTH) return null;
  return TAG_PATTERN.test(normalized) ? normalized : null;
}

/** Valid unique tags in order, capped at the per-thread limit. Invalid entries are dropped. */
export function normalizeTags(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const value of list) {
    if (typeof value !== "string") continue;
    const tag = normalizeTag(value);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS_PER_THREAD) break;
  }
  return out;
}

export type TagMatch = "any" | "all";

/** A sidebar tag filter: show chats carrying any or all of `tags`. */
export interface TagFilter {
  tags: string[];
  match: TagMatch;
}

export const EMPTY_TAG_FILTER: TagFilter = { tags: [], match: "any" };

/** Validates a stored or submitted filter. Returns null for anything unusable. */
export function parseTagFilter(value: unknown): TagFilter | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { tags?: unknown; match?: unknown };
  const tags: string[] = [];
  if (Array.isArray(candidate.tags)) {
    for (const entry of candidate.tags) {
      if (typeof entry !== "string") continue;
      const tag = normalizeTag(entry);
      if (tag && !tags.includes(tag)) tags.push(tag);
      if (tags.length >= MAX_TAGS_IN_FILTER) break;
    }
  }
  const match: TagMatch = candidate.match === "all" ? "all" : candidate.match === "any" ? "any" : "any";
  if (candidate.match !== undefined && candidate.match !== "any" && candidate.match !== "all") return null;
  return { tags, match };
}

/** The filter predicate, shared by the sidebar and its tests. An empty filter matches everything. */
export function matchesTagFilter(tags: readonly string[], filter: TagFilter): boolean {
  if (!filter.tags.length) return true;
  return filter.match === "all" ? filter.tags.every((tag) => tags.includes(tag)) : filter.tags.some((tag) => tags.includes(tag));
}

export interface TagFilterPreset {
  id: string;
  name: string;
  filter: TagFilter;
  createdAt: number;
  updatedAt: number;
}

export interface TagCount {
  tag: string;
  count: number;
}
