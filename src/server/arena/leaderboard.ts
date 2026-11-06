import { listModels, getConnection } from "../catalog/providers.js";
import { targetFingerprint } from "./models.js";
import { Worker } from "node:worker_threads";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import type { ArenaChoice, LeaderboardPage, LeaderboardRow } from "../../shared/arena.js";
import type { RatingBallot } from "./rating.js";
import { db } from "../db.js";
import { arenaUnavailable, publicEnabled, publicModelIds, refreshPublications } from "./models.js";
import { ratingRevision } from "./store.js";
const querySchema = z.strictObject({ scope: z.enum(["mine", "global"]).default("global"), window: z.enum(["all", "30d"]).default("all"), sort: z.enum(["rank", "rating", "battles", "wins", "winRate"]).default("rank"), direction: z.enum(["asc", "desc"]).default("asc"), q: z.string().max(120).default(""), provisional: z.enum(["include", "exclude"]).default("include"), offset: z.coerce.number().int().min(0).max(10000).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) });
export function leaderboardQuery(input: Record<string, string>, publicOnly = false) {
  if (publicOnly && "scope" in input) throw arenaUnavailable("arena_invalid", 400);
  return querySchema.parse({ ...input, ...(publicOnly ? { scope: "global" } : {}) });
}
type Query = ReturnType<typeof leaderboardQuery>;
let worker: Worker | undefined, sequence = 0;
const pending = new Map<number, { resolve: (rows: LeaderboardRow[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
function replay(ballots: RatingBallot[]): Promise<LeaderboardRow[]> {
  if (!worker) {
    worker = import.meta.url.endsWith(".ts") ? new Worker(`import('tsx/esm/api').then(({register})=>{register();return import(${JSON.stringify(new URL("./rating-worker.ts", import.meta.url).href)})})`, { eval: true }) : new Worker(new URL("./rating-worker.js", import.meta.url));
    worker.unref();
    worker.on("message", (message: { id: number; rows?: LeaderboardRow[]; error?: boolean }) => {
      const job = pending.get(message.id); if (!job) return;
      pending.delete(message.id); clearTimeout(job.timer);
      if (message.rows && !message.error) job.resolve(message.rows); else job.reject(arenaUnavailable("arena_board_unavailable", 503));
      if (!pending.size) worker?.unref();
    });
    const failed = () => { worker = undefined; for (const job of pending.values()) { clearTimeout(job.timer); job.reject(arenaUnavailable("arena_board_unavailable", 503)); } pending.clear(); };
    worker.on("error", failed); worker.on("exit", failed);
  }
  worker.ref();
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { const old = worker; void old?.terminate(); }, 15_000); timer.unref?.();
    pending.set(id, { resolve, reject, timer }); worker!.postMessage({ id, ballots });
  });
}
const cache = new Map<string, { rows: LeaderboardRow[]; revision: number; asOf: number }>();
const builds = new Map<string, Promise<{ rows: LeaderboardRow[]; revision: number; asOf: number }>>();
interface BallotRow { seq: number; choice: ArenaChoice; created_at: number; a_key: string; a_label: string; b_key: string; b_label: string; a_public: string | null; b_public: string | null }
async function snapshot(userId: string | undefined, q: Query) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const revision = ratingRevision(), asOf = q.window === "30d" ? Math.floor(Date.now() / 60000) * 60000 : Date.now();
    const key = JSON.stringify([q.scope, q.scope === "mine" ? userId : "", q.window, revision, q.window === "30d" ? asOf : 0]);
    const hit = cache.get(key); if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
    let build = builds.get(key);
    if (!build) {
      if (builds.size >= 2) throw arenaUnavailable("arena_board_unavailable", 503);
      build = (async () => {
        const max = (db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM arena_votes").get() as { n: number }).n;
        const published = publicModelIds(), ballots: RatingBallot[] = [];
        let cursor = 0;
        while (cursor < max) {
          const rows = db.prepare(`SELECT v.seq,v.choice,v.created_at,a.personal_model_id AS a_key,ma.label AS a_label,b.personal_model_id AS b_key,mb.label AS b_label,a.public_model_id AS a_public,b.public_model_id AS b_public
            FROM arena_votes v JOIN arena_battles bt ON bt.id=v.battle_id JOIN arena_panes a ON a.battle_id=bt.id AND a.side='A' JOIN arena_panes b ON b.battle_id=bt.id AND b.side='B'
            JOIN arena_models ma ON ma.id=a.personal_model_id JOIN arena_models mb ON mb.id=b.personal_model_id
            WHERE v.seq>? AND v.seq<=? AND (?='global' OR v.voter_id=?) ORDER BY v.seq LIMIT 1000`).all(cursor, max, q.scope, userId ?? "") as unknown as BallotRow[];
          if (!rows.length) break;
          for (const r of rows) {
            cursor = r.seq;
            if (q.window === "30d" && (r.created_at < asOf - 30 * 86400_000 || r.created_at > asOf)) continue;
            if (q.scope === "global" && (!r.a_public || !r.b_public || !published.has(r.a_public) || !published.has(r.b_public))) continue;
            const model = (personal: string, label: string, publicId: string | null) => {
              if (q.scope === "mine") return { key: personal, label, available: false };
              const p = db.prepare("SELECT label FROM arena_models WHERE id=?").get(publicId!) as { label: string };
              return { key: publicId!, label: p.label, available: true };
            };
            ballots.push({ seq: r.seq, choice: r.choice, a: model(r.a_key, r.a_label, r.a_public), b: model(r.b_key, r.b_label, r.b_public) });
          }
          await setImmediate();
        }
        return { rows: await replay(ballots), revision, asOf };
      })().finally(() => builds.delete(key));
      builds.set(key, build);
    }
    const result = await build;
    if (ratingRevision() !== result.revision) continue;
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(key, result); return result;
  }
  throw arenaUnavailable("arena_board_unavailable", 503);
}
export async function leaderboard(userId: string | undefined, q: Query): Promise<LeaderboardPage> {
  if (q.scope === "mine" && !userId) throw arenaUnavailable("arena_not_found", 404);
  await refreshPublications();
  if (q.scope === "global" && !publicEnabled()) throw arenaUnavailable("arena_public_disabled", 404);
  const result = await snapshot(userId, q);
  const needle = q.q.toLowerCase();
  let rows = result.rows;
  if (q.scope === "mine" && userId) {
    const available = await listModels(userId).catch(() => []);
    rows = rows.map(row => {
      const identity = db.prepare("SELECT model_ref,fingerprint FROM arena_models WHERE id=? AND user_id=?").get(row.modelKey, userId) as { model_ref: string; fingerprint: string } | undefined;
      const model = identity ? available.find(m => m.ref === identity.model_ref) : undefined;
      const conn = model ? getConnection(userId, model.providerId) : undefined;
      return { ...row, available: !!(model && conn && targetFingerprint(model, conn) === identity?.fingerprint) };
    });
  }
  const filtered = rows.filter(row => (q.provisional !== "exclude" || !row.provisional) && (!needle || row.label.toLowerCase().includes(needle) || row.modelKey.toLowerCase().includes(needle)));
  filtered.sort((a, b) => {
    const x = a[q.sort], y = b[q.sort];
    const delta = x === null ? y === null ? 0 : 1 : y === null ? -1 : (x - y) * (q.direction === "asc" ? 1 : -1);
    return delta || (a.modelKey < b.modelKey ? -1 : a.modelKey > b.modelKey ? 1 : 0);
  });
  if (ratingRevision() !== result.revision) throw arenaUnavailable("arena_board_unavailable", 503);
  return { ratingVersion: "elo-v1", scope: q.scope, window: q.window, asOf: result.asOf, revision: result.revision, rows: filtered.slice(q.offset, q.offset + q.limit), total: filtered.length, offset: q.offset, limit: q.limit, minimumBattles: 20, k: 32 };
}
