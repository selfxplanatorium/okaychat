import assert from "node:assert/strict";
import { test } from "node:test";
import type { N8nResponseMode } from "../../shared/n8n-agents.js";
import { AppError } from "../errors.js";
import { PARSER_LIMITS, parseAgentResponse, type AgentEvent } from "./parser.js";

// Section 11.1 of the n8n agents spec. Every body below is a literal, sanitized fixture: no real
// workflow export, endpoint, credential, or conversation appears here.

const encoder = new TextEncoder();

interface RunOptions {
  mode?: N8nResponseMode;
  pointer?: string | null;
  signal?: AbortSignal;
}

const jsonResponse = (body: string, contentType: string | null = "application/json", status = 200) =>
  new Response(body, { status, headers: contentType === null ? {} : { "content-type": contentType } });

const streamResponse = (chunks: Uint8Array[], contentType: string | null = "application/json") => {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
  });
  return new Response(stream, { headers: contentType === null ? {} : { "content-type": contentType } });
};

/** A stream that yields the given chunks and then never ends, so cancellation is observable. */
const endlessResponse = (chunks: Uint8Array[], onCancel: () => void, contentType = "application/json") => {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]!);
        return;
      }
      return new Promise<void>(() => {});
    },
    cancel() {
      onCancel();
    },
  });
  return new Response(stream, { headers: { "content-type": contentType } });
};

async function outcome(response: Response, options: RunOptions = {}): Promise<{ events: AgentEvent[]; error: AppError | null }> {
  const events: AgentEvent[] = [];
  try {
    for await (const event of parseAgentResponse(response, {
      mode: options.mode ?? "auto",
      responsePointer: options.pointer ?? null,
      signal: options.signal ?? new AbortController().signal,
    })) {
      events.push(event);
    }
    return { events, error: null };
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    return { events, error };
  }
}

async function run(response: Response, options: RunOptions = {}): Promise<AgentEvent[]> {
  const { events, error } = await outcome(response, options);
  assert.equal(error, null, error?.message);
  return events;
}

const textOf = (events: AgentEvent[]) => events.filter((e) => e.type === "text").map((e) => e.text).join("");
const modesOf = (events: AgentEvent[]) => events.filter((e) => e.type === "mode").map((e) => e.mode);
const startsOf = (events: AgentEvent[]) => events.filter((e) => e.type === "segment-start").map((e) => e.segmentId);
const endsOf = (events: AgentEvent[]) => events.filter((e) => e.type === "segment-end").map((e) => e.segmentId);

/** Merges adjacent text deltas of one segment so a byte partition cannot change the comparison. */
function normalize(events: AgentEvent[]): AgentEvent[] {
  const merged: AgentEvent[] = [];
  for (const event of events) {
    const previous = merged.at(-1);
    if (event.type === "text" && previous?.type === "text" && previous.segmentId === event.segmentId) {
      merged[merged.length - 1] = { type: "text", segmentId: event.segmentId, text: previous.text + event.text };
    } else {
      merged.push(event);
    }
  }
  return merged;
}

const frame = (type: "begin" | "item" | "end" | "error", content?: unknown, metadata?: Record<string, unknown>) =>
  JSON.stringify({ type, ...(content === undefined ? {} : { content }), ...(metadata === undefined ? {} : { metadata }) });

const node = (nodeId: string, runIndex = 0, itemIndex = 0) => ({ nodeId, nodeName: "Agent", itemIndex, runIndex, timestamp: 1_762_345_678_901 });

// The verified workflow's sanitized response shape: NDJSON labelled application/json.
const LIVE_LINES = [
  frame("begin", undefined, node("agent")),
  frame("item", "OKAYCHAT_PRO", node("agent")),
  frame("item", "BE", node("agent")),
  frame("end", undefined, node("agent")),
];
const LIVE_FIXTURE = `${LIVE_LINES.join("\n")}\n`;

// Same protocol with a non-ASCII payload, used for every byte split.
const UNICODE_LINES = [
  frame("begin", undefined, node("agent")),
  frame("item", "héllo 🌍 ", node("agent")),
  frame("item", "Ok—fine\u2028", node("agent")),
  frame("end", undefined, node("agent")),
];
const UNICODE_FIXTURE = `${UNICODE_LINES.join("\n")}\n`;
const UNICODE_TEXT = "héllo 🌍 Ok—fine\u2028";

const bytesOf = (text: string) => encoder.encode(text);

function partitions(bytes: Uint8Array, count: number): Uint8Array[][] {
  const result: Uint8Array[][] = [];
  for (let i = 0; i <= count; i++) {
    result.push([bytes.slice(0, i), bytes.slice(i)]);
  }
  return result;
}

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomPartition(bytes: Uint8Array, random: () => number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const size = 1 + Math.floor(random() * 17);
    chunks.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
}

function nestedObjects(levels: number): string {
  let value: unknown = "deep";
  for (let i = 0; i < levels; i++) value = { content: value };
  return JSON.stringify({ output: value });
}

// ---------------------------------------------------------------------------------------------
// Framing, byte splits, line endings, BOM

test("the live begin/item/end fixture under JSON MIME resolves to NDJSON with exactly-once deltas", async () => {
  const events = await run(jsonResponse(LIVE_FIXTURE));
  assert.deepEqual(modesOf(events), ["ndjson"]);
  assert.equal(events[0]?.type, "mode");
  assert.deepEqual(startsOf(events), ["agent-text-0"]);
  assert.deepEqual(endsOf(events), ["agent-text-0"]);
  assert.equal(textOf(events), "OKAYCHAT_PROBE");
  assert.equal(events.filter((e) => e.type === "text").length, 2);
  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(events, [
    { type: "mode", mode: "ndjson" },
    { type: "segment-start", segmentId: "agent-text-0" },
    { type: "text", segmentId: "agent-text-0", text: "OKAYCHAT_PRO" },
    { type: "text", segmentId: "agent-text-0", text: "BE" },
    { type: "segment-end", segmentId: "agent-text-0" },
    { type: "done" },
  ]);
});

test("every possible byte split of the live and multibyte fixtures produces identical events", async () => {
  for (const [fixture, expected] of [
    [LIVE_FIXTURE, "OKAYCHAT_PROBE"],
    [UNICODE_FIXTURE, UNICODE_TEXT],
    [`\uFEFF${LIVE_FIXTURE}`, "OKAYCHAT_PROBE"],
    [`${LIVE_LINES.join("\r\n")}\r\n`, "OKAYCHAT_PROBE"],
  ] as const) {
    const bytes = bytesOf(fixture);
    const baseline = normalize(await run(jsonResponse(fixture)));
    assert.equal(textOf(baseline), expected);
    for (const chunks of partitions(bytes, bytes.length)) {
      const events = normalize(await run(streamResponse(chunks)));
      assert.deepEqual(events, baseline, `split at byte ${chunks[0]?.length ?? 0}`);
    }
  }
});

test("CRLF framing, a BOM at the start, and a missing final LF parse identically", async () => {
  const baseline = normalize(await run(jsonResponse(LIVE_FIXTURE)));
  const crlf = normalize(await run(jsonResponse(`${LIVE_LINES.join("\r\n")}\r\n`)));
  const bom = normalize(await run(jsonResponse(`\uFEFF${LIVE_FIXTURE}`)));
  const noFinalLf = normalize(await run(jsonResponse(LIVE_LINES.join("\n"))));
  assert.deepEqual(crlf, baseline);
  assert.deepEqual(bom, baseline);
  assert.deepEqual(noFinalLf, baseline);
  assert.equal(textOf(baseline), "OKAYCHAT_PROBE");
});

test("multiple records per chunk and one record per chunk give the same text", async () => {
  const oneChunk = await run(jsonResponse(LIVE_FIXTURE));
  const perLine = await run(streamResponse(LIVE_LINES.map((line) => bytesOf(`${line}\n`))));
  const mixed = await run(streamResponse([bytesOf(`${LIVE_LINES[0]!}\n`), bytesOf(`${LIVE_LINES.slice(1).join("\n")}\n`)]));
  assert.equal(textOf(oneChunk), "OKAYCHAT_PROBE");
  assert.equal(textOf(perLine), "OKAYCHAT_PROBE");
  assert.equal(textOf(mixed), "OKAYCHAT_PROBE");
});

test("deterministic random byte partitions yield identical normalized events", async () => {
  for (const [fixture, expected] of [
    [LIVE_FIXTURE, "OKAYCHAT_PROBE"],
    [UNICODE_FIXTURE, UNICODE_TEXT],
  ] as const) {
    const bytes = bytesOf(fixture);
    const baseline = normalize(await run(jsonResponse(fixture)));
    for (let seed = 1; seed <= 40; seed++) {
      const events = normalize(await run(streamResponse(randomPartition(bytes, seeded(seed)))));
      assert.deepEqual(events, baseline, `seed ${seed}`);
    }
    assert.equal(textOf(baseline), expected);
  }
});

// ---------------------------------------------------------------------------------------------
// Mode selection

test("explicit modes interpret the body without sniffing", async () => {
  assert.deepEqual(modesOf(await run(jsonResponse(LIVE_FIXTURE), { mode: "ndjson" })), ["ndjson"]);
  assert.equal(textOf(await run(jsonResponse(LIVE_FIXTURE), { mode: "ndjson" })), "OKAYCHAT_PROBE");
  assert.equal(textOf(await run(jsonResponse("{\"output\":\"x\"}", "text/plain"), { mode: "json" })), "x");
  assert.equal(textOf(await run(jsonResponse("{\"output\":\"x\"}", "application/json"), { mode: "text" })), "{\"output\":\"x\"}");
  assert.equal(textOf(await run(jsonResponse("data: {\"type\":\"begin\"}\n\ndata: {\"type\":\"item\",\"content\":\"s\"}\n\ndata: {\"type\":\"end\"}\n\n", "text/plain"), { mode: "sse" })), "s");
  assert.deepEqual(modesOf(await run(jsonResponse("plain body", null), { mode: "text" })), ["text"]);
});

test("auto mode uses MIME for SSE and NDJSON", async () => {
  assert.deepEqual(modesOf(await run(jsonResponse("data: {\"type\":\"begin\"}\n\ndata: {\"type\":\"item\",\"content\":\"s\"}\n\ndata: {\"type\":\"end\"}\n\n", "text/event-stream"))), ["sse"]);
  assert.deepEqual(modesOf(await run(jsonResponse(LIVE_FIXTURE, "application/x-ndjson"))), ["ndjson"]);
  assert.deepEqual(modesOf(await run(jsonResponse(LIVE_FIXTURE, "application/ndjson; charset=utf-8"))), ["ndjson"]);
});

test("auto mode locks NDJSON when a JSON-labelled first line is a frame", async () => {
  assert.deepEqual(modesOf(await run(jsonResponse(LIVE_FIXTURE))), ["ndjson"]);
  assert.deepEqual(modesOf(await run(jsonResponse(LIVE_FIXTURE, "text/plain"))), ["ndjson"]);
});

test("auto mode reads pretty JSON, arrays, and root strings", async () => {
  assert.equal(textOf(await run(jsonResponse('{\n  "output": "pretty"\n}\n'))), "pretty");
  assert.equal(textOf(await run(jsonResponse('["first", "second"]'))), "first\n\nsecond");
  assert.equal(textOf(await run(jsonResponse('"root string"'))), "root string");
  assert.equal(textOf(await run(jsonResponse('{"message":{"text":"nested"}}'))), "nested");
});

test("auto mode streams other text and preserves spaces", async () => {
  const events = await run(jsonResponse("  hello  world  ", "text/plain"));
  assert.deepEqual(modesOf(events), ["text"]);
  assert.equal(textOf(events), "  hello  world  ");
  assert.deepEqual(startsOf(events), ["agent-text-0"]);
});

test("auto mode accepts a +json media type instead of treating it as binary", async () => {
  assert.deepEqual(modesOf(await run(jsonResponse('{"output":"vendor"}', "application/vnd.api+json"))), ["json"]);
  assert.equal(textOf(await run(jsonResponse('{"output":"vendor"}', "application/vnd.api+json"))), "vendor");
});

test("auto mode rejects HTML and binary media types; forced text accepts HTML as text", async () => {
  const html = await outcome(jsonResponse("<html><body>login</body></html>", "text/html"));
  assert.equal(html.error?.code, "agent_response");
  assert.equal(html.error?.agentReason, "html");
  assert.equal(textOf(await run(jsonResponse("<html><body>login</body></html>", "text/html"), { mode: "text" })), "<html><body>login</body></html>");

  for (const mime of ["image/png", "audio/mpeg", "video/mp4", "font/woff2", "application/pdf", "application/octet-stream", "application/zip", "multipart/form-data"]) {
    const result = await outcome(jsonResponse("payload", mime));
    assert.equal(result.error?.code, "agent_response", mime);
    assert.equal(result.error?.agentReason, "malformed", mime);
    assert.equal(textOf(result.events), "", mime);
  }
});

test("empty, whitespace, acknowledgement, and 204 bodies fail safely", async () => {
  for (const body of ["", "   \n\t"]) {
    const empty = await outcome(jsonResponse(body));
    assert.equal(empty.error?.agentReason, "empty", JSON.stringify(body));
  }
  const noContent = await outcome(new Response(null, { status: 204, headers: { "content-type": "application/json" } }));
  assert.equal(noContent.error?.agentReason, "empty");

  for (const body of ["Workflow got started.", "Workflow got started.\n", "\n\nWorkflow got started.\n"]) {
    const ack = await outcome(jsonResponse(body, "text/plain"));
    assert.equal(ack.error?.agentReason, "acknowledged", JSON.stringify(body));
  }
  const jsonAck = await outcome(jsonResponse('"Workflow got started."'));
  assert.equal(jsonAck.error?.agentReason, "acknowledged");
});

// ---------------------------------------------------------------------------------------------
// SSE

test("SSE joins multiline data, ignores comments and control fields, and dispatches a final record", async () => {
  const body = [
    ": heartbeat",
    "event: message",
    "id: 7",
    "retry: 1000",
    'data: {"type":"begin",',
    'data: "metadata":{"nodeId":"a"}}',
    "",
    "data: {\"type\":\"item\",\"content\":\"multi\",\"metadata\":{\"nodeId\":\"a\"}}",
    "",
    "data: {\"type\":\"end\",\"metadata\":{\"nodeId\":\"a\"}}",
  ].join("\n");
  const events = await run(jsonResponse(body, "text/event-stream"));
  assert.deepEqual(modesOf(events), ["sse"]);
  assert.equal(textOf(events), "multi");
  assert.equal(events.at(-1)?.type, "done");
});

test("SSE stops at [DONE] and cancels the rest of the body", async () => {
  let cancelled = false;
  const chunks = [bytesOf('data: {"type":"begin"}\n\ndata: {"type":"item","content":"answer"}\n\ndata: {"type":"end"}\n\ndata: [DONE]\n\ndata: {"type":"item","content":"late"}\n\n')];
  const events = await run(endlessResponse(chunks, () => { cancelled = true; }, "text/event-stream"));
  assert.equal(textOf(events), "answer");
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(cancelled, true);
});

test("SSE [DONE] while a node run is open is truncated", async () => {
  const body = 'data: {"type":"begin"}\n\ndata: {"type":"item","content":"partial"}\n\ndata: [DONE]\n\n';
  const result = await outcome(jsonResponse(body, "text/event-stream"));
  assert.equal(result.error?.agentReason, "truncated");
});

test("SSE malformed data, arrays, and unknown events fail as agent_response", async () => {
  for (const payload of ["{nope", "[1,2]", "{\"type\":\"chunk\"}", "null"]) {
    const result = await outcome(jsonResponse(`data: ${payload}\n\n`, "text/event-stream"));
    assert.equal(result.error?.code, "agent_response", payload);
    assert.equal(result.error?.agentReason, "malformed", payload);
  }
});

test("an SSE event error is terminal after text and is never assistant text", async () => {
  const body = [
    'data: {"type":"item","content":"partial"}',
    "",
    'data: {"type":"error","content":"SECRET_UPSTREAM_DETAIL"}',
    "",
  ].join("\n");
  const result = await outcome(jsonResponse(body, "text/event-stream"));
  assert.equal(result.error?.code, "agent_failed");
  assert.equal(textOf(result.events), "partial");
  assert.ok(!JSON.stringify(result.error).includes("SECRET_UPSTREAM_DETAIL"));
});

// ---------------------------------------------------------------------------------------------
// Content extraction

test("output/text/message/content precedence is by presence, not truthiness", async () => {
  assert.equal(textOf(await run(jsonResponse('{"output":"o","text":"t"}'))), "o");
  assert.equal(textOf(await run(jsonResponse('{"text":"t","message":"m"}'))), "t");
  assert.equal(textOf(await run(jsonResponse('{"message":"m","content":"c"}'))), "m");
  assert.equal(textOf(await run(jsonResponse('{"content":"c"}'))), "c");
  assert.equal(textOf(await run(jsonResponse('{"output":"o","content":"c"}'))), "o");
  assert.equal(textOf(await run(jsonResponse('{"output":{"text":"inner"}}'))), "inner");
  assert.equal(textOf(await run(jsonResponse('{"message":{"text":"msg"}}'))), "msg");
  const emptyPreferred = await outcome(jsonResponse('{"output":"","text":"fallback"}'));
  assert.equal(emptyPreferred.error?.agentReason, "empty");
});

test("the n8n {json} item wrapper is used only without a recognized text key", async () => {
  assert.equal(textOf(await run(jsonResponse('{"json":{"output":"wrapped"}}'))), "wrapped");
  assert.equal(textOf(await run(jsonResponse('{"json":{"output":"wrapped"},"output":"direct"}'))), "direct");
  assert.equal(textOf(await run(jsonResponse('{"json":{"text":"t"},"binary":{},"pairedItem":{"item":0}}'))), "t");
});

test("item content accepts strings, text blocks, and text objects", async () => {
  const block = frame("item", [{ type: "text", text: "a" }, { type: "output_text", text: "b" }, "c"]);
  const body = `${frame("begin")}\n${block}\n${frame("end")}\n`;
  assert.equal(textOf(await run(jsonResponse(body, "application/x-ndjson"))), "abc");
  assert.equal(textOf(await run(jsonResponse(`${frame("begin")}\n${frame("item", { text: "obj" })}\n${frame("end")}\n`, "application/x-ndjson"))), "obj");
  assert.equal(textOf(await run(jsonResponse(`${frame("begin")}\n${frame("item", { type: "message", text: "typed" })}\n${frame("end")}\n`, "application/x-ndjson"))), "typed");
});

test("unsupported content blocks fail instead of being stringified", async () => {
  for (const block of [[{ type: "image", source: {} }], [{ type: "tool_use", input: {} }], [1], [null]]) {
    const body = `${frame("begin")}\n${frame("item", block)}\n${frame("end")}\n`;
    const result = await outcome(jsonResponse(body, "application/x-ndjson"));
    assert.equal(result.error?.agentReason, "malformed", JSON.stringify(block));
  }
});

test("n8n message, with-buttons, and error frames normalize once, without recursive decoding", async () => {
  const withButtons = JSON.stringify({ type: "with-buttons", text: "choose", buttons: [{ title: "A", value: "a" }] });
  assert.equal(textOf(await run(jsonResponse(JSON.stringify({ type: "message", text: "plain" })))), "plain");
  assert.equal(textOf(await run(jsonResponse(withButtons))), "choose");

  const nested = JSON.stringify({ type: "message", text: JSON.stringify({ type: "message", text: "inner" }) });
  const body = `${frame("begin")}\n${frame("item", nested)}\n${frame("end")}\n`;
  assert.equal(textOf(await run(jsonResponse(body, "application/x-ndjson"))), JSON.stringify({ type: "message", text: "inner" }));

  const error = await outcome(jsonResponse(JSON.stringify({ type: "error", message: "SECRET_UPSTREAM" })));
  assert.equal(error.error?.code, "agent_failed");
  assert.ok(!JSON.stringify(error.error).includes("SECRET_UPSTREAM"));
});

test("JSON-looking strings that are not known frames stay verbatim", async () => {
  const code = '{"const": 1, "not": "a frame"}';
  const body = `${frame("begin")}\n${frame("item", code)}\n${frame("end")}\n`;
  assert.equal(textOf(await run(jsonResponse(body, "application/x-ndjson"))), code);
});

test("script, link, and image markup in content stays plain text", async () => {
  const samples = [
    "<script>alert('SECRET')</script>",
    "![alt](https://example.invalid/image.png)",
    '<img src=x onerror="alert(1)">',
    "[link](javascript:alert(1))",
  ];
  for (const sample of samples) {
    const body = `${frame("begin")}\n${frame("item", sample)}\n${frame("end")}\n`;
    assert.equal(textOf(await run(jsonResponse(body, "application/x-ndjson"))), sample);
  }
});

test("interactive and approval frames are refused, never rendered", async () => {
  for (const value of [
    { type: "with-buttons", text: "choose", blockUserInput: true },
    { resumeToken: "token", blockUserInput: true },
    { resumeToken: "token" },
  ]) {
    const result = await outcome(jsonResponse(JSON.stringify(value)));
    assert.equal(result.error?.agentReason, "interactive", JSON.stringify(value));
  }
  const started = await outcome(jsonResponse(JSON.stringify({ executionStarted: true })));
  assert.equal(started.error?.agentReason, "acknowledged");
  // An executionStarted frame that also carries the answer is still readable.
  assert.equal(textOf(await run(jsonResponse(JSON.stringify({ executionStarted: true, text: "answered" })))), "answered");
});

test("numbers, booleans, null, and arbitrary objects are refused", async () => {
  for (const body of ["42", "true", "null", '{"unknown":1}', "[]"]) {
    const result = await outcome(jsonResponse(body));
    assert.equal(result.error?.code, "agent_response", body);
  }
});

// ---------------------------------------------------------------------------------------------
// RFC 6901 pointers

test("a pointer reads root, object keys, array indexes, and escaped tokens", async () => {
  assert.equal(textOf(await run(jsonResponse('{"output":"root"}'), { pointer: "" })), "root");
  assert.equal(textOf(await run(jsonResponse('{"data":{"0":"zero"}}'), { pointer: "/data/0" })), "zero");
  assert.equal(textOf(await run(jsonResponse('{"data":["zero","one"]}'), { pointer: "/data/1" })), "one");
  assert.equal(textOf(await run(jsonResponse('{"a/b":"slash","m~n":"tilde"}'), { pointer: "/a~1b" })), "slash");
  assert.equal(textOf(await run(jsonResponse('{"a/b":"slash","m~n":"tilde"}'), { pointer: "/m~0n" })), "tilde");
  assert.equal(textOf(await run(jsonResponse('{"data":{"output":"x"}}'), { pointer: "/data" })), "x");
});

test("a pointer rejects missing nodes, malformed escapes, prototype keys, and too many segments", async () => {
  const cases = ["/missing", "/data/2", "/data/01", "/a~2b", "/__proto__", "/constructor", "/prototype", `/${Array.from({ length: 17 }, () => "a").join("/")}`];
  for (const pointer of cases) {
    const result = await outcome(jsonResponse('{"data":["zero","one"],"a":{"b":"c"}}'), { pointer });
    assert.equal(result.error?.agentReason, "malformed", pointer);
  }
  const sixteen = JSON.stringify({ a: { a: { a: { a: { a: { a: { a: { a: { a: { a: { a: { a: { a: { a: { a: { a: "deep" } } } } } } } } } } } } } } } });
  assert.equal(textOf(await run(jsonResponse(sixteen), { pointer: `/${Array.from({ length: 16 }, () => "a").join("/")}` })), "deep");
});

test("a pointer applies only to a whole JSON response", async () => {
  assert.equal(textOf(await run(jsonResponse('{"output":"literal"}', "text/plain"), { mode: "text", pointer: "/output" })), '{"output":"literal"}');
  const ndjson = `${frame("begin")}\n${frame("item", "framed")}\n${frame("end")}\n`;
  assert.equal(textOf(await run(jsonResponse(ndjson), { mode: "ndjson", pointer: "/output" })), "framed");
});

// ---------------------------------------------------------------------------------------------
// Multiple node runs and segments

test("multiple nodes and runs become separate segments with a blank-line boundary", async () => {
  const body = [
    frame("begin", undefined, node("a")),
    frame("item", "A1", node("a")),
    frame("begin", undefined, node("b", 1)),
    frame("item", "A2", node("a")),
    frame("item", "B1", node("b", 1)),
    frame("end", undefined, node("a")),
    frame("end", undefined, node("b", 1)),
  ].join("\n");
  const events = await run(jsonResponse(body, "application/x-ndjson"));
  assert.deepEqual(startsOf(events), ["agent-text-0", "agent-text-1"]);
  assert.deepEqual(endsOf(events), ["agent-text-0", "agent-text-1"]);
  assert.equal(textOf(events), "A1A2\n\nB1");
  // The first end does not finish the response; the second does.
  const endIndex = events.findIndex((e) => e.type === "segment-end");
  assert.equal(events.slice(endIndex + 1).some((e) => e.type === "done"), true);
  assert.equal(events.at(-1)?.type, "done");
});

test("different item indexes and a new begin after end open new segments", async () => {
  const body = [
    frame("begin", undefined, node("a")),
    frame("item", "one", node("a")),
    frame("end", undefined, node("a")),
    frame("begin", undefined, node("a")),
    frame("item", "two", node("a")),
    frame("end", undefined, node("a")),
    frame("begin", undefined, node("a", 0, 1)),
    frame("item", "three", node("a", 0, 1)),
    frame("end", undefined, node("a", 0, 1)),
  ].join("\n");
  const events = await run(jsonResponse(body, "application/x-ndjson"));
  assert.deepEqual(startsOf(events), ["agent-text-0", "agent-text-1", "agent-text-2"]);
  assert.equal(textOf(events), "one\n\ntwo\n\nthree");
});

test("repeated begin on an open run fails", async () => {
  const body = `${frame("begin", undefined, node("a"))}\n${frame("begin", undefined, node("a"))}\n`;
  const result = await outcome(jsonResponse(body, "application/x-ndjson"));
  assert.equal(result.error?.agentReason, "malformed");
});

test("legacy item/end without begin works, and an unmatched end is empty", async () => {
  const legacy = `${frame("item", "legacy")}\n${frame("end")}\n`;
  assert.equal(textOf(await run(jsonResponse(legacy, "application/x-ndjson"))), "legacy");
  const unmatched = await outcome(jsonResponse(`${frame("end")}\n`, "application/x-ndjson"));
  assert.equal(unmatched.error?.agentReason, "empty");
});

test("metadata identifiers are validated and never leak into segment ids", async () => {
  const invalid = [
    { metadata: [] },
    { metadata: null },
    { metadata: { nodeId: 7 } },
    { metadata: { nodeId: "n".repeat(201) } },
    { metadata: { runIndex: -1 } },
    { metadata: { runIndex: 1.5 } },
    { metadata: { itemIndex: "0" } },
  ];
  for (const value of invalid) {
    const result = await outcome(jsonResponse(`${frame("begin")}\n${JSON.stringify({ type: "item", content: "x", ...value })}\n`, "application/x-ndjson"));
    assert.equal(result.error?.agentReason, "malformed", JSON.stringify(value));
  }
  const body = `${frame("begin", undefined, { nodeId: "secret-remote-node" })}\n${frame("item", "x", { nodeId: "secret-remote-node" })}\n${frame("end", undefined, { nodeId: "secret-remote-node" })}\n`;
  const events = await run(jsonResponse(body, "application/x-ndjson"));
  assert.ok(!JSON.stringify(events).includes("secret-remote-node"));
  assert.deepEqual(startsOf(events), ["agent-text-0"]);
});

test("a stream that never closes its run is truncated, including an implicit run", async () => {
  const explicit = await outcome(jsonResponse(`${frame("begin")}\n${frame("item", "partial")}\n`, "application/x-ndjson"));
  assert.equal(explicit.error?.agentReason, "truncated");
  assert.equal(textOf(explicit.events), "partial");
  const implicit = await outcome(jsonResponse(`${frame("item", "partial")}\n`, "application/x-ndjson"));
  assert.equal(implicit.error?.agentReason, "truncated");
});

test("malformed, null, array, and unknown NDJSON events fail", async () => {
  for (const line of ["{nope", "null", "[1,2]", '{"type":"chunk"}', "42", '"text"']) {
    const result = await outcome(jsonResponse(`${line}\n`, "application/x-ndjson"));
    assert.equal(result.error?.agentReason, "malformed", line);
  }
});

test("framing-only and empty-string runs produce no text segment", async () => {
  const empty = await outcome(jsonResponse(`${frame("begin")}\n${frame("end")}\n`, "application/x-ndjson"));
  assert.equal(empty.error?.agentReason, "empty");
  assert.deepEqual(empty.events, [{ type: "mode", mode: "ndjson" }]);
  const blank = await outcome(jsonResponse(`${frame("begin")}\n${frame("item", "")}\n${frame("end")}\n`, "application/x-ndjson"));
  assert.equal(blank.error?.agentReason, "empty");
});

test("invalid UTF-8 and an incomplete trailing sequence fail as malformed", async () => {
  const invalid = await outcome(streamResponse([new Uint8Array([0xff, 0xfe])], "text/plain"));
  assert.equal(invalid.error?.agentReason, "malformed");
  const incomplete = await outcome(streamResponse([encoder.encode("hello "), new Uint8Array([0xe2])], "text/plain"));
  assert.equal(incomplete.error?.agentReason, "malformed");
});

// ---------------------------------------------------------------------------------------------
// Limits

test("the body byte limit is inclusive and one byte over fails after cancelling the reader", async () => {
  const payload = '{"output":"ok"}';
  const atLimit = " ".repeat(PARSER_LIMITS.bodyBytes - Buffer.byteLength(payload)) + payload;
  assert.equal(Buffer.byteLength(atLimit), PARSER_LIMITS.bodyBytes);
  assert.equal(textOf(await run(jsonResponse(atLimit), { mode: "json" })), "ok");

  let cancelled = false;
  const over = `${atLimit} `;
  const result = await outcome(endlessResponse([bytesOf(over)], () => { cancelled = true; }));
  assert.equal(result.error?.agentReason, "limit");
  assert.equal(cancelled, true);
});

test("the output text limit is inclusive and one byte over fails after cancelling the reader", async () => {
  const atLimit = JSON.stringify({ output: "a".repeat(PARSER_LIMITS.outputBytes) });
  assert.equal(textOf(await run(jsonResponse(atLimit), { mode: "json" })).length, PARSER_LIMITS.outputBytes);

  let cancelled = false;
  const over = JSON.stringify({ output: "a".repeat(PARSER_LIMITS.outputBytes + 1) });
  const result = await outcome(endlessResponse([bytesOf(over)], () => { cancelled = true; }));
  assert.equal(result.error?.agentReason, "limit");
  assert.equal(cancelled, true);
});

test("the NDJSON line limit is inclusive and one byte over fails", async () => {
  const prefix = '{"type":"item","content":"';
  const suffix = '"}';
  const padding = PARSER_LIMITS.lineBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  const atLimit = `${prefix}${"x".repeat(padding)}${suffix}`;
  assert.equal(Buffer.byteLength(atLimit), PARSER_LIMITS.lineBytes);
  const body = `${atLimit}\n${frame("end")}\n`;
  assert.equal(textOf(await run(jsonResponse(body), { mode: "ndjson" })).length, padding);

  const over = await outcome(jsonResponse(`${atLimit}x\n${frame("end")}\n`), { mode: "ndjson" });
  assert.equal(over.error?.agentReason, "limit");
});

test("the SSE event limit is inclusive across data lines and one byte over fails", async () => {
  const head = '{"type":"item",';
  const tailPrefix = '"content":"';
  const tailSuffix = '"}';
  // dataBytes counts each data value plus its separator newline.
  const tail = `${tailPrefix}${"y".repeat(PARSER_LIMITS.lineBytes - 2 - Buffer.byteLength(head) - Buffer.byteLength(tailPrefix) - Buffer.byteLength(tailSuffix))}${tailSuffix}`;
  const body = `data: {"type":"begin"}\n\ndata: ${head}\ndata: ${tail}\n\ndata: {"type":"end"}\n\n`;
  assert.equal(Buffer.byteLength(head) + Buffer.byteLength(tail) + 2, PARSER_LIMITS.lineBytes);
  const events = await run(jsonResponse(body, "text/event-stream"));
  assert.equal(textOf(events).length, PARSER_LIMITS.lineBytes - 2 - Buffer.byteLength(head) - Buffer.byteLength(tailPrefix) - Buffer.byteLength(tailSuffix));

  const over = await outcome(jsonResponse(`data: {"type":"begin"}\n\ndata: ${head}\ndata: ${tail}y\n\ndata: {"type":"end"}\n\n`, "text/event-stream"));
  assert.equal(over.error?.agentReason, "limit");
});

test("the event count limit is inclusive and one event over fails", async () => {
  // begin + 99998 items + end = 100000 protocol events.
  const lines = [frame("begin")];
  for (let i = 0; i < PARSER_LIMITS.events - 2; i++) lines.push(frame("item", "x"));
  lines.push(frame("end"));
  const events = await run(jsonResponse(`${lines.join("\n")}\n`, "application/x-ndjson"));
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(textOf(events).length, PARSER_LIMITS.events - 2);

  const over = [frame("begin")];
  for (let i = 0; i < PARSER_LIMITS.events - 1; i++) over.push(frame("item", "x"));
  over.push(frame("end"));
  const result = await outcome(jsonResponse(`${over.join("\n")}\n`, "application/x-ndjson"));
  assert.equal(result.error?.agentReason, "limit");
});

test("JSON nesting depth is limited to sixteen containers", async () => {
  assert.equal(textOf(await run(jsonResponse(nestedObjects(PARSER_LIMITS.depth - 1)))), "deep");
  const tooDeep = await outcome(jsonResponse(nestedObjects(PARSER_LIMITS.depth)));
  assert.equal(tooDeep.error?.agentReason, "limit");
});

test("JSON arrays are limited to one thousand items", async () => {
  const atLimit = JSON.stringify(Array.from({ length: PARSER_LIMITS.arrayItems }, () => "x"));
  assert.equal(textOf(await run(jsonResponse(atLimit))).length, PARSER_LIMITS.arrayItems * 3 - 2);
  const over = await outcome(jsonResponse(JSON.stringify(Array.from({ length: PARSER_LIMITS.arrayItems + 1 }, () => "x"))));
  assert.equal(over.error?.agentReason, "limit");
});

test("the sniff budget streams plain text but refuses JSON-like bodies and other media types", async () => {
  const long = "z".repeat(PARSER_LIMITS.lineBytes + 1);
  assert.equal(textOf(await run(streamResponse([bytesOf(long)], "text/plain"))), long);

  const longJson = await outcome(streamResponse([bytesOf(`{"output":"${"z".repeat(PARSER_LIMITS.lineBytes)}"}`)], "application/json"));
  assert.equal(longJson.error?.agentReason, "limit");

  const longUnknown = await outcome(streamResponse([bytesOf(long)], "application/xml"));
  assert.equal(longUnknown.error?.agentReason, "limit");
});

// ---------------------------------------------------------------------------------------------
// Cancellation and cleanup

test("a parser failure cancels an unread body", async () => {
  let cancelled = false;
  const response = endlessResponse([bytesOf("{not json}\n")], () => { cancelled = true; }, "application/x-ndjson");
  const result = await outcome(response);
  assert.equal(result.error?.agentReason, "malformed");
  assert.equal(cancelled, true);
});

test("aborting before reading yields aborted and releases the reader", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await outcome(jsonResponse(LIVE_FIXTURE), { signal: controller.signal });
  assert.equal(result.error?.code, "aborted");
});

test("aborting during a read yields aborted and cancels upstream", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const response = endlessResponse([bytesOf(`${frame("begin")}\n`)], () => { cancelled = true; }, "application/x-ndjson");
  const pending = outcome(response, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await pending;
  assert.equal(result.error?.code, "aborted");
  assert.equal(cancelled, true);
});

test("breaking out of the generator early cancels the body", async () => {
  let cancelled = false;
  const response = endlessResponse([bytesOf(LIVE_FIXTURE)], () => { cancelled = true; });
  const iterator = parseAgentResponse(response, { mode: "auto", responsePointer: null, signal: new AbortController().signal });
  const first = await iterator.next();
  assert.equal(first.value?.type, "mode");
  await iterator.return(undefined);
  assert.equal(cancelled, true);
});

test("the parser reads ahead only one chunk while the consumer is slow", async () => {
  let pulls = 0;
  let index = 0;
  const chunks = [bytesOf(`${frame("begin")}\n${frame("item", "one")}\n`), bytesOf(`${frame("item", "two")}\n${frame("end")}\n`)];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
  }, { highWaterMark: 0 });
  const iterator = parseAgentResponse(new Response(stream), { mode: "ndjson", responsePointer: null, signal: new AbortController().signal });
  assert.equal((await iterator.next()).value?.type, "mode");
  assert.equal(pulls, 0);
  const start = await iterator.next();
  assert.equal(start.value?.type, "segment-start");
  assert.equal(pulls, 1);
  const first = await iterator.next();
  assert.equal(first.value?.type, "text");
  assert.equal(pulls, 1);
  for (let event = await iterator.next(); !event.done; event = await iterator.next()) {
    // Drain the rest.
  }
  // Two data pulls plus the final pull that closes the stream.
  assert.equal(pulls, 3);
});

test("an event error is terminal even after text and a closed run", async () => {
  const body = [
    frame("begin"),
    frame("item", "done text"),
    frame("end"),
    frame("error", "SECRET_UPSTREAM_DETAIL"),
  ].join("\n");
  const result = await outcome(jsonResponse(`${body}\n`, "application/x-ndjson"));
  assert.equal(result.error?.code, "agent_failed");
  assert.equal(textOf(result.events), "done text");
  assert.ok(!result.events.some((event) => event.type === "done"));
  assert.ok(!JSON.stringify(result.error).includes("SECRET_UPSTREAM_DETAIL"));
});

test("a JSON array refuses unsupported items instead of leaking them", async () => {
  const result = await outcome(jsonResponse('["ok", 5]'));
  assert.equal(result.error?.agentReason, "malformed");
});

test("OpenAI-style delta objects are not accepted", async () => {
  const result = await outcome(jsonResponse('{"choices":[{"delta":{"content":"hi"}}]}'));
  assert.equal(result.error?.agentReason, "malformed");
});

test("a whitespace-only answer is empty, not a reply", async () => {
  const text = await outcome(jsonResponse("   ", "text/plain"));
  assert.equal(text.error?.agentReason, "empty");
  const object = await outcome(jsonResponse('{"output":"   "}'));
  assert.equal(object.error?.agentReason, "empty");
});
