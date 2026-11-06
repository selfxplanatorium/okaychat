import { randomInt } from "node:crypto";
import { z } from "zod";
import { db, tx } from "../db.js";
import { newId, sha256 } from "../crypto.js";

const publication = z.strictObject({
  ref: z.string().min(1).max(500), label: z.string().trim().min(1).max(120).regex(/^[^\p{Cc}\p{Cf}]+$/u),
  epoch: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
});
export type ArenaPublication = z.infer<typeof publication>;
export function parsePublications(input: string | undefined): ArenaPublication[] {
  const rows = z.array(publication).max(100).parse(JSON.parse(input ?? "[]") as unknown);
  if (new Set(rows.map(row => row.ref)).size !== rows.length) throw new Error("Duplicate Arena publication");
  return rows;
}

/** The caller must supply the resolved connection, never client-claimed connection metadata. */
export function connectionFingerprint(input: { providerId: string; format: string; baseUrl: string; modelId: string }): string {
  const url = new URL(input.baseUrl);
  if (url.username || url.password || url.hash) throw new Error("Invalid Arena connection URL");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return sha256(JSON.stringify([input.providerId, input.format, url.href, input.modelId]));
}

export function registerPersonalModel(userId: string, ref: string, label: string, fingerprint: string): string {
  return tx(() => {
    const old = db.prepare("SELECT id FROM arena_models WHERE user_id=? AND model_ref=? AND fingerprint=? AND scope='personal'").get(userId, ref, fingerprint) as { id: string } | undefined;
    if (old) return old.id;
    const id = newId("arm");
    db.prepare("INSERT INTO arena_models(id,user_id,scope,model_ref,label,fingerprint,created_at) VALUES (?,?,'personal',?,?,?,?)").run(id, userId, ref, label, fingerprint, Date.now());
    return id;
  });
}

export function registerPublicModel(entry: ArenaPublication, fingerprint: string): string {
  return tx(() => {
    const old = db.prepare("SELECT id,fingerprint FROM arena_models WHERE model_ref=? AND epoch=? AND scope='public'").get(entry.ref, entry.epoch) as { id: string; fingerprint: string } | undefined;
    if (old) {
      if (old.fingerprint !== fingerprint) throw new Error("Arena publication requires a new epoch");
      return old.id;
    }
    const id = newId("arp");
    db.prepare("INSERT INTO arena_models(id,scope,model_ref,label,epoch,fingerprint,created_at) VALUES (?,'public',?,?,?,?,?)").run(id, entry.ref, entry.label, entry.epoch, fingerprint, Date.now());
    return id;
  });
}

/** Uniform pair without replacement, followed by a separate fair assignment bit. */
export function samplePair<T>(pool: readonly T[], rng: (max: number) => number = randomInt): readonly [T, T] {
  if (pool.length < 2 || pool.length > 100 || new Set(pool).size !== pool.length) throw new Error("Invalid Arena pool");
  const draw = (max: number) => {
    const n = rng(max);
    if (!Number.isInteger(n) || n < 0 || n >= max) throw new Error("Invalid Arena random draw");
    return n;
  };
  const first = draw(pool.length), offset = draw(pool.length - 1);
  const second = offset >= first ? offset + 1 : offset;
  return draw(2) === 0 ? [pool[first]!, pool[second]!] : [pool[second]!, pool[first]!];
}
