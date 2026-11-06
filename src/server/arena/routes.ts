import { resolveModel } from "../catalog/providers.js";
import type { BattleView } from "../../shared/arena.js";
import { HTTPException } from "hono/http-exception";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import type { AppEnv } from "../auth.js";
import { db } from "../db.js";
import { AppError } from "../errors.js";
import { featureAllowed } from "../permissions/guard.js";
import { arenaOptions, arenaUnavailable, targetFingerprint } from "./models.js";
import { castVote, discardContent, getBattle } from "./store.js";
import { attachBattle, battleByMutation, startBattle, stopBattle } from "./worker.js";
import { leaderboard, leaderboardQuery } from "./leaderboard.js";

const windows = new Map<string, { n: number; reset: number }>();
function rate(key: string, max: number): void {
  const now = Date.now(); let row = windows.get(key);
  if (!row || row.reset <= now) { if (windows.size > 10000) windows.clear(); row = { n: 0, reset: now + 60000 }; windows.set(key, row); }
  if (++row.n > max) throw arenaUnavailable("arena_rate_limited", 429);
}
async function json(c: Context<AppEnv>, max = 1024): Promise<unknown> {
  if (!c.req.header("content-type")?.startsWith("application/json")) throw arenaUnavailable("arena_invalid", 400);
  const bytes = await c.req.text();
  if (Buffer.byteLength(bytes) > max) throw arenaUnavailable("arena_invalid", 413);
  try { return JSON.parse(bytes) as unknown; } catch { throw arenaUnavailable("arena_invalid", 400); }
}
function reasonOf(error: unknown): string | undefined {
  if (!(error instanceof AppError) || typeof error.details !== "object" || error.details === null || !("reason" in error.details)) return;
  return typeof error.details.reason === "string" ? error.details.reason : undefined;
}
function boundary(error: Error, c: Context) {
  const status = error instanceof AppError ? error.status : error instanceof HTTPException ? error.status : error instanceof z.ZodError ? 400 : 500;
  const allowed = error instanceof AppError && error.code.startsWith("token_credit_") ? error.code : error instanceof AppError && error.code === "storage_quota" ? "storage_quota" : status === 429 ? "rate_limited" : status === 503 ? "service_unavailable" : error instanceof AppError ? error.code : status === 400 ? "validation" : "unknown";
  // Never forward identifying errors, model/provider fields, or upstream prose on this transport.
  const reason = reasonOf(error) && /^arena_[a-z_]+$/.test(reasonOf(error)!) ? reasonOf(error)! : allowed;
  if (status === 503 || status === 429) c.header("Retry-After", "1");
  return c.json({ error: "Arena request unavailable.", message: "Arena request unavailable.", code: allowed, reason }, status as 400 | 403 | 404 | 409 | 413 | 429 | 503 | 500);
}
async function ownerView(userId: string, view: BattleView): Promise<BattleView> {
  if (view.visibility === "blind") return view;
  for (const pane of view.panes) {
    try {
      const resolved = await resolveModel(userId, pane.model.ref);
      const identity = db.prepare("SELECT fingerprint FROM arena_models WHERE id=? AND user_id=?").get(pane.model.key, userId) as { fingerprint: string } | undefined;
      pane.model.available = targetFingerprint(resolved.model, resolved.conn) === identity?.fingerprint;
    } catch { pane.model.available = false; }
  }
  return view;
}
export const arenaRoutes = new Hono<AppEnv>()
  .onError(boundary)
  .use("*", bodyLimit({ maxSize: 128 * 1024, onError: c => c.json({ error: "Arena request unavailable.", code: "arena_invalid" }, 413) }))
  .use("*", async (c, next) => { c.header("Cache-Control", "private, no-store"); rate(`${c.get("user").id}:${c.req.method === "GET" ? "read" : "write"}`, c.req.method === "GET" ? 120 : 20); await next(); })
  .get("/options", async c => c.json(await arenaOptions(c.get("user").id)))
  .post("/battles", async c => { const result = await startBattle(c.get("user").id, await json(c, 128 * 1024)); return c.json({ battle: result.battle }, result.created ? 201 : 200); })
  .get("/battles", c => {
    const userId = c.get("user").id, mutation = c.req.query("mutationId");
    if (mutation !== undefined) { if (!mutation.length || mutation.length > 100) throw arenaUnavailable("arena_invalid", 400); return c.json({ battle: battleByMutation(userId, mutation) }); }
    return c.json({ battles: db.prepare("SELECT id,mode,state,created_at AS createdAt FROM arena_battles WHERE user_id=? AND content_expires_at>? ORDER BY created_at DESC,id DESC LIMIT 20").all(userId, Date.now()) });
  })
  .get("/battles/:id", async c => c.json({ battle: await ownerView(c.get("user").id, getBattle(c.get("user").id, c.req.param("id"))) }))
  .get("/battles/:id/events", c => {
    const stream = attachBattle(c.get("user").id, c.req.param("id"));
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" } });
  })
  .post("/battles/:id/stop", async c => { z.strictObject({}).parse(await json(c)); return c.json({ battle: stopBattle(c.get("user").id, c.req.param("id")) }); })
  .post("/battles/:id/vote", async c => {
    const { choice } = z.strictObject({ choice: z.enum(["A", "B", "tie", "both_bad"]) }).parse(await json(c));
    const userId = c.get("user").id, id = c.req.param("id");
    try {
      const result = castVote(userId, id, choice, featureAllowed(userId, "arena"));
      const battle = await ownerView(userId, result.battle);
      return c.json({ ...result, battle, ...(battle.visibility === "revealed" ? { vote: battle.vote } : {}) });
    }
    catch (error) {
      if (reasonOf(error) === "arena_vote_locked") return c.json({ battle: getBattle(userId, id), code: "arena_vote_locked" }, 409);
      throw error;
    }
  })
  .delete("/battles/:id/content", async c => { if (c.req.header("content-length") !== "0" && c.req.header("content-type")) z.strictObject({}).parse(await json(c)); discardContent(c.get("user").id, c.req.param("id")); return c.json({ ok: true }); })
  .get("/leaderboard", async c => c.json(await leaderboard(c.get("user").id, leaderboardQuery(c.req.query()))));

export const publicArenaRoutes = new Hono()
  .onError(boundary)
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    let address = "unknown"; try { address = getConnInfo(c).remote.address ?? "unknown"; } catch { /* Isolated HTTP tests have no socket. */ }
    rate(`public:${address}`, 60); await next();
  })
  .get("/leaderboard", async c => c.json(await leaderboard(undefined, leaderboardQuery(c.req.query(), true))));

/** Test seam; never exposed through HTTP. */
export function resetArenaRouteLimits(): void { windows.clear(); }
