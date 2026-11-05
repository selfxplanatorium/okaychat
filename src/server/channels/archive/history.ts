import { db } from "../../db.js";
import { CHANNEL_REACTIONS, type ChannelHistoricalAuthor, type ChannelHistoricalMention, type ChannelHistoricalReaction, type ChannelImportedMeta, type ChannelImportedRosterPage } from "../../../shared/channels.js";
import { importedAuthor, importedAuthorLookup } from "./identity.js";

/**
 * Canonical imported provenance. Operational `channel_mentions` / `channel_reactions` are never
 * populated from an archive: historical relations live only in this JSON, mapped to freshly allocated
 * identity ids. A malformed payload fails closed to neutral history and never to native permissions.
 */

export interface ImportedProvenance {
  v: 1;
  authorIdentityId: string | null;
  quoteUnavailable: boolean;
  mentions: Array<{ identityId: string; start: number; end: number }>;
  reactions: Array<{ identityId: string; emoji: string; createdAt: number }>;
}

export const NEUTRAL_PROVENANCE: ImportedProvenance = { v: 1, authorIdentityId: null, quoteUnavailable: false, mentions: [], reactions: [] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 200;

export function importedProvenanceJson(value: ImportedProvenance): string {
  return JSON.stringify({
    v: 1,
    authorIdentityId: value.authorIdentityId,
    quoteUnavailable: value.quoteUnavailable,
    mentions: value.mentions.map((mention) => ({ identityId: mention.identityId, start: mention.start, end: mention.end })),
    reactions: value.reactions.map((reaction) => ({ identityId: reaction.identityId, emoji: reaction.emoji, createdAt: reaction.createdAt })),
  });
}

/** Never throws. A broken row is imported history with no author/mentions/reactions. */
export function parseImportedProvenance(raw: string | null): ImportedProvenance {
  if (!raw) return NEUTRAL_PROVENANCE;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.v !== 1 || typeof value.quoteUnavailable !== "boolean") return NEUTRAL_PROVENANCE;
    const authorIdentityId = value.authorIdentityId === null ? null : id(value.authorIdentityId) ? value.authorIdentityId : undefined;
    if (authorIdentityId === undefined) return NEUTRAL_PROVENANCE;
    if (!Array.isArray(value.mentions) || !Array.isArray(value.reactions)) return NEUTRAL_PROVENANCE;
    if (value.mentions.length > 20 || value.reactions.length > 3) return NEUTRAL_PROVENANCE;
    const mentions = value.mentions.map((entry) => {
      if (!isRecord(entry) || !id(entry.identityId) || !Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end)) throw new Error("bad mention");
      return { identityId: entry.identityId, start: entry.start as number, end: entry.end as number };
    });
    const reactions = value.reactions.map((entry) => {
      if (!isRecord(entry) || !id(entry.identityId) || typeof entry.emoji !== "string" || !(CHANNEL_REACTIONS as readonly string[]).includes(entry.emoji)) {
        throw new Error("bad reaction");
      }
      if (!Number.isSafeInteger(entry.createdAt)) throw new Error("bad reaction time");
      return { identityId: entry.identityId, emoji: entry.emoji, createdAt: entry.createdAt as number };
    });
    return { v: 1, authorIdentityId, quoteUnavailable: value.quoteUnavailable, mentions, reactions };
  } catch {
    return NEUTRAL_PROVENANCE;
  }
}

export interface ImportedMetaRow {
  v: 1;
  sourceCreatedAt: number;
  sourceUpdatedAt: number;
  sourceArchivedAt: number | null;
  sourceVisibility: ChannelImportedMeta["sourceVisibility"];
  importedAt: number;
}

export function importedMetaJson(value: ImportedMetaRow): string {
  return JSON.stringify(value);
}

export function parseImportedMeta(raw: string | null): ChannelImportedMeta | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.v !== 1) return null;
    for (const field of ["sourceCreatedAt", "sourceUpdatedAt", "importedAt"] as const) {
      if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) return null;
    }
    if (value.sourceArchivedAt !== null && (!Number.isSafeInteger(value.sourceArchivedAt) || (value.sourceArchivedAt as number) < 0)) return null;
    if (value.sourceVisibility !== "public" && value.sourceVisibility !== "private" && value.sourceVisibility !== "group") return null;
    return {
      sourceCreatedAt: value.sourceCreatedAt as number,
      sourceUpdatedAt: value.sourceUpdatedAt as number,
      sourceArchivedAt: value.sourceArchivedAt as number | null,
      sourceVisibility: value.sourceVisibility,
      importedAt: value.importedAt as number,
    };
  } catch {
    return null;
  }
}

/** Historical mentions render as read-only spans. Unknown identities stay neutral. */
export function historicalMentionsOf(
  channelId: string,
  provenance: ImportedProvenance,
  lookup: (identityId: string | null) => ChannelHistoricalAuthor | null = importedAuthorLookup(channelId, provenance.mentions.map((mention) => mention.identityId)),
): ChannelHistoricalMention[] {
  if (!provenance.mentions.length) return [];
  return provenance.mentions.map((mention) => ({
    start: mention.start,
    end: mention.end,
    author: lookup(mention.identityId) ?? { kind: "unknown" },
  }));
}

/** Original counts only; never merged with live reactions, never toggleable. */
export function historicalReactionsOf(provenance: ImportedProvenance): ChannelHistoricalReaction[] {
  const counts = new Map<string, number>();
  for (const reaction of provenance.reactions) counts.set(reaction.emoji, (counts.get(reaction.emoji) ?? 0) + 1);
  return CHANNEL_REACTIONS.filter((emoji) => counts.has(emoji)).map((emoji) => ({ emoji, count: counts.get(emoji)! }));
}

/** The separate imported roster. It never increases memberCount or enters the mention picker. */
export function importedRosterPage(channelId: string, after: string | null, limit: number): ChannelImportedRosterPage {
  const rows = db
    .prepare(
      `SELECT i.id, i.historical_role, i.historical_joined_at, u.id AS live_id, u.name
       FROM channel_import_identities i LEFT JOIN users u ON u.id = i.local_user_id
       WHERE i.channel_id = ? AND (? IS NULL OR i.id > ?)
         AND i.historical_role IS NOT NULL
       ORDER BY i.id LIMIT ?`,
    )
    .all(channelId, after, after, limit + 1) as Array<{ id: string; historical_role: string | null; historical_joined_at: number | null; live_id: string | null; name: string | null }>;
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({
      key: row.id,
      author: importedAuthor(channelId, row.id) ?? { kind: "unknown" },
      role: row.historical_role === "owner" || row.historical_role === "moderator" || row.historical_role === "member" ? row.historical_role : "member",
      joinedAt: row.historical_joined_at ?? 0,
    })),
    nextAfter: rows.length > limit ? page.at(-1)!.id : null,
  };
}
