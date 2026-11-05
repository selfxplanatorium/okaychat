import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { featureAllowed } from "../../permissions/guard.js";
import type { ChannelHistoricalAuthor } from "../../../shared/channels.js";
import type { RoomArchiveIdentity } from "../../../shared/room-archive.js";

/**
 * Imported identity evidence. A proof is an installation-local HMAC over the exported account id: it
 * lets this server recognize an account it exported, and nothing more. It is not a credential, a
 * signature of authorship, or a permission grant, and a copied proof can never restore edit rights or
 * "mine". Changing OKAYCHAT_SECRET or importing into another installation makes every proof unknown.
 *
 * Imported rows always keep author_id NULL; the validated local link is stored only in
 * channel_import_identities and is re-read, with the live channels feature, on every projection.
 */

const proofKey = createHmac("sha256", env.secret).update("okaychat:room-identity-key:v1").digest();

export function roomIdentityProof(localUserId: string): string {
  const payload = Buffer.from(JSON.stringify(["okaychat.room-identity.v1", localUserId]), "utf8");
  return createHmac("sha256", proofKey).update(payload).digest("base64url");
}

export function verifyRoomIdentityProof(localUserId: string, proof: string): boolean {
  const expected = Buffer.from(roomIdentityProof(localUserId), "utf8");
  const actual = Buffer.from(proof, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The live local account behind a proof, if the proof matches, the account exists, and it still has channels. */
export function recognizedLocalId(identity: Pick<RoomArchiveIdentity, "localId" | "localProof">): string | null {
  if (!identity.localId || !identity.localProof) return null;
  if (!verifyRoomIdentityProof(identity.localId, identity.localProof)) return null;
  if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(identity.localId)) return null;
  if (!featureAllowed(identity.localId, "channels")) return null;
  return identity.localId;
}

export interface IdentityResolution {
  /** identity key -> the validated local account id, or null. */
  local: Map<string, string | null>;
  known: Array<{ key: string; id: string; name: string }>;
  unknownKeys: string[];
}

/** Revalidates every identity at inspect, confirm, and review-digest refresh. */
export function resolveRoomIdentities(identities: readonly RoomArchiveIdentity[]): IdentityResolution {
  const local = new Map<string, string | null>();
  const known: IdentityResolution["known"] = [];
  const unknownKeys: string[] = [];
  for (const identity of identities) {
    const id = recognizedLocalId(identity);
    local.set(identity.key, id);
    if (id) {
      const name = (db.prepare("SELECT name FROM users WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? null;
      if (name !== null) known.push({ key: identity.key, id, name });
      else unknownKeys.push(identity.key);
    } else {
      unknownKeys.push(identity.key);
    }
  }
  return { local, known, unknownKeys };
}

/**
 * Batched projection for a history page. One query for the room's identity rows plus one permission
 * resolution per distinct account; a malformed or stale link degrades to the neutral label.
 */
export function importedAuthorLookup(channelId: string, identityIds: Iterable<string>): (identityId: string | null) => ChannelHistoricalAuthor | null {
  const ids = [...new Set([...identityIds].filter((id): id is string => typeof id === "string" && id.length > 0))];
  const authors = new Map<string, ChannelHistoricalAuthor>();
  if (ids.length) {
    const rows = db
      .prepare(
        `SELECT i.id, i.local_user_id, u.name FROM channel_import_identities i
         LEFT JOIN users u ON u.id = i.local_user_id
         WHERE i.channel_id = ? AND i.id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(channelId, ...ids) as Array<{ id: string; local_user_id: string | null; name: string | null }>;
    for (const row of rows) {
      if (row.local_user_id && row.name !== null && featureAllowed(row.local_user_id, "channels")) {
        authors.set(row.id, { kind: "known", id: row.local_user_id, name: row.name });
      } else {
        authors.set(row.id, { kind: "unknown" });
      }
    }
  }
  return (identityId) => (identityId ? authors.get(identityId) ?? { kind: "unknown" } : null);
}

/** A single-identity projection for a quote or a roster row. */
export function importedAuthor(channelId: string, identityId: string | null): ChannelHistoricalAuthor | null {
  return importedAuthorLookup(channelId, identityId ? [identityId] : [])(identityId);
}

export interface HistoricalIdentityRow {
  id: string;
  local_user_id: string | null;
  historical_role: "owner" | "moderator" | "member" | null;
  historical_joined_at: number | null;
}

/** Every stored historical identity for a room, bounded by the import cap. */
export function historyIdentityRows(channelId: string): HistoricalIdentityRow[] {
  return db
    .prepare("SELECT id, local_user_id, historical_role, historical_joined_at FROM channel_import_identities WHERE channel_id = ? ORDER BY id LIMIT ?")
    .all(channelId, 2_001) as unknown as HistoricalIdentityRow[];
}
