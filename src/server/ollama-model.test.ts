import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

// The adapter is driven through streamText and a real loopback HTTP server, so request bodies,
// content parts, usage, tool history, and abort behavior are checked end to end.
const calls: Array<{ model: string; stream: boolean; body: Record<string, unknown> }> = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let hangClosed: Promise<void> | null = null;
let errorClosed: Promise<void> | null = null;
let flakyCalls = 0;

function waitForClose(res: { once: (event: string, listener: () => void) => unknown }): Promise<void> {
  return new Promise((resolve) => res.once("close", () => resolve()));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
}

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/api/chat") {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  const body = await readBody(req);
  const model = String(body.model ?? "");
  calls.push({ model, stream: body.stream === true, body });
  if (model === "missing") {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `model '${model}' not found` }));
    return;
  }
  if (model === "bigerror") {
    // A large body that never ends: bounded error reading must not wait for it.
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    errorClosed = waitForClose(res);
    res.write(JSON.stringify({ error: "x".repeat(40_000) }));
    await errorClosed;
    return;
  }
  if (model === "flaky" && flakyCalls++ === 0) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: "temporarily overloaded" }));
    return;
  }
  res.setHeader("Content-Type", body.stream === true ? "application/x-ndjson" : "application/json");
  const messages = body.messages as Array<{ role: string; tool_name?: string; content?: string }>;

  if (body.stream !== true) {
    if (model === "nullresponse") {
      res.end("null");
      return;
    }
    res.end(JSON.stringify({
      model,
      created_at: "2026-10-31T10:00:00Z",
      message: { role: "assistant", content: "Plain answer", thinking: "A short thought" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 7,
      eval_count: 3,
    }));
    return;
  }
  if (model === "huge") {
    // No newline, over the 8 MiB line cap.
    res.write("x".repeat(9 * 1024 * 1024));
    res.end();
    return;
  }
  if (model === "hang") {
    hangClosed = waitForClose(res);
    res.write(`${JSON.stringify({ model, message: { role: "assistant", content: "First" } })}\n`);
    await hangClosed;
    return;
  }
  if (model === "slow") {
    res.write(`${JSON.stringify({ model, message: { role: "assistant", content: "First" } })}\n`);
    await delay(300);
    if (!res.destroyed) res.end();
    return;
  }
  if (model === "interleave") {
    res.write(`${JSON.stringify({ message: { role: "assistant", thinking: "one" } })}\n`);
    res.write(`${JSON.stringify({ message: { role: "assistant", content: "A" } })}\n`);
    res.write(`${JSON.stringify({ message: { role: "assistant", thinking: "two" } })}\n`);
    res.end(`${JSON.stringify({ message: { role: "assistant", content: "B" } })}\n${JSON.stringify({ done: true, done_reason: "stop" })}\n`);
    return;
  }
  if (model === "truncated") {
    res.end(`${JSON.stringify({ message: { role: "assistant", content: "Half" } })}\n`);
    return;
  }
  if (model === "nullline") {
    res.end("null\n");
    return;
  }
  if (model === "tooler" && !messages.some((m) => m.role === "tool")) {
    res.write(`${JSON.stringify({ model, created_at: "2026-10-31T10:00:00Z", message: { role: "assistant", content: "", tool_calls: [{ function: { name: "weather", arguments: { city: "Berlin" } } }] } })}\n`);
    res.end(`${JSON.stringify({ done: true, done_reason: "stop", prompt_eval_count: 20, eval_count: 8 })}\n`);
    return;
  }
  if (model === "tooler") {
    res.write(`${JSON.stringify({ message: { role: "assistant", content: "It is 20 C in Berlin." } })}\n`);
    res.end(`${JSON.stringify({ done: true, done_reason: "stop", prompt_eval_count: 40, eval_count: 9 })}\n`);
    return;
  }
  // Thinking, then text split across writes and even inside one JSON line.
  res.write(`${JSON.stringify({ model, created_at: "2026-10-31T10:00:00Z", message: { role: "assistant", thinking: "Let me " } })}\n`);
  res.write(`${JSON.stringify({ message: { role: "assistant", thinking: "think", content: "Hel" } })}\n`);
  await delay(5);
  res.end(`${JSON.stringify({ message: { role: "assistant", content: "lo world" } })}\n${JSON.stringify({ done: true, done_reason: "stop", prompt_eval_count: 12, eval_count: 5 })}\n`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-ollama-model-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "ollama-model-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { createOllamaModel } = await import("./ollama-model.js");
const { createModel } = await import("./llm.js");
const { forgetOllamaModels } = await import("./catalog/ollama.js");

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
  flakyCalls = 0;
  forgetOllamaModels();
});

const modelInfo = (id: string) => ({
  ref: `ollama/${id}`,
  providerId: "ollama",
  id,
  name: id,
  format: "ollama" as const,
  baseURL,
  context: 131072,
  maxOutput: 8192,
  reasoning: true,
  toolCall: true,
  attachments: true,
  inputModalities: ["text", "image"],
  temperature: true,
  free: true,
});
const connection = { providerId: "ollama", baseURL, enabled: true };

async function collect(stream: ReadableStream<LanguageModelV4StreamPart>): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

function errorOf(parts: LanguageModelV4StreamPart[]): Error {
  const part = parts.find((item) => item.type === "error");
  assert.ok(part && part.type === "error", "expected an error part");
  return part.error as Error;
}

test("streamText receives native text and thinking with correct usage, finish, and no cache fields", async () => {
  const handle = createModel(modelInfo("thinker"), connection, { userId: "alice" });
  assert.equal(handle.model.specificationVersion, "v4");
  const result = streamText({
    model: handle.model,
    system: "Be brief.",
    messages: [{ role: "user", content: "Hi" }],
    maxOutputTokens: 100,
    temperature: 0.2,
    reasoning: "medium",
  });
  assert.equal(await result.text, "Hello world");
  assert.equal(await result.reasoningText, "Let me think");
  assert.equal(await result.finishReason, "stop");
  const usage = await result.usage;
  assert.equal(usage.inputTokens, 12);
  assert.equal(usage.outputTokens, 5);
  assert.equal(calls.length, 1);
  const sent = calls[0]!;
  assert.equal(sent.stream, true);
  assert.equal(sent.body.model, "thinker");
  assert.equal(sent.body.think, true);
  assert.deepEqual(sent.body.options, { num_ctx: 131072, temperature: 0.2, num_predict: 100 });
  const messages = sent.body.messages as Array<{ role: string; content: string }>;
  assert.deepEqual(messages.map((m) => [m.role, m.content]), [["system", "Be brief."], ["user", "Hi"]]);
  assert.equal("prompt_cache_key" in sent.body, false);
  assert.equal("prompt_cache_breakpoint" in sent.body, false);
  assert.equal("choices" in sent.body, false);
});

test("tool calls execute, and the next request carries assistant tool_calls and a native tool message", async () => {
  const executed: unknown[] = [];
  const weather = tool({
    description: "Current weather",
    inputSchema: z.object({ city: z.string() }),
    execute: async (input) => {
      executed.push(input);
      return { city: input.city, temperatureC: 20 };
    },
  });
  const result = streamText({
    model: createOllamaModel({ id: "tooler", baseURL }),
    messages: [{ role: "user", content: "Weather in Berlin?" }],
    tools: { weather },
    stopWhen: stepCountIs(2),
  });
  assert.equal(await result.text, "It is 20 C in Berlin.");
  assert.deepEqual(executed, [{ city: "Berlin" }]);
  assert.equal(calls.length, 2);
  const tools = (calls[0]!.body.tools as Array<{ type: string; function: { name: string; parameters: unknown } }>);
  assert.equal(tools[0]!.type, "function");
  assert.equal(tools[0]!.function.name, "weather");
  assert.ok(tools[0]!.function.parameters);
  const history = calls[1]!.body.messages as Array<{ role: string; tool_name?: string; content?: string; tool_calls?: Array<{ function: { name: string; arguments: unknown } }> }>;
  const assistant = history.find((m) => m.role === "assistant")!;
  assert.deepEqual(assistant.tool_calls, [{ function: { name: "weather", arguments: { city: "Berlin" } } }]);
  const toolMessage = history.find((m) => m.role === "tool")!;
  assert.equal(toolMessage.tool_name, "weather");
  assert.match(toolMessage.content ?? "", /20/);
});

test("doGenerate maps text, thinking, usage, and finish reasons", async () => {
  const model = createOllamaModel({ id: "generator", baseURL, thinking: true });
  const result = await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] });
  assert.equal(result.finishReason.unified, "stop");
  assert.equal(result.usage.inputTokens.total, 7);
  assert.equal(result.usage.outputTokens.total, 3);
  assert.deepEqual(result.content, [
    { type: "reasoning", text: "A short thought" },
    { type: "text", text: "Plain answer" },
  ]);
  assert.equal(calls[0]!.stream, false);
});

test("images become the native images array and unsupported files fail explicitly", async () => {
  const model = createOllamaModel({ id: "generator", baseURL });
  const bytes = Buffer.from("not-a-real-png").toString("base64");
  await model.doGenerate({
    prompt: [{
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "file", mediaType: "image/png", data: { type: "data", data: bytes } },
      ],
    }],
  });
  const messages = calls[0]!.body.messages as Array<{ images?: string[] }>;
  assert.deepEqual(messages[0]!.images, [bytes]);
  await assert.rejects(
    () => model.doGenerate({
      prompt: [{
        role: "user",
        content: [{ type: "file", mediaType: "application/pdf", data: { type: "data", data: bytes } }],
      }],
    }),
    /cannot read application\/pdf attachments/,
  );
});

test("toolChoice none sends no tools, so the final step can answer", async () => {
  const model = createOllamaModel({ id: "generator", baseURL });
  await model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Answer" }] }],
    tools: [{ type: "function", name: "weather", inputSchema: { type: "object", properties: {} } }],
    toolChoice: { type: "none" },
  });
  assert.equal("tools" in calls[0]!.body, false);
});

test("abort closes the stream without a spurious error", { timeout: 5_000 }, async () => {
  const model = createOllamaModel({ id: "slow", baseURL });
  const controller = new AbortController();
  const result = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    abortSignal: controller.signal,
  });
  const reader = result.stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === "text-delta") {
      text += value.delta;
      break;
    }
  }
  assert.equal(text, "First");
  controller.abort();
  const finished = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => {
      const timeout = setTimeout(() => reject(new Error("stream did not close after abort")), 2_000);
      timeout.unref();
    }),
  ]);
  assert.equal(finished.done, true);
});

test("native chat retries a transient daemon response before the stream opens", async () => {
  const handle = createModel(modelInfo("flaky"), connection, { userId: "alice", retry: { sleep: async () => {}, random: () => 0.5 } });
  const result = streamText({ model: handle.model, messages: [{ role: "user", content: "Hi" }], maxRetries: 0 });
  assert.equal(await result.text, "Hello world");
  assert.equal(flakyCalls, 2, "the daemon was asked twice");
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.body.stream, true);
});

test("native generation retries a transient daemon response too", async () => {
  const handle = createModel({ ...modelInfo("flaky"), id: "flaky" }, connection, { userId: "alice", retry: { sleep: async () => {}, random: () => 0.5 } });
  const result = await handle.model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] });
  assert.equal(result.content.some((part) => part.type === "text" && part.text === "Plain answer"), true);
  assert.equal(flakyCalls, 2);
});

test("factory effort reaches native think and num_ctx through chat streaming and generation", async () => {
  const info = { ...modelInfo("thinker"), reasoningEfforts: ["none", "high"] };
  const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "Hi" }] }];
  for (const effort of ["none", "high"] as const) {
    calls.length = 0;
    const handle = createModel(info, connection, { userId: "alice", effort });
    const streamed = streamText({ model: handle.model, messages: [{ role: "user", content: "Hi" }] });
    assert.equal(await streamed.text, "Hello world");
    assert.equal(calls[0]!.body.think, effort === "high");
    assert.equal((calls[0]!.body.options as Record<string, unknown>).num_ctx, 131072);
  }
  for (const effort of ["none", "high"] as const) {
    calls.length = 0;
    const handle = createModel(info, connection, { userId: "alice", effort });
    await handle.model.doGenerate({ prompt });
    assert.equal(calls[0]!.body.think, effort === "high");
    assert.equal((calls[0]!.body.options as Record<string, unknown>).num_ctx, 131072);
  }
});

test("direct top-level reasoning still wins over the factory default", async () => {
  const model = createOllamaModel({ id: "generator", baseURL, thinking: true, reasoning: "high" });
  await model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    reasoning: "none",
  });
  assert.equal(calls[0]!.body.think, false);
});

test("non-thinking models never receive reasoning config", async () => {
  const info = { ...modelInfo("plain"), reasoning: false };
  const handle = createModel(info, connection, { userId: "alice", effort: "high" });
  const result = streamText({ model: handle.model, messages: [{ role: "user", content: "Hi" }] });
  await result.text;
  assert.equal("think" in calls[0]!.body, false);
});

test("named thinking levels are sent as native strings, never invalid booleans", async () => {
  const info = { ...modelInfo("gptoss"), reasoningEfforts: ["low", "medium", "high"], thinkingLevels: ["low", "medium", "high"] };
  const handle = createModel(info, connection, { userId: "alice", effort: "medium" });
  await handle.model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] });
  assert.equal(calls[0]!.body.think, "medium");

  // The daemon did not offer false, so "none" is omitted instead of sending an invalid boolean.
  calls.length = 0;
  const model = createOllamaModel({ id: "gptoss", baseURL, thinking: true, thinkingLevels: ["low", "medium", "high"], thinkingOff: false });
  await model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    reasoning: "none",
  });
  assert.equal("think" in calls[0]!.body, false);
});

test("interleaved reasoning and text sections reopen with fresh ids", async () => {
  const result = await createOllamaModel({ id: "interleave", baseURL }).doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  });
  const parts = await collect(result.stream);
  const starts = parts.filter((part) => part.type === "reasoning-start" || part.type === "text-start");
  const ends = parts.filter((part) => part.type === "reasoning-end" || part.type === "text-end");
  const startIds = starts.map((part) => (part as { id: string }).id);
  assert.deepEqual(startIds, ["reasoning-0", "text-0", "reasoning-1", "text-1"]);
  assert.deepEqual(ends.map((part) => (part as { id: string }).id), startIds);
  assert.equal(new Set(startIds).size, startIds.length);
});

test("cancelling the consumer without an abort signal closes the upstream chat socket", { timeout: 5_000 }, async () => {
  hangClosed = null;
  const result = await createOllamaModel({ id: "hang", baseURL }).doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  });
  const reader = result.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    assert.equal(done, false);
    if (value.type === "text-delta") break;
  }
  await reader.cancel();
  const closed = hangClosed;
  assert.ok(closed, "the mock daemon never started the hanging response");
  await Promise.race([
    closed,
    new Promise<never>((_, reject) => {
      const timeout = setTimeout(() => reject(new Error("upstream chat socket stayed open after consumer cancel")), 2_000);
      timeout.unref();
    }),
  ]);
});

test("a truncated chat stream reports an error instead of a finish", async () => {
  const result = await createOllamaModel({ id: "truncated", baseURL }).doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  });
  const parts = await collect(result.stream);
  assert.match(errorOf(parts).message, /without finishing/);
  assert.equal(parts.some((part) => part.type === "finish"), false);
});

test("malformed and overlong chat lines become actionable Ollama errors", { timeout: 10_000 }, async () => {
  const nullLine = await createOllamaModel({ id: "nullline", baseURL }).doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  });
  assert.match(errorOf(await collect(nullLine.stream)).message, /unexpected chat line/);

  const huge = await createOllamaModel({ id: "huge", baseURL }).doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  });
  assert.match(errorOf(await collect(huge.stream)).message, /overlong chat line/);
});

test("a non-streaming null response is rejected, not cast", async () => {
  const model = createOllamaModel({ id: "nullresponse", baseURL });
  await assert.rejects(
    () => model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] }),
    /unexpected chat response/,
  );
});

test("error bodies are bounded and do not wait for an unbounded daemon response", { timeout: 3_000 }, async () => {
  errorClosed = null;
  const model = createOllamaModel({ id: "bigerror", baseURL });
  await assert.rejects(
    () => model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] }),
    (error: unknown) => error instanceof Error && /HTTP 500/.test(error.message) && error.message.length < 700,
  );
  const closed = errorClosed;
  assert.ok(closed, "the mock daemon never started the error response");
});

test("a missing model produces an actionable install error", async () => {
  let captured: unknown;
  const result = streamText({
    model: createOllamaModel({ id: "missing", baseURL }),
    messages: [{ role: "user", content: "Hi" }],
    maxRetries: 0,
    onError: ({ error }) => {
      captured = error;
    },
  });
  await assert.rejects(() => result.text);
  assert.match((captured as Error).message, /not installed[\s\S]*Pull it/);
});
