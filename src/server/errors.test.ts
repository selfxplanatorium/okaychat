import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { parseErrorWire } from "../shared/errors.js";
import { AppError, appErrorFromStatus, handleAppError, redactSecrets, toWireError, type AppErrorInit } from "./errors.js";

test("an AppError becomes a safe wire response and keeps its status", async () => {
  const app = new Hono()
    .get("/boom", () => {
      throw new AppError({
        code: "service_unavailable",
        message: "A service this needs is unavailable.",
        details: { apiKey: "sk-proj-SECRET1234567890", prompt: "PROMPT_SECRET", stack: "SECRET_STACK" },
      });
    })
    .onError(handleAppError);
  const response = await app.request("http://app/boom");
  assert.equal(response.status, 503);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.code, "service_unavailable");
  assert.equal(body.error, body.message);
  const text = JSON.stringify(body);
  for (const secret of ["SECRET", "PROMPT_SECRET", "SECRET_STACK", "apiKey", "details"]) assert.ok(!text.includes(secret), secret);
});

test("a 429 is a retryable rate limit, not a conflict", () => {
  const error = appErrorFromStatus(429, "Too many speech requests at once. Wait a moment.");
  assert.equal(error.code, "rate_limited");
  assert.equal(error.status, 429);
  assert.equal(error.retryable, true);
});

test("a route HTTPException keeps its message and gains a code", async () => {
  const app = new Hono()
    .get("/missing", () => { throw new HTTPException(404, { message: "Thread not found" }); })
    .onError(handleAppError);
  const response = await app.request("http://app/missing");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "Thread not found",
    code: "not_found",
    message: "Thread not found",
    retryable: false,
    hint: "It may have been deleted. Refresh and try again.",
  });
});

test("an unidentified failure gets a reference and no stack or raw message", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const app = new Hono()
    .get("/x", () => { throw new Error("raw SQL and PROMPT_SECRET at https://auth.openai.com/authorize?code=SECRET_CODE&state=SECRET_STATE"); })
    .onError(handleAppError);
  const response = await app.request("http://app/x");
  assert.equal(response.status, 500);
  const body = (await response.json()) as { code: string; ref: string; error: string };
  assert.equal(body.code, "unknown");
  assert.match(body.ref, /^[0-9a-f]{8}$/);
  assert.ok(!JSON.stringify(body).includes("PROMPT_SECRET"));
  assert.match(body.error, /server log has details/);
  // The server log keeps the diagnostic but never the authorization URL's query values.
  const line = JSON.stringify(logged.mock.calls[0]?.arguments ?? []);
  assert.ok(!line.includes("SECRET_CODE"), line);
  assert.ok(!line.includes("SECRET_STATE"), line);
  assert.match(line, /PROMPT_SECRET/);

  const wire = toWireError(new AppError({ code: "unknown", message: "Something went wrong.", hint: "The server log has details.", ref: "abcd1234" }));
  assert.equal(wire.code, "unknown");
  assert.equal(wire.ref, "abcd1234");
  assert.ok(!JSON.stringify(wire).includes("stack"));
});

test("authored feature, recovery, and provider diagnostics round-trip while unsafe values are dropped", () => {
  const authored = new AppError({
    code: "provider_quota",
    featureCode: "chatgpt_plan_disabled",
    providerCode: "subscription_sharing_usage_limit_exceeded",
    providerParam: "tools[0].name",
    recoveryAction: "manage_chatgpt_usage",
  });
  assert.deepEqual(toWireError(authored), {
    code: "provider_quota",
    message: "The provider account is out of quota.",
    hint: "Add credit to the provider account or switch providers.",
    retryable: false,
    featureCode: "chatgpt_plan_disabled",
    providerCode: "subscription_sharing_usage_limit_exceeded",
    providerParam: "tools[0].name",
    recoveryAction: "manage_chatgpt_usage",
  });

  // A forged wire (an upstream URL, free text, an oversized value) never becomes an authored field.
  const unsafe = new AppError({
    code: "forbidden",
    featureCode: "https://example.test/steal",
    providerCode: "https://auth.openai.com/authorize?code=SECRET_CODE",
    providerParam: "x".repeat(201),
    recoveryAction: "open_url",
  } as unknown as AppErrorInit);
  const wire = toWireError(unsafe);
  assert.equal(wire.featureCode, undefined);
  assert.equal(wire.providerCode, undefined);
  assert.equal(wire.providerParam, undefined);
  assert.equal(wire.recoveryAction, undefined);
  assert.ok(!JSON.stringify(wire).includes("example.test"));
  assert.ok(!JSON.stringify(wire).includes("SECRET_CODE"));
});

test("parseErrorWire keeps only the authored lists and bounds provider diagnostics", () => {
  const wire = parseErrorWire(JSON.stringify({
    code: "forbidden",
    message: "Not available.",
    retryable: false,
    featureCode: "chatgpt_reconnect_required",
    providerCode: "subscription_sharing_invalid_user",
    providerParam: "model",
    recoveryAction: "reconnect_chatgpt",
  }));
  assert.deepEqual(wire, {
    code: "forbidden",
    message: "Not available.",
    retryable: false,
    featureCode: "chatgpt_reconnect_required",
    providerCode: "subscription_sharing_invalid_user",
    providerParam: "model",
    recoveryAction: "reconnect_chatgpt",
  });

  const forged = parseErrorWire({
    code: "forbidden",
    message: "Not available.",
    retryable: false,
    featureCode: "made_up",
    providerCode: "https://auth.openai.com/authorize?code=SECRET_CODE",
    providerParam: "a b",
    recoveryAction: "open_url",
  });
  assert.equal(forged?.featureCode, undefined);
  assert.equal(forged?.providerCode, undefined);
  assert.equal(forged?.providerParam, undefined);
  assert.equal(forged?.recoveryAction, undefined);

  const bounded = (value: string) => parseErrorWire({ code: "forbidden", message: "x", retryable: false, providerCode: value })?.providerCode;
  assert.equal(bounded("a".repeat(200)), "a".repeat(200));
  assert.equal(bounded("a".repeat(201)), undefined);
  assert.equal(bounded("data:text/html,SECRET"), undefined);
});

test("redaction catches quoted JSON keys, bearer headers, and metadata dumps", () => {
  const cases = [
    '{"apiKey":"sk-not-a-real-value-but-secret"}',
    '{"api_key":"plain-value-123456"}',
    '{"Authorization":"Bearer abcdefghijklmnop"}',
    '"access_token":"token-value-abcdef"',
    '{"metadata":{"authorization":"Basic dXNlcjpwYXNz"}}',
    '{"headers":{"x-api-key":"header-secret-value"}}',
    "token=raw-token-value&prompt=SECRET_PROMPT",
  ];
  for (const input of cases) {
    const out = redactSecrets(input);
    for (const secret of ["not-a-real-value", "plain-value", "abcdefghijklmnop", "token-value", "dXNlcjpwYXNz", "header-secret-value", "raw-token-value"]) {
      assert.ok(!out.includes(secret), `${secret} leaked from ${input}: ${out}`);
    }
  }
  // A prompt is not a key; redaction must not pretend it hides prompt text.
  assert.match(redactSecrets("prompt=SECRET_PROMPT"), /SECRET_PROMPT/);
});
