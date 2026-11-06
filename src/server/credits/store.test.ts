import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-credits-store-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "credits-store-test-secret-not-for-production";
process.env.OKAYCHAT_STORAGE_LIMIT = "10000000";

const { db } = await import("../db.js");
const {
  CreditError,
  ensureCreditAccount,
  getCreditBalance,
  admitCreditRoot,
  assertCreditPermit,
  closeCreditRoot,
  beginCreditRequest,
  markCreditDispatched,
  settleCreditRequest,
  mutateCreditAccount,
  listCreditAudit,
} = await import("./store.js");

const ADMIN = "admin-root";
const ALICE = "alice";
const BOB = "bob";

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Every credit table cascades from users, so this resets counters, roots, receipts and audit.
  db.exec("DELETE FROM users");
  const insert = db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insert.run(ADMIN, `${ADMIN}@example.test`, ADMIN, "unused", "admin", 1_000);
  insert.run(ALICE, `${ALICE}@example.test`, ALICE, "unused", "user", 1_000);
  insert.run(BOB, `${BOB}@example.test`, BOB, "unused", "user", 1_000);
});

afterEach(() => {
  db.exec("DROP TRIGGER IF EXISTS credit_test_block_usage");
  db.exec("DROP TRIGGER IF EXISTS credit_test_block_audit");
});

// The shared catalog owns the wire codes; the store's short aliases are accepted so a store that
// exposes `busy`/`usage_unknown` internally still proves the same admission decision.
const CODES = {
  exhausted: ["token_credit_exhausted", "exhausted"],
  unknown: ["token_credit_usage_unknown", "usage_unknown"],
  busy: ["token_credit_busy", "busy"],
  conflict: ["conflict"],
  validation: ["validation"],
  forbidden: ["forbidden"],
  notFound: ["not_found"],
} as const;

function expectCreditError(fn: () => unknown, expected: readonly string[]) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CreditError, `expected a CreditError, received ${String(error)}`);
    assert.ok(
      expected.includes(error.code),
      `expected credit error ${expected.join(" | ")}, received ${error.code}: ${error.message}`,
    );
    return error;
  }
  assert.fail(`expected credit error ${expected.join(" | ")}`);
}

let mutationSeq = 0;
function mutationId(): string {
  mutationSeq += 1;
  return `00000000-0000-4000-8000-${String(mutationSeq).padStart(12, "0")}`;
}

function grant(userId: string, creditTokens: number | null, reason = "test grant") {
  ensureCreditAccount(userId);
  const current = getCreditBalance(userId);
  return mutateCreditAccount(
    ADMIN,
    userId,
    creditTokens === null
      ? { action: "clear", expectedVersion: current.version, mutationId: mutationId(), reason }
      : { action: "set", creditTokens, expectedVersion: current.version, mutationId: mutationId(), reason },
  );
}

function requestRow(requestId: string) {
  const row = db
    .prepare("SELECT state, debit_tokens, dispatched_at, settled_at, error_code FROM token_credit_requests WHERE id = ?")
    .get(requestId) as
    | { state: string; debit_tokens: number; dispatched_at: number | null; settled_at: number | null; error_code: string | null }
    | undefined;
  assert.ok(row, `credit request ${requestId} exists`);
  return row;
}

function usageRows(creditRequestId: string) {
  return db
    .prepare(
      "SELECT user_id, provider_id, model_id, kind, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens FROM usage WHERE credit_request_id = ?",
    )
    .all(creditRequestId) as unknown as Array<{
    user_id: string;
    provider_id: string;
    model_id: string;
    kind: string;
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  }>;
}

function auditCount(userId: string) {
  return (db.prepare("SELECT COUNT(*) AS n FROM token_credit_audit WHERE user_id = ?").get(userId) as { n: number }).n;
}

test("new and missing accounts are explicitly unlimited and ensure is idempotent", () => {
  ensureCreditAccount(ALICE, 5_000);
  let balance = getCreditBalance(ALICE);
  assert.equal(balance.creditTokens, null);
  assert.equal(balance.consumedTokens, 0);
  assert.equal(balance.remainingTokens, null);
  assert.equal(balance.unknownRequests, 0);
  assert.equal(balance.period, 1);
  assert.equal(balance.periodStartedAt, 5_000);
  assert.equal(balance.resetPolicy, "manual");
  assert.equal(balance.version, 1);
  assert.equal(balance.status, "unlimited");
  assert.equal(balance.activeOperations, 0);
  assert.equal(typeof balance.asOf, "number");

  ensureCreditAccount(ALICE, 9_000);
  balance = getCreditBalance(ALICE);
  assert.equal(balance.periodStartedAt, 5_000);
  assert.equal(balance.version, 1);

  // A read repairs a missing row without inventing a finite allowance.
  db.prepare("DELETE FROM token_credit_accounts WHERE user_id = ?").run(ALICE);
  balance = getCreditBalance(ALICE);
  assert.equal(balance.creditTokens, null);
  assert.equal(balance.status, "unlimited");
  assert.equal(balance.period, 1);

  // A missing user cannot get a row (foreign key fails closed).
  assert.throws(() => ensureCreditAccount("ghost"));
  assert.throws(() => admitCreditRoot("ghost", "chat"));
});

test("zero allowance rejects admission before any request is created", () => {
  grant(ALICE, 0);
  const balance = getCreditBalance(ALICE);
  assert.equal(balance.creditTokens, 0);
  assert.equal(balance.consumedTokens, 0);
  assert.equal(balance.remainingTokens, 0);
  assert.equal(balance.status, "exhausted");

  expectCreditError(() => admitCreditRoot(ALICE, "chat"), CODES.exhausted);
  assert.equal(getCreditBalance(ALICE).activeOperations, 0);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM token_credit_roots WHERE user_id = ?").get(ALICE) as { n: number }).n,
    0,
  );

  // Admins have no spending exemption.
  grant(ADMIN, 0);
  expectCreditError(() => admitCreditRoot(ADMIN, "chat"), CODES.exhausted);
});

test("a finite account admits one root and a second concurrent root is busy", () => {
  grant(ALICE, 10);
  const permit = admitCreditRoot(ALICE, "chat");
  assertCreditPermit(permit, ALICE);
  assert.equal(getCreditBalance(ALICE).activeOperations, 1);

  expectCreditError(() => admitCreditRoot(ALICE, "api"), CODES.busy);
  expectCreditError(() => admitCreditRoot(ALICE, "schedule"), CODES.busy);

  // Another account's root is independent.
  const bob = admitCreditRoot(BOB, "chat");
  assertCreditPermit(bob, BOB);
  closeCreditRoot(bob);

  closeCreditRoot(permit);
  assert.equal(getCreditBalance(ALICE).activeOperations, 0);
  const next = admitCreditRoot(ALICE, "api");
  assertCreditPermit(next, ALICE);
  closeCreditRoot(next);
});

test("permits are branded, payer-bound and unusable once closed", () => {
  grant(ALICE, 100);
  const permit = admitCreditRoot(ALICE, "chat");
  const begin = () => beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "chat" });

  // A structural clone or a JSON round trip cannot mint a capability or start a request.
  const cloned = { ...permit } as unknown as Parameters<typeof assertCreditPermit>[0];
  expectCreditError(() => assertCreditPermit(cloned, ALICE), [...CODES.forbidden, ...CODES.validation]);
  expectCreditError(
    () => beginCreditRequest(cloned, { providerId: "provider-a", modelId: "model-a", kind: "chat" }),
    [...CODES.forbidden, ...CODES.validation],
  );
  const roundTripped = JSON.parse(JSON.stringify(permit)) as Parameters<typeof assertCreditPermit>[0];
  expectCreditError(() => assertCreditPermit(roundTripped, ALICE), [...CODES.forbidden, ...CODES.validation]);
  expectCreditError(() => assertCreditPermit(permit, BOB), [...CODES.forbidden, ...CODES.validation]);

  // The real capability works until the root is closed.
  const requestId = begin();
  markCreditDispatched(requestId);
  assertCreditPermit(permit, ALICE);
  const requestCount = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM token_credit_requests WHERE user_id = ?").get(ALICE) as { n: number }).n;
  assert.equal(requestCount(), 1);
  expectCreditError(() => closeCreditRoot(permit), CODES.busy);
  assert.equal(getCreditBalance(ALICE).activeOperations, 1);
  settleCreditRequest(requestId, { state: "unknown", errorCode: "interrupted" });
  closeCreditRoot(permit);

  expectCreditError(() => assertCreditPermit(permit, ALICE), [...CODES.forbidden, ...CODES.validation]);
  expectCreditError(begin, [...CODES.forbidden, ...CODES.validation, ...CODES.busy]);
  assert.equal(requestCount(), 1);
  assert.equal(getCreditBalance(ALICE).activeOperations, 0);
});

test("reported usage debits input plus output once, never the breakdowns", () => {
  grant(ALICE, 1_000);
  const permit = admitCreditRoot(ALICE, "chat");
  const requestId = beginCreditRequest(permit, {
    providerId: "provider-a",
    modelId: "model-a",
    kind: "chat",
    context: { threadId: "thread-a" },
  });
  markCreditDispatched(requestId);
  assert.notEqual(requestRow(requestId).dispatched_at, null);

  settleCreditRequest(requestId, {
    state: "reported",
    // cache reads/writes are part of input, reasoning is part of output: debit is 100 + 30.
    usage: { input: 100, output: 30, reasoning: 10, cacheRead: 60, cacheWrite: 20 },
    cost: 0,
  });

  const balance = getCreditBalance(ALICE);
  assert.equal(balance.consumedTokens, 130);
  assert.equal(balance.remainingTokens, 870);
  assert.equal(balance.status, "available");

  const row = requestRow(requestId);
  assert.equal(row.state, "reported");
  assert.equal(row.debit_tokens, 130);
  assert.notEqual(row.settled_at, null);

  const rows = usageRows(requestId);
  assert.equal(rows.length, 1);
  const [usage] = rows;
  assert.ok(usage);
  assert.equal(usage.user_id, ALICE);
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.output_tokens, 30);
  assert.equal(usage.reasoning_tokens, 10);
  assert.equal(usage.cache_read_tokens, 60);
  assert.equal(usage.cache_write_tokens, 20);

  closeCreditRoot(permit);
  assert.equal(getCreditBalance(ALICE).activeOperations, 0);
});

test("reported zero usage is valid, free and does not hold the account", () => {
  grant(ALICE, 10);
  const permit = admitCreditRoot(ALICE, "chat");
  const requestId = beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "chat" });
  markCreditDispatched(requestId);
  settleCreditRequest(requestId, {
    state: "reported",
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
  });
  closeCreditRoot(permit);

  const balance = getCreditBalance(ALICE);
  assert.equal(balance.consumedTokens, 0);
  assert.equal(balance.unknownRequests, 0);
  assert.equal(balance.status, "available");
  assert.equal(requestRow(requestId).state, "reported");
  assert.equal(requestRow(requestId).debit_tokens, 0);
  assert.equal(usageRows(requestId).length, 1);

  const next = admitCreditRoot(ALICE, "chat");
  closeCreditRoot(next);
});

test("duplicate and late settlements charge exactly once", () => {
  grant(ALICE, 100);
  const permit = admitCreditRoot(ALICE, "chat");
  const requestId = beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "chat" });
  markCreditDispatched(requestId);
  const usage = { input: 40, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  settleCreditRequest(requestId, { state: "reported", usage, cost: 0 });
  assert.equal(getCreditBalance(ALICE).consumedTokens, 50);

  // A repeated finish callback is a no-op, not a second debit.
  settleCreditRequest(requestId, { state: "reported", usage, cost: 0 });
  closeCreditRoot(permit);
  settleCreditRequest(requestId, { state: "reported", usage, cost: 0 });

  assert.equal(getCreditBalance(ALICE).consumedTokens, 50);
  assert.equal(usageRows(requestId).length, 1);
  assert.equal(requestRow(requestId).state, "reported");
});

test("not dispatched and rejected settlements debit nothing and never hold", () => {
  grant(ALICE, 100);
  const permit = admitCreditRoot(ALICE, "chat");

  const notDispatched = beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "chat" });
  settleCreditRequest(notDispatched, { state: "not_dispatched", errorCode: "validation" });

  const rejected = beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "chat" });
  markCreditDispatched(rejected);
  settleCreditRequest(rejected, { state: "rejected", errorCode: "provider_auth" });

  closeCreditRoot(permit);
  const balance = getCreditBalance(ALICE);
  assert.equal(balance.consumedTokens, 0);
  assert.equal(balance.remainingTokens, 100);
  assert.equal(balance.unknownRequests, 0);
  assert.equal(balance.status, "available");
  assert.equal(requestRow(notDispatched).state, "not_dispatched");
  assert.equal(requestRow(rejected).state, "rejected");
  assert.equal(usageRows(notDispatched).length, 0);
  assert.equal(usageRows(rejected).length, 0);

  const next = admitCreditRoot(ALICE, "chat");
  closeCreditRoot(next);
});

test("child requests under one root accumulate without lost updates", () => {
  grant(ALICE, 100);
  const permit = admitCreditRoot(ALICE, "chat");
  const settle = (input: number) => {
    const requestId = beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "subagent" });
    markCreditDispatched(requestId);
    settleCreditRequest(requestId, {
      state: "reported",
      usage: { input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
    });
  };

  settle(8);
  settle(9);
  assert.equal(getCreditBalance(ALICE).consumedTokens, 17);

  closeCreditRoot(permit);
  const next = admitCreditRoot(ALICE, "chat");
  closeCreditRoot(next);
});

test("overshoot is recorded and blocks the next operation, not the active one", () => {
  grant(ALICE, 100);
  const permit = admitCreditRoot(ALICE, "chat");
  const first = beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "chat" });
  markCreditDispatched(first);
  settleCreditRequest(first, {
    state: "reported",
    usage: { input: 120, output: 30, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
  });

  let balance = getCreditBalance(ALICE);
  assert.equal(balance.consumedTokens, 150);
  assert.equal(balance.remainingTokens, 0);
  assert.equal(balance.status, "exhausted");

  // The admitted operation may keep running inside its root even past the allowance.
  const second = beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "chat" });
  markCreditDispatched(second);
  settleCreditRequest(second, {
    state: "reported",
    usage: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
  });
  balance = getCreditBalance(ALICE);
  assert.equal(balance.consumedTokens, 155);
  assert.equal(balance.remainingTokens, 0);

  closeCreditRoot(permit);
  expectCreditError(() => admitCreditRoot(ALICE, "chat"), CODES.exhausted);
});

test("unknown usage holds a finite account, stops new children and preserves reported debits", () => {
  grant(ALICE, 100);
  const permit = admitCreditRoot(ALICE, "chat");

  const reported = beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "chat" });
  markCreditDispatched(reported);
  settleCreditRequest(reported, {
    state: "reported",
    usage: { input: 20, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
  });

  // An in-flight request is allowed to settle after the unknown is known.
  const inFlight = beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "chat" });
  markCreditDispatched(inFlight);

  const unknown = beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "chat" });
  markCreditDispatched(unknown);
  settleCreditRequest(unknown, { state: "unknown", errorCode: "timeout" });

  const balance = getCreditBalance(ALICE);
  assert.equal(balance.unknownRequests, 1);
  assert.equal(balance.consumedTokens, 20);
  assert.equal(balance.remainingTokens, 80);
  assert.equal(balance.status, "usage_unknown");

  settleCreditRequest(inFlight, {
    state: "reported",
    usage: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
  });
  assert.equal(getCreditBalance(ALICE).consumedTokens, 25);

  // No new model request may be admitted under the root after the unknown.
  expectCreditError(
    () => beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "chat" }),
    CODES.unknown,
  );
  assert.equal(usageRows(unknown).length, 0);

  // A late callback cannot overwrite the terminal unknown receipt or debit anything.
  settleCreditRequest(unknown, {
    state: "reported",
    usage: { input: 999, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
  });
  assert.equal(getCreditBalance(ALICE).consumedTokens, 25);
  assert.equal(getCreditBalance(ALICE).unknownRequests, 1);

  closeCreditRoot(permit);
  expectCreditError(() => admitCreditRoot(ALICE, "chat"), CODES.unknown);
});

test("unlimited accounts record unknowns without holding or limiting concurrency", () => {
  const permit = admitCreditRoot(BOB, "chat");
  const requestId = beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "chat" });
  markCreditDispatched(requestId);
  settleCreditRequest(requestId, { state: "unknown", errorCode: "timeout" });

  const balance = getCreditBalance(BOB);
  assert.equal(balance.status, "unlimited");
  assert.equal(balance.unknownRequests, 1);
  assert.equal(balance.consumedTokens, 0);
  assert.equal(balance.remainingTokens, null);

  const child = beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "chat" });
  markCreditDispatched(child);
  settleCreditRequest(child, {
    state: "reported",
    usage: { input: 7, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
  });

  const second = admitCreditRoot(BOB, "api");
  assertCreditPermit(second, BOB);
  assert.equal(getCreditBalance(BOB).activeOperations, 2);
  assert.equal(getCreditBalance(BOB).consumedTokens, 10);

  closeCreditRoot(permit);
  closeCreditRoot(second);
  assert.equal(getCreditBalance(BOB).activeOperations, 0);
});

test("finite with unresolved unknowns stays held through clear and re-limit until reset", () => {
  grant(ALICE, 100);
  const permit = admitCreditRoot(ALICE, "chat");
  const requestId = beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "chat" });
  markCreditDispatched(requestId);
  settleCreditRequest(requestId, { state: "unknown", errorCode: "disconnect" });
  closeCreditRoot(permit);

  grant(ALICE, null);
  assert.equal(getCreditBalance(ALICE).status, "unlimited");
  assert.equal(getCreditBalance(ALICE).unknownRequests, 1);

  grant(ALICE, 250);
  assert.equal(getCreditBalance(ALICE).status, "usage_unknown");
  expectCreditError(() => admitCreditRoot(ALICE, "chat"), CODES.unknown);
});

test("reset starts a new period, forgives unknown usage and requires acknowledgement", () => {
  grant(ALICE, 100);
  const permit = admitCreditRoot(ALICE, "chat");
  const requestId = beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "chat" });
  markCreditDispatched(requestId);
  settleCreditRequest(requestId, { state: "unknown", errorCode: "timeout" });
  closeCreditRoot(permit);

  const before = getCreditBalance(ALICE);
  expectCreditError(
    () =>
      mutateCreditAccount(ADMIN, ALICE, {
        action: "reset",
        expectedVersion: before.version,
        mutationId: mutationId(),
        reason: "forgive",
        acknowledgeUnknown: false,
      }),
    [...CODES.validation, ...CODES.unknown],
  );
  assert.equal(getCreditBalance(ALICE).unknownRequests, 1);
  assert.equal(getCreditBalance(ALICE).period, before.period);

  const resetAt = Date.now();
  const reset = mutateCreditAccount(ADMIN, ALICE, {
    action: "reset",
    expectedVersion: before.version,
    mutationId: mutationId(),
    reason: "forgive",
    acknowledgeUnknown: true,
  });
  assert.equal(reset.creditTokens, 100);
  assert.equal(reset.consumedTokens, 0);
  assert.equal(reset.unknownRequests, 0);
  assert.equal(reset.remainingTokens, 100);
  assert.equal(reset.period, before.period + 1);
  assert.ok(reset.periodStartedAt >= resetAt);
  assert.equal(reset.version, before.version + 1);
  assert.equal(reset.status, "available");

  // An old receipt can never settle into the new period.
  settleCreditRequest(requestId, {
    state: "reported",
    usage: { input: 9, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
  });
  assert.equal(getCreditBalance(ALICE).consumedTokens, 0);
  assert.equal(getCreditBalance(ALICE).unknownRequests, 0);
  assert.equal(requestRow(requestId).state, "unknown");

  const next = admitCreditRoot(ALICE, "chat");
  closeCreditRoot(next);
});

test("set, lower and clear never reset used tokens; clearing is unlimited", () => {
  grant(ALICE, 100);
  const permit = admitCreditRoot(ALICE, "chat");
  const requestId = beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "chat" });
  markCreditDispatched(requestId);
  settleCreditRequest(requestId, {
    state: "reported",
    usage: { input: 50, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
  });
  closeCreditRoot(permit);

  const lower = grant(ALICE, 50);
  assert.equal(lower.consumedTokens, 60);
  assert.equal(lower.creditTokens, 50);
  assert.equal(lower.remainingTokens, 0);
  assert.equal(lower.status, "exhausted");
  expectCreditError(() => admitCreditRoot(ALICE, "chat"), CODES.exhausted);

  const cleared = grant(ALICE, null);
  assert.equal(cleared.creditTokens, null);
  assert.equal(cleared.consumedTokens, 60);
  assert.equal(cleared.remainingTokens, null);
  assert.equal(cleared.status, "unlimited");
  const unlimitedRoot = admitCreditRoot(ALICE, "chat");
  closeCreditRoot(unlimitedRoot);

  const raised = grant(ALICE, 100);
  assert.equal(raised.consumedTokens, 60);
  assert.equal(raised.remainingTokens, 40);
  assert.equal(raised.status, "available");
  const finiteRoot = admitCreditRoot(ALICE, "chat");
  closeCreditRoot(finiteRoot);

  // Setting a zero allowance keeps the used counter and leaves the account exhausted.
  const zero = grant(ALICE, 0);
  assert.equal(zero.consumedTokens, 60);
  assert.equal(zero.remainingTokens, 0);
  assert.equal(zero.status, "exhausted");
});

test("mutation retries are idempotent by mutation id and changed payloads conflict", () => {
  ensureCreditAccount(ALICE);
  const firstMutation = mutationId();
  const first = mutateCreditAccount(ADMIN, ALICE, {
    action: "set",
    creditTokens: 10,
    expectedVersion: 1,
    mutationId: firstMutation,
    reason: "initial grant",
  });
  assert.equal(first.version, 2);

  const replay = mutateCreditAccount(ADMIN, ALICE, {
    action: "set",
    creditTokens: 10,
    expectedVersion: 1,
    mutationId: firstMutation,
    reason: "initial grant",
  });
  assert.equal(replay.creditTokens, 10);
  assert.equal(replay.version, 2);
  assert.equal(auditCount(ALICE), 1);

  // The same mutation id with a different payload is a conflict, never a silent overwrite.
  expectCreditError(
    () =>
      mutateCreditAccount(ADMIN, ALICE, {
        action: "set",
        creditTokens: 11,
        expectedVersion: 1,
        mutationId: firstMutation,
        reason: "initial grant",
      }),
    CODES.conflict,
  );
  assert.equal(getCreditBalance(ALICE).creditTokens, 10);

  // A stale expected version is a conflict.
  expectCreditError(
    () =>
      mutateCreditAccount(ADMIN, ALICE, {
        action: "set",
        creditTokens: 20,
        expectedVersion: 1,
        mutationId: mutationId(),
        reason: "stale",
      }),
    CODES.conflict,
  );

  // Setting the current value is an accepted no-op: no audit row, no version bump.
  const noop = mutateCreditAccount(ADMIN, ALICE, {
    action: "set",
    creditTokens: 10,
    expectedVersion: 2,
    mutationId: mutationId(),
    reason: "no change",
  });
  assert.equal(noop.version, 2);
  assert.equal(auditCount(ALICE), 1);

  for (const creditTokens of [-1, 1.5, 1_000_000_000_001]) {
    expectCreditError(
      () =>
        mutateCreditAccount(ADMIN, ALICE, {
          action: "set",
          creditTokens,
          expectedVersion: 2,
          mutationId: mutationId(),
          reason: "invalid",
        }),
      CODES.validation,
    );
  }
  expectCreditError(
    () =>
      mutateCreditAccount(ADMIN, ALICE, {
        action: "set",
        creditTokens: 20,
        expectedVersion: 2,
        mutationId: mutationId(),
        reason: "   ",
      }),
    CODES.validation,
  );
  assert.equal(getCreditBalance(ALICE).creditTokens, 10);
});

test("mutations require a live admin, an existing target and an idle account", () => {
  ensureCreditAccount(ALICE);
  const set = (actor: string, target: string) =>
    mutateCreditAccount(actor, target, {
      action: "set",
      creditTokens: 5,
      expectedVersion: getCreditBalance(ALICE).version,
      mutationId: mutationId(),
      reason: "attempt",
    });

  expectCreditError(() => set(BOB, ALICE), CODES.forbidden);
  expectCreditError(() => set(ALICE, ALICE), CODES.forbidden);
  assert.equal(getCreditBalance(ALICE).version, 1);
  assert.equal(auditCount(ALICE), 0);

  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(BOB);
  assert.equal(set(BOB, ALICE).creditTokens, 5);
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(BOB);
  expectCreditError(() => set(BOB, ALICE), CODES.forbidden);
  assert.equal(getCreditBalance(ALICE).creditTokens, 5);

  // An active root blocks every mutation instead of racing a debit.
  const permit = admitCreditRoot(ALICE, "chat");
  expectCreditError(
    () =>
      mutateCreditAccount(ADMIN, ALICE, {
        action: "set",
        creditTokens: 10,
        expectedVersion: getCreditBalance(ALICE).version,
        mutationId: mutationId(),
        reason: "busy",
      }),
    CODES.busy,
  );
  assert.equal(auditCount(ALICE), 1);
  closeCreditRoot(permit);

  expectCreditError(() => set(ADMIN, "ghost"), CODES.notFound);
});

test("audit is newest-first, cursor-paged, snapshotted and cleared by user deletion", () => {
  ensureCreditAccount(ALICE);
  grant(ALICE, 10, "first");
  grant(ALICE, 20, "second");
  grant(ALICE, null, "third");

  const page = listCreditAudit(ALICE, undefined, 2);
  assert.equal(page.rows.length, 2);
  const cursor = page.nextCursor;
  assert.ok(cursor !== null && cursor !== undefined);
  const [newest, middle] = page.rows;
  assert.ok(newest && middle);
  assert.equal(newest.action, "clear");
  assert.equal(newest.before.creditTokens, 20);
  assert.equal(newest.after.creditTokens, null);
  assert.equal(newest.after.status, "unlimited");
  assert.equal(newest.after.resetPolicy, "manual");
  assert.equal(newest.before.consumedTokens, 0);
  assert.equal(newest.after.consumedTokens, 0);
  assert.equal(newest.reason, "third");
  assert.equal(newest.actorId, ADMIN);
  assert.equal(typeof newest.createdAt, "number");
  assert.ok(newest.id > middle.id);
  assert.ok(!("asOf" in newest.after));
  assert.ok(!("activeOperations" in newest.after));

  const rest = listCreditAudit(ALICE, cursor, 2);
  assert.equal(rest.rows.length, 1);
  assert.equal(rest.nextCursor, null);
  const [oldest] = rest.rows;
  assert.ok(oldest);
  assert.equal(oldest.action, "set");
  assert.equal(oldest.before.creditTokens, null);
  assert.equal(oldest.after.creditTokens, 10);
  assert.equal(oldest.after.version, 2);

  // Another account sees none of this.
  assert.equal(listCreditAudit(BOB).rows.length, 0);

  // Deleting the actor preserves the history with no administrator identity.
  db.prepare("DELETE FROM users WHERE id = ?").run(ADMIN);
  const afterActorDeletion = listCreditAudit(ALICE);
  assert.equal(afterActorDeletion.rows.length, 3);
  assert.equal(afterActorDeletion.rows[0]?.actorId, null);

  // Deleting the account removes its credits, receipts and audit.
  db.prepare("DELETE FROM users WHERE id = ?").run(ALICE);
  assert.equal(listCreditAudit(ALICE).rows.length, 0);
  for (const table of ["token_credit_accounts", "token_credit_roots", "token_credit_requests", "token_credit_audit"]) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(ALICE) as { n: number };
    assert.equal(row.n, 0, `${table} cascaded`);
  }
});

test("a failed ledger insert rolls back the receipt and counter together", () => {
  grant(ALICE, 100);
  const permit = admitCreditRoot(ALICE, "chat");
  const requestId = beginCreditRequest(permit, { providerId: "atomic-provider", modelId: "model-a", kind: "chat" });
  markCreditDispatched(requestId);
  db.exec(
    "CREATE TRIGGER credit_test_block_usage BEFORE INSERT ON usage WHEN NEW.provider_id = 'atomic-provider' BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END",
  );

  assert.throws(() =>
    settleCreditRequest(requestId, {
      state: "reported",
      usage: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
    }),
  );
  assert.equal(requestRow(requestId).state, "open");
  assert.equal(requestRow(requestId).debit_tokens, 0);
  assert.equal(requestRow(requestId).settled_at, null);
  assert.equal(getCreditBalance(ALICE).consumedTokens, 0);
  assert.equal(usageRows(requestId).length, 0);

  db.exec("DROP TRIGGER credit_test_block_usage");
  settleCreditRequest(requestId, {
    state: "reported",
    usage: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
  });
  assert.equal(getCreditBalance(ALICE).consumedTokens, 15);
  assert.equal(usageRows(requestId).length, 1);
  closeCreditRoot(permit);
});

test("a failed audit insert rolls back the balance update", () => {
  const granted = grant(ALICE, 10);
  assert.equal(granted.version, 2);
  db.exec(
    "CREATE TRIGGER credit_test_block_audit BEFORE INSERT ON token_credit_audit BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END",
  );

  const retryMutation = mutationId();
  assert.throws(() =>
    mutateCreditAccount(ADMIN, ALICE, {
      action: "set",
      creditTokens: 20,
      expectedVersion: 2,
      mutationId: retryMutation,
      reason: "raise",
    }),
  );
  let balance = getCreditBalance(ALICE);
  assert.equal(balance.creditTokens, 10);
  assert.equal(balance.version, 2);
  assert.equal(auditCount(ALICE), 1);

  db.exec("DROP TRIGGER credit_test_block_audit");
  const retried = mutateCreditAccount(ADMIN, ALICE, {
    action: "set",
    creditTokens: 20,
    expectedVersion: 2,
    mutationId: retryMutation,
    reason: "raise",
  });
  balance = getCreditBalance(ALICE);
  assert.equal(retried.creditTokens, 20);
  assert.equal(balance.creditTokens, 20);
  assert.equal(balance.version, 3);
  assert.equal(auditCount(ALICE), 2);
});

test("invalid reported totals are unknown and numeric overflow rolls back rather than clipping", () => {
  grant(ALICE, 100);
  const permit = admitCreditRoot(ALICE, "chat");
  const id = beginCreditRequest(permit, { providerId: "provider-a", modelId: "model-a", kind: "chat" });
  markCreditDispatched(id);
  settleCreditRequest(id, { state: "reported", usage: { input: NaN, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0 });
  assert.equal(requestRow(id).state, "unknown");
  assert.equal(usageRows(id).length, 0);
  closeCreditRoot(permit);

  const root = admitCreditRoot(BOB, "chat");
  const overflow = beginCreditRequest(root, { providerId: "provider-a", modelId: "model-a", kind: "chat" });
  markCreditDispatched(overflow);
  db.prepare("UPDATE token_credit_accounts SET consumed_tokens=? WHERE user_id=?").run(Number.MAX_SAFE_INTEGER, BOB);
  assert.throws(() => settleCreditRequest(overflow, { state: "reported", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0 }));
  assert.equal(requestRow(overflow).state, "open");
  assert.equal(getCreditBalance(BOB).consumedTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(usageRows(overflow).length, 0);
  expectCreditError(() => closeCreditRoot(root), CODES.busy);
});

test("temporary roots never retain thread ids and malformed metadata is refused before dispatch", () => {
  const permit = admitCreditRoot(ALICE, "temporary");
  expectCreditError(() => beginCreditRequest(permit, { providerId: "p", modelId: "m", kind: "chat", context: { threadId: "temporary-id" } }), CODES.validation);
  expectCreditError(() => beginCreditRequest(permit, { providerId: "p".repeat(501), modelId: "m", kind: "chat" }), CODES.validation);
  expectCreditError(() => beginCreditRequest(permit, { providerId: "p", modelId: "m", kind: "chat", context: { runId: "\n" } }), CODES.validation);
  const request = beginCreditRequest(permit, { providerId: "p", modelId: "m", kind: "chat" });
  settleCreditRequest(request, { state: "not_dispatched" });
  closeCreditRoot(permit); closeCreditRoot(permit);
});
