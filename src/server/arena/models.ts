import { getCreditBalance } from "../credits/store.js";
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
    const old = db.prepare("SELECT id,fingerprint,label FROM arena_models WHERE model_ref=? AND epoch=? AND scope='public'").get(entry.ref, entry.epoch) as { id: string; fingerprint: string; label: string } | undefined;
    if (old) {
      if (old.fingerprint !== fingerprint) throw new Error("Arena publication requires a new epoch");
      if (old.label !== entry.label) {
        db.prepare("UPDATE arena_models SET label=? WHERE id=?").run(entry.label, old.id);
        db.prepare("UPDATE arena_rating_meta SET revision=revision+1 WHERE id=1").run();
      }
      return old.id;
    }
    const id = newId("arp");
    db.prepare("INSERT INTO arena_models(id,scope,model_ref,label,epoch,fingerprint,created_at) VALUES (?,'public',?,?,?,?,?)").run(id, entry.ref, entry.label, entry.epoch, fingerprint, Date.now());
    return id;
  });
}

/** Uniform pair without replacement, followed by a separate fair assignment bit. */
export function samplePair<T>(pool: readonly T[], rng: (max: number) => number = randomInt): readonly [T, T] {
  if (pool.length < 2 || new Set(pool).size !== pool.length) throw new Error("Invalid Arena pool");
  const draw = (max: number) => {
    const n = rng(max);
    if (!Number.isInteger(n) || n < 0 || n >= max) throw new Error("Invalid Arena random draw");
    return n;
  };
  const first = draw(pool.length), offset = draw(pool.length - 1);
  const second = offset >= first ? offset + 1 : offset;
  return draw(2) === 0 ? [pool[first]!, pool[second]!] : [pool[second]!, pool[first]!];
}

// Active publications are process-local configuration; durable rows preserve historical epoch identity.
import { getConnection, getSharedConnection, listModels, listModelsForConnection, resolveModel } from "../catalog/providers.js";
import type { Connection } from "../catalog/providers.js";
import type { ModelInfo } from "../../shared/types.js";
import { assertFeature, assertModelAllowed, featureAllowed } from "../permissions/guard.js";
import { resolvePermissions } from "../permissions/resolve.js";
import { AppError } from "../errors.js";
export interface ArenaTarget { model: ModelInfo; conn: Connection; fingerprint: string; publicId?: string; publicLabel?: string }
let publicationState: { signature: string; checkedAt: number; active: Map<string, { id: string; fingerprint: string; label: string }>; enabled: boolean } | undefined;
let publicationWork: Promise<void> | undefined;
export function targetFingerprint(model: ModelInfo, conn: Connection): string {
  return connectionFingerprint({ providerId: model.providerId, format: model.format, baseUrl: conn.baseURL ?? model.baseURL ?? (model.format === "ollama" ? "http://127.0.0.1:11434" : "https://unavailable.invalid"), modelId: model.id });
}
export function arenaUnavailable(reason = "arena_invalid", status = 409): AppError {
  return new AppError({ code: status === 404 ? "not_found" : status === 403 ? "forbidden" : status === 400 ? "validation" : "conflict", status, message: "Arena request unavailable.", details: { reason } });
}
export async function refreshPublications(): Promise<void> {
  if (publicationWork) return publicationWork;
  const config = process.env.OKAYCHAT_ARENA_PUBLIC_MODELS ?? "[]";
  let signature = config;
  try {
    signature = JSON.stringify([config, parsePublications(config).map(entry => {
      const conn = getSharedConnection(entry.ref.slice(0, entry.ref.indexOf("/")));
      return [entry.ref, conn?.baseURL ?? null, conn?.enabled ?? false];
    })]);
  } catch { /* Invalid config remains disabled until it changes. */ }
  if (publicationState?.signature === signature && Date.now() - publicationState.checkedAt < 10_000) return;
  publicationWork = (async () => {
    const active = new Map<string, { id: string; fingerprint: string; label: string }>();
    let enabled = false;
    try {
      const entries = parsePublications(config);
      for (const entry of entries) {
        const providerId = entry.ref.slice(0, entry.ref.indexOf("/"));
        const conn = getSharedConnection(providerId);
        if (!conn?.enabled) throw new Error("Unavailable publication");
        const model = (await listModelsForConnection(conn)).find(m => m.ref === entry.ref);
        if (!model) throw new Error("Unavailable publication");
        const fingerprint = targetFingerprint(model, conn);
        active.set(entry.ref, { id: registerPublicModel(entry, fingerprint), fingerprint, label: entry.label });
      }
      enabled = entries.length > 0;
    } catch { active.clear(); }
    const oldKeys = publicationState ? [...publicationState.active.values()].map(v => v.id).sort().join(",") : "";
    const nextKeys = [...active.values()].map(v => v.id).sort().join(",");
    if (oldKeys !== nextKeys) db.prepare("UPDATE arena_rating_meta SET revision=revision+1 WHERE id=1").run();
    publicationState = { signature, checkedAt: Date.now(), active, enabled };
  })().finally(() => { publicationWork = undefined; });
  return publicationWork;
}
export function publicModelIds(): ReadonlySet<string> { return new Set([...publicationState?.active.values() ?? []].map(v => v.id)); }
export function publicEnabled(): boolean { return publicationState?.enabled === true; }
export async function eligibleTargets(userId: string, mode: "personal" | "public", refs?: readonly string[]): Promise<ArenaTarget[]> {
  assertFeature(userId, "arena");
  if ((resolvePermissions(userId).buckets.aggregate.concurrentTurns ?? 4) < 2) throw arenaUnavailable("arena_concurrency");
  await refreshPublications();
  if (mode === "public" && !publicEnabled()) throw arenaUnavailable("arena_public_disabled");
  const models = refs ? refs.map(ref => ({ ref })) : await listModels(userId);
  const targets: ArenaTarget[] = [];
  for (const item of models) {
    try {
      assertFeature({ userId, modelRef: item.ref }, "arena");
      const { model, conn } = await resolveModel(userId, item.ref);
      const fingerprint = targetFingerprint(model, conn), published = publicationState?.active.get(model.ref);
      if (mode === "public" && (!conn.shared || !published || published.fingerprint !== fingerprint)) throw arenaUnavailable("arena_public_connection");
      targets.push({ model, conn, fingerprint, ...(published && conn.shared && published.fingerprint === fingerprint ? { publicId: published.id, publicLabel: published.label } : {}) });
    } catch { if (refs) throw arenaUnavailable("arena_model_revoked", 403); }
  }
  return targets;
}
export function guardTarget(userId: string, target: ArenaTarget, mode: "personal" | "public"): void {
  assertFeature(userId, "arena"); assertFeature({ userId, modelRef: target.model.ref }, "arena"); assertModelAllowed(userId, target.model.ref);
  const current = getConnection(userId, target.model.providerId);
  if (!current?.enabled || current.shared !== target.conn.shared || targetFingerprint(target.model, current) !== target.fingerprint) throw arenaUnavailable("arena_model_revoked", 403);
  if (mode === "public" && (!current.shared || publicationState?.active.get(target.model.ref)?.id !== target.publicId || publicationState?.active.get(target.model.ref)?.fingerprint !== target.fingerprint)) throw arenaUnavailable("arena_public_connection", 403);
}
export async function arenaOptions(userId: string) {
  let targets: ArenaTarget[] = [], disabledReason: string | undefined;
  try { targets = await eligibleTargets(userId, "personal"); } catch { disabledReason = featureAllowed(userId, "arena") ? "arena_concurrency" : "arena_disabled"; }
  const balance = getCreditBalance(userId);
  if (!disabledReason && balance.creditTokens !== null) {
    if (balance.status === "exhausted") disabledReason = "token_credit_exhausted";
    else if (balance.status === "usage_unknown") disabledReason = "token_credit_usage_unknown";
    else if (balance.activeOperations > 0) disabledReason = "token_credit_busy";
  }
  return { modes: { personal: targets.length >= 2, public: publicEnabled() && targets.filter(t => t.publicId).length >= 2 }, models: targets.map(t => ({ ref: t.model.ref, name: t.model.name, publicEligible: !!t.publicId })), limits: { maxPrompt: 20000, maxContents: 20, concurrentPanes: 2 }, ...(disabledReason ? { disabledReason } : targets.length < 2 ? { disabledReason: "arena_pool_small" } : {}) };
}
