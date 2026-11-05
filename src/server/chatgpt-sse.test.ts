import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "./errors.js";
import {
  SseLimitError,
  chatgptFailureStatus,
  collectCompletedResponse,
  guardStreamingResponse,
  readSseEvents,
} from "./chatgpt-sse.js";

const encoder = new TextEncoder();

function stream(chunks: Array<string | Uint8Array>, close = true): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      if (close) controller.close();
    },
  });
}

function sse(...events: object[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", "x-request-id": "req_1" },
  });
}

async function events(body: ReadableStream<Uint8Array>, options?: { maxBytes?: number }) {
  const out = [];
  for await (const event of readSseEvents(body, options)) out.push(event);
  return out;
}

test("parses fragmented UTF-8, CRLF, comments, multiline data and a BOM", async () => {
  const text = "\uFEFF: keep-alive\r\nevent: message\r\ndata: {\"a\":1}\r\ndata: second\r\n\r\n" + "data: café\n\n";
  const bytes = encoder.encode(text);
  // Split inside the multi-byte é so the decoder has to carry state across chunks.
  const split = bytes.indexOf(0xc3);
  const out = await events(stream([bytes.slice(0, split + 1), bytes.slice(split + 1)]));
  assert.deepEqual(out, [
    { event: "message", data: '{"a":1}\nsecond' },
    { data: "café" },
  ]);
});

test("handles lone CR line endings and discards an incomplete event at EOF", async () => {
  const out = await events(stream(["data: one\r\rdata: two\r\rdata: unfinished"]));
  assert.deepEqual(out, [{ data: "one" }, { data: "two" }]);
});

test("bounds the parser by bytes", async () => {
  await assert.rejects(events(stream(["data: " + "x".repeat(200) + "\n\n"]), { maxBytes: 32 }), SseLimitError);
});

test("rebuilds a completed utility response as JSON and keeps request ids", async () => {
  const res = await collectCompletedResponse(
    sse(
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "ignored" },
      { type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 7, output_tokens: 2 } } },
    ),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-request-id"), "req_1");
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(await res.json(), { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 7, output_tokens: 2 } });
});

test("only response.completed is success: failed, incomplete and EOF are safe failures", async () => {
  const failed = await collectCompletedResponse(
    sse({ type: "response.failed", response: { status: 429, error: { code: "subscription_sharing_usage_limit_exceeded" } } }),
  );
  assert.equal(failed.status, 402);
  assert.equal(((await failed.json()) as { error: { code: string } }).error.code, "subscription_sharing_usage_limit_exceeded");

  const incomplete = await collectCompletedResponse(sse({ type: "response.incomplete", response: { status: "incomplete" } }));
  assert.equal(incomplete.status, 422);
  assert.equal(((await incomplete.json()) as { error: { code: string } }).error.code, "response_incomplete");

  const interrupted = await collectCompletedResponse(sse({ type: "response.output_text.delta", delta: "part" }));
  assert.equal(interrupted.status, 502);
  assert.equal(((await interrupted.json()) as { error: { code: string } }).error.code, "response_interrupted");
});

test("maps plan failures to statuses that preserve quota and avoid generic rate retries", () => {
  assert.equal(chatgptFailureStatus("subscription_sharing_usage_limit_exceeded", 429), 402);
  assert.equal(chatgptFailureStatus("subscription_sharing_unsupported_capability", 400), 400);
  assert.equal(chatgptFailureStatus("subscription_sharing_user_not_eligible", 403), 403);
  assert.equal(chatgptFailureStatus(undefined, 503), 503);
  assert.equal(chatgptFailureStatus(undefined, undefined), 502);
});

test("aborts and deadlines stop an endless utility stream", async () => {
  const endless = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
      },
    });
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 5);
  await assert.rejects(collectCompletedResponse(new Response(endless()), { signal: abort.signal }), (error) => (error as Error).name === "AbortError");

  await assert.rejects(
    collectCompletedResponse(new Response(endless()), { timeoutMs: 5 }),
    (error) => error instanceof AppError && error.code === "timeout",
  );
});

test("stream guard forwards a completed stream unchanged", async () => {
  const body = 'data: {"type":"response.completed","response":{"id":"ok"}}\n\n';
  const guarded = guardStreamingResponse(sse({ type: "response.completed", response: { id: "ok" } }));
  assert.equal(await guarded.text(), body);
});

test("stream guard appends an interrupted error when EOF has no terminal event", async () => {
  const body = 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n';
  const guarded = guardStreamingResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const text = await guarded.text();
  assert.equal(text.startsWith(body), true);
  const appended = text.slice(body.length);
  const parsed = JSON.parse(appended.trim().replace(/^data: /, "")) as { type: string; code: string };
  assert.deepEqual(parsed, { type: "error", code: "response_interrupted", message: "ChatGPT ended the stream before completion." });
});

test("cancelling a guarded stream aborts the upstream request", async () => {
  let aborted = false;
  let upstreamCancelled = false;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": keep-alive\n\n"));
    },
    cancel() {
      upstreamCancelled = true;
    },
  });
  const guarded = guardStreamingResponse(new Response(upstream, { headers: { "content-type": "text/event-stream" } }), {
    abort: () => {
      aborted = true;
    },
  });
  const reader = guarded.body!.getReader();
  await reader.read();
  await reader.cancel("stop");
  assert.equal(aborted, true);
  assert.equal(upstreamCancelled, true);
});
