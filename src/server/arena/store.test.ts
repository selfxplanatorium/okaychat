import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
const dir = mkdtempSync(path.join(os.tmpdir(), "okaychat-arena-"));
process.env.OKAYCHAT_DATA_DIR = dir;
process.env.OKAYCHAT_SECRET = "arena-store-tests-not-for-production";
const { db, tx } = await import("../db.js");
const { admitCreditRoot, closeCreditRoot } = await import("../credits/store.js");
const { registerPersonalModel, samplePair, connectionFingerprint, parsePublications, registerPublicModel } = await import("./models.js");
const store = await import("./store.js");
const { storageUsed } = await import("../quota.js");
db.prepare("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES ('a','a@example.test','A','x','user',1),('b','b@example.test','B','x','user',1)").run();
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { db.exec("DELETE FROM arena_battles; DELETE FROM arena_models; DELETE FROM token_credit_requests; DELETE FROM token_credit_roots; UPDATE arena_rating_meta SET revision=0"); });
function launch(mutationId = "m") {
  const assignments = ["one", "two"].map(ref => ({ personalModelId: registerPersonalModel("a", ref, `private-${ref}`, ref), snapshot: { ref, label: `private-${ref}`, fingerprint: ref, effort: "none", system: "neutral", priceKnown: true } }));
  const permit = admitCreditRoot("a", "chat");
  try { return store.createBattle("a", { mutationId, prompt: "question", mode: "personal" }, [assignments[0]!, assignments[1]!], permit); }
  finally { closeCreditRoot(permit); }
}
// A settled-receipt fixture, deliberately bypassing provider execution in these storage-only tests.
function settled(id: string, side: "A" | "B") {
  const root = `root-${id}-${side}`, request = `request-${id}-${side}`;
  db.prepare("INSERT OR IGNORE INTO token_credit_accounts(user_id,period_started_at) VALUES ('a',1)").run();
  db.prepare("INSERT INTO token_credit_roots(id,user_id,period,origin,exclusive,state,started_at) VALUES (?,'a',1,'chat',0,'finished',1)").run(root);
  const usage = JSON.stringify({ input: 5, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  db.prepare("INSERT INTO token_credit_requests(id,root_id,user_id,period,provider_id,model_id,kind,state,context_json,created_at,dispatched_at,usage_json) VALUES (?,?,'a',1,'fixture','model','chat','reported',?,1,1,?)").run(request, root, JSON.stringify({ arenaBattleId: id, arenaSide: side }), usage);
  db.prepare("INSERT INTO usage(user_id,provider_id,model_id,kind,input_tokens,output_tokens,cost,created_at,credit_request_id) VALUES ('a','fixture','model','chat',5,10,0.1,1,?)").run(request);
  store.finishPane("a", id, side, { text: `answer ${side}`, finish: "stop", receiptId: request });
}
function ready() { const { battle } = launch(); settled(battle.id, "A"); settled(battle.id, "B"); store.finishBattle("a", battle.id); return battle.id; }

test("previously ready truncated panes cannot be voted on after an upgrade", () => {
  const id = ready();
  db.prepare("UPDATE arena_panes SET finish_reason='length' WHERE battle_id=? AND side='A'").run(id);
  assert.equal(store.getBattle("a", id).canVote, false);
  assert.throws(() => store.castVote("a", id, "tie", true));
});

test("blind projection has no private metadata and two immutable sides", () => {
  const { battle } = launch();
  assert.equal(battle.visibility, "blind");
  assert.equal(battle.canVote, false);
  assert.deepEqual(battle.panes.map(p => p.side), ["A", "B"]);
  assert.doesNotMatch(JSON.stringify(battle), /private-|fingerprint|effort|receipt|cost/);
  assert.throws(() => store.getBattle("b", battle.id), /unavailable/);
  assert.throws(() => store.getBattle("a", "missing"), /unavailable/);
});
test("idempotent normalized start never allocates twice and rejects changed input", () => {
  const first = launch();
  const second = launch();
  assert.equal(second.created, false); assert.equal(second.battle.id, first.battle.id);
  assert.throws(() => launch("new"));
  assert.equal((db.prepare("SELECT count(*) AS n FROM arena_battles").get() as { n: number }).n, 1);
  const permit = admitCreditRoot("a", "chat");
  try { assert.throws(() => store.createBattle("a", { mutationId: "m", prompt: "different", mode: "personal" }, [] as unknown as Parameters<typeof store.createBattle>[2], permit)); } finally { closeCreditRoot(permit); }
});
for (const choice of ["A", "B", "tie", "both_bad"] as const) test(`vote ${choice} commits once, reveals, replays after expiry and revocation`, () => {
  const id = ready();
  assert.equal(store.getBattle("a", id).canVote, true);
  const first = store.castVote("a", id, choice, true);
  assert.equal(first.battle.visibility, "revealed"); assert.equal(first.ratingRevision, 1);
  store.discardContent("a", id);
  const again = store.castVote("a", id, choice, false, Date.now() + 40 * 86400_000);
  assert.equal(again.ratingRevision, 1);
  assert.equal(again.battle.visibility, "revealed"); assert.equal(again.battle.prompt, undefined);
  assert.throws(() => store.castVote("a", id, choice === "A" ? "B" : "A", true));
  assert.throws(() => store.castVote("b", id, choice, true));
});
test("vote failure rolls back ballot, state and revision together", () => {
  const id = ready();
  assert.throws(() => tx(() => { store.castVote("a", id, "A", true); throw new Error("fixture rollback"); }));
  assert.equal(store.getBattle("a", id).state, "ready"); assert.equal(store.ratingRevision(), 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM arena_votes").get() as { n: number }).n, 0);
});
test("missing telemetry, failed peer, interruption and cancellation prevent votes", () => {
  const { battle } = launch();
  settled(battle.id, "A");
  store.finishPane("a", battle.id, "B", { text: "partial", finish: "error" });
  store.finishBattle("a", battle.id);
  assert.equal(store.getBattle("a", battle.id).state, "failed");
  assert.throws(() => store.castVote("a", battle.id, "A", true));
  const next = launch("next").battle;
  store.finishBattle("a", next.id, true);
  assert.equal(store.getBattle("a", next.id).canVote, false);
  const last = launch("last").battle;
  store.interruptBattles(); store.interruptBattles();
  assert.equal(store.getBattle("a", last.id).state, "interrupted");
});
test("reservation survives terminal writes and is released by content purge only", () => {
  const before = storageUsed("a"), id = ready(), during = storageUsed("a");
  assert.ok(during - before >= 96 * 1024);
  store.castVote("a", id, "tie", true);
  assert.equal(storageUsed("a"), during);
  store.discardContent("a", id); store.discardContent("a", id);
  assert.equal(storageUsed("a"), before);
  assert.equal(store.getBattle("a", id).visibility, "revealed");
});
test("ready expiry prevents late voting and bounded sweep purges ciphertext", () => {
  const id = ready(), future = Date.now() + 31 * 86400_000;
  assert.equal(store.getBattle("a", id, future).canVote, false);
  assert.throws(() => store.castVote("a", id, "tie", true, future));
  assert.equal(store.expireContents(future), 1); assert.equal(store.expireContents(future), 0);
  assert.equal(store.getBattle("a", id).state, "expired");
});
test("uniform pair seam covers all pairs and assignments without replacement", () => {
  const pairs = new Set<string>();
  for (let first = 0; first < 3; first++) for (let second = 0; second < 2; second++) for (let bit = 0; bit < 2; bit++) {
    const draws = [first, second, bit]; const pair = samplePair(["a", "b", "c"], () => draws.shift()!);
    assert.notEqual(pair[0], pair[1]); pairs.add(pair.join(""));
  }
  assert.equal(pairs.size, 6);
  assert.throws(() => samplePair(["a", "a"])); assert.throws(() => samplePair(["a", "b"], () => 2));
});
test("connection identities normalize URLs, preserve labels and isolate endpoints", () => {
  const base = { providerId: "fixture", format: "openai", modelId: "test" };
  const a = connectionFingerprint({ ...base, baseUrl: "https://example.test/v1/" });
  assert.equal(a, connectionFingerprint({ ...base, baseUrl: "https://EXAMPLE.test:443/v1" }));
  const b = connectionFingerprint({ ...base, baseUrl: "https://other.test/v1" }); assert.notEqual(a, b);
  const id = registerPersonalModel("a", "test", "Old", a);
  assert.equal(registerPersonalModel("a", "test", "New", a), id);
  assert.notEqual(registerPersonalModel("a", "test", "New", b), id);
  const pub = { ref: "test", label: "Published", epoch: "v1" };
  registerPublicModel(pub, a); assert.throws(() => registerPublicModel(pub, b));
  assert.deepEqual(parsePublications(undefined), []);
  assert.throws(() => parsePublications(JSON.stringify([{ ...pub, extra: true }])));
  assert.throws(() => parsePublications(JSON.stringify([pub, pub])));
});
test("strict start normalization rejects unknown fields and canonicalizes equivalent requests", () => {
  const a = store.normalizeStart({ mutationId: "m", prompt: " question ", mode: "personal", poolRefs: ["b", "a"] });
  const b = store.normalizeStart({ mutationId: "other", prompt: "question", mode: "personal", poolRefs: ["a", "b"] });
  assert.equal(store.startHash(a), store.startHash(b));
  assert.throws(() => store.normalizeStart({ ...a, voter: "b" }));
  assert.throws(() => store.normalizeStart({ ...a, poolRefs: ["a", "a"] }));
  assert.throws(() => store.normalizeStart({ ...a, prompt: " " }));
  assert.throws(() => store.normalizeStart({ ...a, prompt: "x".repeat(20001) }));
});
test("a settled receipt belonging to the wrong side never makes a pane voteable", () => {
  const { battle } = launch(); settled(battle.id, "A");
  store.finishPane("a", battle.id, "B", { text: "not accounted", finish: "stop", receiptId: `request-${battle.id}-A` });
  store.finishBattle("a", battle.id);
  assert.equal(store.getBattle("a", battle.id).state, "failed");
  assert.equal(store.getBattle("a", battle.id).canVote, false);
});
