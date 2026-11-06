import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_TOKEN_CREDIT } from "@shared/token-credits";
import { creditMutationId, isTokenCreditBalance, parseCreditAmount } from "./token-credits.js";

test("allowance retries carry a UUID-format mutation id on any origin", () => {
  const first = creditMutationId();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(creditMutationId(), first);
});

test("an allowance is a whole safe token count, and a blank field is invalid rather than Unlimited", () => {
  assert.equal(parseCreditAmount(""), undefined);
  assert.equal(parseCreditAmount("  "), undefined);
  assert.equal(parseCreditAmount("1.5"), undefined);
  assert.equal(parseCreditAmount("-1"), undefined);
  assert.equal(parseCreditAmount("1e6"), undefined);
  assert.equal(parseCreditAmount("0"), 0);
  assert.equal(parseCreditAmount("100000"), 100000);
  assert.equal(parseCreditAmount(String(MAX_TOKEN_CREDIT)), MAX_TOKEN_CREDIT);
  assert.equal(parseCreditAmount(String(MAX_TOKEN_CREDIT + 1)), undefined);
});

test("a malformed balance is rejected instead of reading as unlimited or zero", () => {
  const finite = {
    creditTokens: 1000, consumedTokens: 250, remainingTokens: 750, unknownRequests: 0,
    period: 1, periodStartedAt: 1, resetPolicy: "manual", version: 1,
    status: "available", activeOperations: 0, asOf: 2,
  };
  assert.equal(isTokenCreditBalance(finite), true);
  assert.equal(isTokenCreditBalance({ ...finite, creditTokens: undefined }), false);
  assert.equal(isTokenCreditBalance({ ...finite, unknownRequests: -1 }), false);
  assert.equal(isTokenCreditBalance({ ...finite, status: "maybe" }), false);
  assert.equal(isTokenCreditBalance("<html>not mounted</html>"), false);
  assert.equal(isTokenCreditBalance(null), false);
});
