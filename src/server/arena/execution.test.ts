import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
const dir = mkdtempSync(path.join(os.tmpdir(), "okaychat-arena-execution-"));
process.env.OKAYCHAT_DATA_DIR = dir; process.env.OKAYCHAT_SECRET = "arena-execution-test-secret-not-for-production";
writeFileSync(path.join(dir, "models-dev.json"), JSON.stringify({ fetchedAt: Date.now(), data: { openai: { id: "openai", name: "Fixture", npm: "@ai-sdk/openai-compatible", api: "https://fixture.invalid/v1", models: Object.fromEntries(["fixture-one", "fixture-two"].map(id => [id, { id, name: `PRIVATE-${id}`, modalities: { input: ["text"], output: ["text"] }, limit: { context: 32000, output: 4096 }, cost: { input: 1, output: 2 } }])) } } }));
const { db } = await import("../db.js");
const { sha256 } = await import("../crypto.js");
const { requireUser } = await import("../auth.js");
const { saveConnection } = await import("../catalog/providers.js");
const { arenaRoutes, publicArenaRoutes, resetArenaRouteLimits } = await import("./routes.js");
const { getCreditBalance, admitCreditRoot, closeCreditRoot, ensureCreditAccount } = await import("../credits/store.js");
const { setArenaTestDeadlines } = await import("./worker.js");
const { activeTurnCount, reserveTurn } = await import("../turn-slots.js");
const { writePolicy } = await import("../permissions/store.js");
const { usageSummary, goWindows, hiddenArenaRequests } = await import("../usage.js");
const { setModelAccessPolicies } = await import("../entitlements.js");
let caseScope = 0;
let calls = 0, active = 0, maxActive = 0, failure = false, missingUsage = false, delay = 100;
const provider = createServer(async (req, res) => {
  if (req.url === "/v1/models") return res.setHeader("content-type", "application/json").end(JSON.stringify({ data: [{ id: "fixture-one" }, { id: "fixture-two" }] }));
  if (req.url !== "/v1/chat/completions") return res.writeHead(404).end();
  let body = ""; for await (const chunk of req) body += String(chunk);
  const input = JSON.parse(body) as { model: string };
  // An aborted fetch can reach this fixture after the next test starts under full-suite load.
  // Attribute network observations to the prompt scope, while the real ledger remains authoritative.
  const tracked = body.includes(`[arena-case-${caseScope}]`);
  if (tracked) { calls++; active++; maxActive = Math.max(active, maxActive); }
  res.on("close", () => { if (tracked) active--; });
  if (failure && input.model === "fixture-two") return res.writeHead(422).end("PRIVATE-provider-failure");
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta: object, finish_reason: string | null = null, usage?: object) => res.write(`data: ${JSON.stringify({ id: "PRIVATE-receipt", model: input.model, object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
  send({ role: "assistant", reasoning_content: "PRIVATE-REASONING" });
  await new Promise(resolve => setTimeout(resolve, delay));
  if (res.destroyed) return;
  send({ content: "A useful final answer." });
  send({}, "stop", missingUsage ? undefined : { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }); res.end("data: [DONE]\n\n");
});
await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
const port = (provider.address() as { port: number }).port;
for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES (?,?,?,'x','admin',1)").run(id, `${id}@example.test`, id);
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)").run(sha256(id), id, Date.now() + 3600_000); ensureCreditAccount(id);
}
saveConnection(null, "openai", { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "fixture" });
process.env.OKAYCHAT_ARENA_PUBLIC_MODELS = JSON.stringify(["fixture-one", "fixture-two"].map(id => ({ ref: `openai/${id}`, label: `Published ${id}`, epoch: "test-v1" })));
const publicConfig = process.env.OKAYCHAT_ARENA_PUBLIC_MODELS;
const app = new Hono().use("*", csrf()).use(requireUser).route("/api/arena", arenaRoutes);
const pub = new Hono().route("/api/public/arena", publicArenaRoutes);
const request = (url: string, method = "GET", body?: object, user = "alice") => {
  const payload = body && "prompt" in body && typeof body.prompt === "string" ? { ...body, prompt: `[arena-case-${caseScope}] ${body.prompt}` } : body;
  return app.request(`http://localhost/api/arena${url}`, { method, headers: { cookie: `okaychat_session=${user}`, origin: "http://localhost", ...(payload ? { "content-type": "application/json" } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
};
// Use the real auth cookie name from auth.ts rather than a provider bearer credential.

let nextMutation = 0;
async function start(mode = "personal") { const response = await request("/battles", "POST", { prompt: "Say something useful", mode, mutationId: `m-${++nextMutation}` }); const data = await response.json() as { battle: { id: string } }; return { response, data }; }
async function drain(id: string) { const response = await request(`/battles/${id}/events`); assert.equal(response.status, 200); return response.text(); }
after(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); db.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  caseScope++;
  setArenaTestDeadlines();
  process.env.OKAYCHAT_ARENA_PUBLIC_MODELS = publicConfig;
  resetArenaRouteLimits(); calls = 0; maxActive = 0; failure = false; missingUsage = false; delay = 100;
  db.exec("DELETE FROM arena_battles; DELETE FROM usage; DELETE FROM token_credit_requests; DELETE FROM token_credit_roots; DELETE FROM permission_policies; DELETE FROM permission_leases; DELETE FROM provider_model_grants; DELETE FROM provider_model_policies; DELETE FROM provider_connections; UPDATE token_credit_accounts SET credit_tokens=10000,consumed_tokens=0,unknown_requests=0; UPDATE arena_rating_meta SET revision=revision+1");
});
test("two concurrent calls share one finite root, remain blind through usage, and reveal after one vote", async () => {
  const { response, data } = await start("public"); assert.equal(response.status, 201, JSON.stringify(data));
  const id = data.battle.id;
  assert.equal(activeTurnCount("alice"), 2);
  const text = await drain(id); assert.doesNotMatch(text, /PRIVATE|fixture-one|fixture-two|reasoning|cost|effort|receipt/);
  assert.equal(calls, 2); assert.equal(maxActive, 2); assert.equal(activeTurnCount("alice"), 0);
  assert.equal(getCreditBalance("alice").consumedTokens, 60); assert.equal(getCreditBalance("alice").activeOperations, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM token_credit_roots").get() as { n: number }).n, 1);
  for (const group of ["day", "model", "provider", "kind"] as const) assert.deepEqual(usageSummary("alice", group, 0), []);
  assert.equal(hiddenArenaRequests("alice", 0), 2); assert.ok(goWindows("alice").every(row => row.spent === 0));
  const vote = await request(`/battles/${id}/vote`, "POST", { choice: "tie" }); assert.equal(vote.status, 200);
  const revealed = await vote.text(); assert.match(revealed, /PRIVATE-fixture/); assert.match(revealed, /"cost":0.00005/);
  assert.equal(hiddenArenaRequests("alice", 0), 0); assert.equal(usageSummary("alice", "model", 0).length, 2);
  const replay = await request(`/battles/${id}/vote`, "POST", { choice: "tie" }); assert.equal(replay.status, 200);
  assert.equal((await request(`/battles/${id}/vote`, "POST", { choice: "A" })).status, 409);
  const board = await pub.request("http://localhost/api/public/arena/leaderboard"); assert.equal(board.status, 200);
  const boardText = await board.text(); assert.doesNotMatch(boardText, /Say something|useful final|alice|PRIVATE|http:|openai/); assert.match(boardText, /"provisional":true/);
});
test("failed pane is generic, metered, and cannot win by default", async () => {
  failure = true; const { response, data } = await start(); assert.equal(response.status, 201);
  const text = await drain(data.battle.id); assert.doesNotMatch(text, /PRIVATE|422|fixture-two/); assert.match(text, /"state":"failed"/);
  assert.equal((await request(`/battles/${data.battle.id}/vote`, "POST", { choice: "A" })).status, 409);
  assert.equal(hiddenArenaRequests("alice", 0), 1);
});
test("unknown telemetry holds finite credits and prevents voting", async () => {
  missingUsage = true; const { data } = await start(); const text = await drain(data.battle.id); assert.match(text, /"state":"failed"/);
  assert.ok(getCreditBalance("alice").unknownRequests > 0); assert.equal(getCreditBalance("alice").activeOperations, 0);
  const next = await start(); assert.equal(next.response.status, 403); assert.equal(calls, 2);
});
test("exhausted/busy/cap-one/model-denied/entitlement-denied refuse without dispatch or content", async () => {
  db.exec("UPDATE token_credit_accounts SET credit_tokens=0"); assert.equal((await start()).response.status, 403); assert.equal(calls, 0);
  db.exec("UPDATE token_credit_accounts SET credit_tokens=1000"); const permit = admitCreditRoot("alice", "chat");
  assert.equal((await start()).response.status, 409); closeCreditRoot(permit);
  writePolicy({ kind: "user", id: "alice" }, null, { version: 1, limits: { concurrentTurns: 1 } }, "alice");
  assert.equal((await start()).response.status, 409);
  writePolicy({ kind: "user", id: "alice" }, null, null, "alice");
  writePolicy({ kind: "user", id: "alice" }, "openai/fixture-two", { version: 1, features: { arena: false } }, "alice");
  assert.equal((await start()).response.status, 409);
  writePolicy({ kind: "user", id: "alice" }, "openai/fixture-two", null, "alice");
  setModelAccessPolicies("openai", [{ target: { kind: "everyone", id: "" }, mode: "selected", modelIds: ["fixture-one"] }]);
  assert.equal((await start()).response.status, 409); assert.equal(calls, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM arena_battles").get() as { n: number }).n, 0);
});
test("only one hard slot left unwinds admission; explicit invalid pool never narrows silently", async () => {
  const slots = [reserveTurn("alice")!, reserveTurn("alice")!, reserveTurn("alice")!];
  try { assert.equal((await start()).response.status, 409); assert.equal(activeTurnCount("alice"), 3); } finally { slots.forEach(fn => fn()); }
  assert.equal((await request("/battles", "POST", { mutationId: "invalid", mode: "personal", prompt: "x", poolRefs: ["openai/fixture-one", "missing/no"] })).status, 403);
  assert.equal(calls, 0);
});
test("stop both cancels without votes, reconnect/read cannot redispatch, ownership and CSRF hold", async () => {
  delay = 400; const { data } = await start(); const reading = drain(data.battle.id);
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal((await request(`/battles/${data.battle.id}/stop`, "POST", {})).status, 200);
  assert.match(await reading, /"state":"cancelled"/); const paid = calls;
  await drain(data.battle.id); await request(`/battles/${data.battle.id}`); assert.equal(calls, paid);
  assert.equal((await request(`/battles/${data.battle.id}`, "GET", undefined, "bob")).status, 404);
  assert.equal((await request(`/battles/${data.battle.id}/vote`, "POST", { choice: "A" }, "bob")).status, 404);
  const cross = await app.request("http://localhost/api/arena/battles", { method: "POST", headers: { cookie: "okaychat_session=alice", origin: "https://evil.invalid", "content-type": "text/plain" }, body: "{}" }); assert.equal(cross.status, 403);
});
test("duplicate starts and duplicate votes preserve one paid pair and one ballot", async () => {
  const input = { mutationId: "same-mutation", mode: "personal", prompt: "identical" };
  const results = await Promise.all([request("/battles", "POST", input), request("/battles", "POST", input)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
  const views = await Promise.all(results.map(r => r.json())) as Array<{ battle: { id: string } }>;
  assert.equal(views[0]!.battle.id, views[1]!.battle.id);
  const id = views[0]!.battle.id; await drain(id);
  assert.equal((await request("/battles", "POST", { ...input, prompt: "changed" })).status, 409);
  const votes = await Promise.all([request(`/battles/${id}/vote`, "POST", { choice: "both_bad" }), request(`/battles/${id}/vote`, "POST", { choice: "both_bad" })]);
  assert.ok(votes.every(v => v.status === 200)); assert.equal(calls, 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM token_credit_requests").get() as { n: number }).n, 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n, 2);
  assert.equal((db.prepare("SELECT count(*) AS n FROM arena_votes").get() as { n: number }).n, 1);
});
test("public pairing rejects an own override, and public reads reject write/scope/invalid filters", async () => {
  saveConnection("alice", "openai", { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "own-fixture" });
  assert.equal((await start("public")).response.status, 409); assert.equal(calls, 0);
  assert.equal((await pub.request("http://localhost/api/public/arena/leaderboard?scope=mine")).status, 400);
  assert.equal((await pub.request("http://localhost/api/public/arena/leaderboard?limit=101")).status, 400);
  assert.equal((await pub.request("http://localhost/api/public/arena/leaderboard", { method: "POST" })).status, 404);
});
test("publication removal excludes the whole ballot, restores it, and invalid config disables only public mode", async () => {
  const config = process.env.OKAYCHAT_ARENA_PUBLIC_MODELS!;
  const { data } = await start("public"); await drain(data.battle.id);
  await request(`/battles/${data.battle.id}/vote`, "POST", { choice: "A" });
  const board = async () => pub.request("http://localhost/api/public/arena/leaderboard");
  assert.equal(((await (await board()).json()) as { total: number }).total, 2);
  process.env.OKAYCHAT_ARENA_PUBLIC_MODELS = JSON.stringify((JSON.parse(config) as unknown[]).slice(0, 1));
  assert.equal(((await (await board()).json()) as { total: number }).total, 0);
  process.env.OKAYCHAT_ARENA_PUBLIC_MODELS = config;
  assert.equal(((await (await board()).json()) as { total: number }).total, 2);
  process.env.OKAYCHAT_ARENA_PUBLIC_MODELS = "invalid-json";
  assert.equal((await board()).status, 404);
  assert.equal((await start("public")).response.status, 409);
  assert.equal((await request("/options")).status, 200);
  process.env.OKAYCHAT_ARENA_PUBLIC_MODELS = config;
});
test("stream permits one attachment; disconnect aborts both and preserves the paid tombstone", async () => {
  delay = 400; const { data } = await start();
  const stream = await request(`/battles/${data.battle.id}/events`);
  assert.equal((await request(`/battles/${data.battle.id}/events`)).status, 409);
  await stream.body!.cancel();
  for (let i = 0; i < 100; i++) {
    const state = (await (await request(`/battles/${data.battle.id}`)).json()) as { battle: { state: string } };
    if (state.battle.state !== "running") { assert.equal(state.battle.state, "cancelled"); break; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(activeTurnCount("alice"), 0);
  const count = calls; await request(`/battles/${data.battle.id}`); assert.equal(calls, count);
});
test("bounded strict input rejects invalid body and oversized request before paid admission", async () => {
  const initial = { mutationId: "strict", prompt: "x", mode: "personal" };
  assert.equal((await request("/battles", "POST", { ...initial, unexpected: true })).status, 400);
  assert.equal((await request("/battles", "POST", { ...initial, prompt: "x".repeat(20001) })).status, 400);
  assert.equal((await request("/battles", "POST", { ...initial, prompt: "x".repeat(129 * 1024) })).status, 413);
  assert.equal(calls, 0);
});
test("deadline and missing attachment abort both calls, release leases and never redispatch", async () => {
  for (const attach of [true, false]) {
    resetArenaRouteLimits();
    db.exec("UPDATE token_credit_accounts SET unknown_requests=0");
    setArenaTestDeadlines({ run: attach ? 30 : 500, attach: attach ? 500 : 30 });
    delay = 400;
    const { response, data } = await start(); assert.equal(response.status, 201);
    if (attach) await drain(data.battle.id);
    else {
      for (let i = 0; i < 100 && activeTurnCount("alice") > 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
    }
    const view = (await (await request(`/battles/${data.battle.id}`)).json()) as { battle: { state: string; canVote: boolean } };
    assert.equal(view.battle.state, "failed"); assert.equal(view.battle.canVote, false);
    assert.equal(activeTurnCount("alice"), 0); assert.equal(getCreditBalance("alice").activeOperations, 0);
    const before = calls; await drain(data.battle.id); assert.equal(calls, before);
  }
  setArenaTestDeadlines();
});
test("leaderboard filters do not renumber, mine isolates voters, 30-day replay resets and deletion invalidates", async () => {
  delay = 1;
  for (let i = 0; i < 20; i++) {
    resetArenaRouteLimits(); const { response, data } = await start("public"); assert.equal(response.status, 201);
    await drain(data.battle.id);
    assert.equal((await request(`/battles/${data.battle.id}/vote`, "POST", { choice: i % 2 ? "tie" : "both_bad" })).status, 200);
    assert.equal((await request(`/battles/${data.battle.id}/content`, "DELETE")).status, 200);
  }
  resetArenaRouteLimits();
  const board = await (await pub.request("http://localhost/api/public/arena/leaderboard")).json() as { rows: Array<{ modelKey: string; rank: number; battles: number; provisional: boolean; ties: number; bothBad: number }>; total: number };
  assert.equal(board.rows.length, 2); assert.ok(board.rows.every(row => row.battles === 20 && !row.provisional && row.ties === 20 && row.bothBad === 10));
  const searched = await (await pub.request(`http://localhost/api/public/arena/leaderboard?q=${board.rows[1]!.modelKey}`)).json() as typeof board;
  assert.equal(searched.rows[0]!.rank, 2);
  const mine = await (await request("/leaderboard?scope=mine", "GET", undefined, "bob")).json() as typeof board; assert.equal(mine.total, 0);
  const paged = await (await pub.request("http://localhost/api/public/arena/leaderboard?offset=1&limit=1&sort=rank&direction=desc")).json() as typeof board;
  assert.equal(paged.rows[0]!.rank, 1);
  const old = Date.now() - 31 * 86400_000; db.prepare("UPDATE arena_votes SET created_at=?").run(old); db.exec("UPDATE arena_rating_meta SET revision=revision+1");
  const rolling = await (await pub.request("http://localhost/api/public/arena/leaderboard?window=30d")).json() as typeof board; assert.equal(rolling.total, 0);
  const all = await (await pub.request("http://localhost/api/public/arena/leaderboard")).json() as typeof board; assert.equal(all.total, 2);
  db.exec("BEGIN; UPDATE arena_rating_meta SET revision=revision+1; DELETE FROM users WHERE id='alice'; COMMIT");
  const deleted = await (await pub.request("http://localhost/api/public/arena/leaderboard")).json() as typeof board; assert.equal(deleted.total, 0);
});
