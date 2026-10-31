import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { AppError, handleAppError, toWireError } from "./errors.js";

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
  t.mock.method(console, "error", () => {});
  const app = new Hono()
    .get("/x", () => { throw new Error("raw SQL and PROMPT_SECRET"); })
    .onError(handleAppError);
  const response = await app.request("http://app/x");
  assert.equal(response.status, 500);
  const body = (await response.json()) as { code: string; ref: string; error: string };
  assert.equal(body.code, "unknown");
  assert.match(body.ref, /^[0-9a-f]{8}$/);
  assert.ok(!JSON.stringify(body).includes("PROMPT_SECRET"));
  assert.match(body.error, /server log has details/);

  const wire = toWireError(new AppError({ code: "unknown", message: "Something went wrong.", hint: "The server log has details.", ref: "abcd1234" }));
  assert.equal(wire.code, "unknown");
  assert.equal(wire.ref, "abcd1234");
  assert.ok(!JSON.stringify(wire).includes("stack"));
});
