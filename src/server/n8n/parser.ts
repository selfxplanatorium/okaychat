import type { AgentReason, N8nResolvedMode, N8nResponseMode } from "../../shared/n8n-agents.js";
import { AppError } from "../errors.js";
import { parsePointer } from "./schemas.js";

// Turns a webhook response into text deltas. Pure: no database or network, only the Response it is given.
// n8n's streaming mode sends newline-delimited {type: begin|item|end|error} objects, often labelled
// application/json; other workflows answer one JSON document, SSE, or plain text. Every read is bounded
// and nothing here ever returns remote text inside an error.

export type ResolvedMode = N8nResolvedMode;

export type AgentEvent =
  | { type: "segment-start"; segmentId: string }
  | { type: "text"; segmentId: string; text: string }
  | { type: "segment-end"; segmentId: string }
  | { type: "mode"; mode: ResolvedMode }
  | { type: "done" };

export interface ParseOptions {
  mode: N8nResponseMode;
  responsePointer: string | null;
  signal: AbortSignal;
}

export const PARSER_LIMITS = {
  bodyBytes: 8 * 1024 * 1024,
  outputBytes: 1024 * 1024,
  lineBytes: 256 * 1024,
  events: 100_000,
  depth: 16,
  arrayItems: 1000,
  metadataText: 200,
};

const FRAME_TYPES = new Set(["begin", "item", "end", "error"]);
const ACKNOWLEDGEMENTS = new Set(["workflow got started.", "workflow was started", "workflow was started."]);

const REASON_MESSAGES: Record<AgentReason, string> = {
  inactive: "The workflow's production webhook is not active.",
  redirect: "The webhook answered with a redirect.",
  empty: "The agent sent no answer.",
  malformed: "The agent's answer was not in a supported format.",
  truncated: "The agent's answer ended before it was complete.",
  limit: "The agent's answer was larger than okaychat accepts.",
  interactive: "The workflow asked for an interactive step okaychat does not support.",
  html: "The webhook answered with a web page instead of an agent reply.",
  acknowledged: "The workflow only confirmed that it started; it did not answer.",
};

export const unusable = (reason: AgentReason) =>
  new AppError({ code: "agent_response", message: REASON_MESSAGES[reason], agentReason: reason, provider: "n8n" });

const workflowFailed = () => new AppError({ code: "agent_failed", provider: "n8n" });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Splits decoded text into lines (LF or CRLF), capping each line's UTF-8 size. */
class LineBuffer {
  private pending = "";
  private bytes = 0;

  push(text: string): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", start)) {
      const piece = text.slice(start, index);
      if (this.bytes + Buffer.byteLength(piece) > PARSER_LIMITS.lineBytes) throw unusable("limit");
      const line = this.pending + piece;
      lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
      this.pending = "";
      this.bytes = 0;
      start = index + 1;
    }
    const rest = text.slice(start);
    this.bytes += Buffer.byteLength(rest);
    if (this.bytes > PARSER_LIMITS.lineBytes) throw unusable("limit");
    this.pending += rest;
    return lines;
  }

  /** The last line when the body ended without a newline. */
  end(): string {
    const line = this.pending;
    this.pending = "";
    this.bytes = 0;
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  }
}

/** Open text segments per node run, with local ids; remote ids never leave this class. */
class Segments {
  private open = new Map<string, { id: string; started: boolean }>();
  private counter = 0;
  private outputBytes = 0;
  private textSegments = 0;
  private visible = false;

  get hasText() {
    return this.visible;
  }

  get hasOpen() {
    return this.open.size > 0;
  }

  private newSegment() {
    return { id: `agent-text-${this.counter++}`, started: false };
  }

  begin(key: string): AgentEvent[] {
    // A second begin for a run that is still open is not a protocol we can order deterministically.
    if (this.open.has(key)) throw unusable("malformed");
    this.open.set(key, this.newSegment());
    return [];
  }

  item(key: string, text: string): AgentEvent[] {
    let segment = this.open.get(key);
    // Older emitters send items without a begin.
    if (!segment) {
      segment = this.newSegment();
      this.open.set(key, segment);
    }
    return this.text(segment, text);
  }

  end(key: string): AgentEvent[] {
    const segment = this.open.get(key);
    // An end without a begin closes an implicit empty run.
    if (!segment) return [];
    this.open.delete(key);
    return segment.started ? [{ type: "segment-end", segmentId: segment.id }] : [];
  }

  /** Whole-document modes: one segment holding everything. */
  whole(text: string): AgentEvent[] {
    const segment = this.newSegment();
    const events = this.text(segment, text);
    return segment.started ? [...events, { type: "segment-end", segmentId: segment.id }] : events;
  }

  /** Streamed plain text: one segment, closed at EOF by closeAll(). */
  stream(text: string): AgentEvent[] {
    let segment = this.open.get("text");
    if (!segment) {
      segment = this.newSegment();
      this.open.set("text", segment);
    }
    return this.text(segment, text);
  }

  closeAll(): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const segment of this.open.values()) if (segment.started) events.push({ type: "segment-end", segmentId: segment.id });
    this.open.clear();
    return events;
  }

  private text(segment: { id: string; started: boolean }, raw: string): AgentEvent[] {
    if (!raw) return [];
    let text = raw;
    const events: AgentEvent[] = [];
    if (!segment.started) {
      segment.started = true;
      // Separate node runs read as separate paragraphs, also once the parts are joined into one message.
      if (this.textSegments++ > 0) text = `\n\n${text}`;
      events.push({ type: "segment-start", segmentId: segment.id });
    }
    this.outputBytes += Buffer.byteLength(text);
    if (this.outputBytes > PARSER_LIMITS.outputBytes) throw unusable("limit");
    if (text.trim()) this.visible = true;
    events.push({ type: "text", segmentId: segment.id, text });
    return events;
  }
}

function segmentKey(event: Record<string, unknown>): string {
  const metadata = event.metadata;
  if (metadata === undefined) return "default\u00000\u00000";
  if (!isRecord(metadata)) throw unusable("malformed");
  const { nodeId, runIndex, itemIndex } = metadata;
  if (nodeId !== undefined && (typeof nodeId !== "string" || nodeId.length > PARSER_LIMITS.metadataText)) throw unusable("malformed");
  for (const index of [runIndex, itemIndex]) {
    if (index !== undefined && !(Number.isSafeInteger(index) && (index as number) >= 0)) throw unusable("malformed");
  }
  return `${(nodeId as string | undefined) ?? "default"}\u0000${(runIndex as number | undefined) ?? 0}\u0000${(itemIndex as number | undefined) ?? 0}`;
}

/**
 * Text of one JSON value, deterministically: strings as-is, arrays item by item, objects through the first
 * present answer key. Anything else is refused rather than stringified.
 */
export function extractText(value: unknown, depth = 0): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (depth >= PARSER_LIMITS.depth) throw unusable("limit");
    if (value.length > PARSER_LIMITS.arrayItems) throw unusable("limit");
    return value.map((item) => extractText(item, depth + 1)).join("\n\n");
  }
  if (!isRecord(value)) throw unusable("malformed");
  if (depth >= PARSER_LIMITS.depth) throw unusable("limit");
  checkFrame(value);
  if (value.type === "message" || value.type === "with-buttons") {
    if (typeof value.text !== "string") throw unusable("malformed");
    return value.text;
  }
  for (const key of ["output", "text", "message", "content"]) {
    if (Object.hasOwn(value, key)) return extractText(value[key], depth + 1);
  }
  // n8n item wrapper; binary and pairedItem siblings are ignored.
  if (Object.hasOwn(value, "json")) return extractText(value.json, depth + 1);
  throw unusable("malformed");
}

/** Errors, starts without an answer, and approval steps are never shown as text. */
function checkFrame(value: Record<string, unknown>): void {
  const error = value.error;
  const hasError = error !== undefined && error !== null && error !== false && error !== "" && !(isRecord(error) && Object.keys(error).length === 0);
  if (value.type === "error" || hasError) throw workflowFailed();
  if (value.blockUserInput === true) throw unusable("interactive");
  const answered = ["output", "text", "message", "content"].some((key) => Object.hasOwn(value, key));
  if (Object.hasOwn(value, "resumeToken") && !answered) throw unusable("interactive");
  if (value.executionStarted === true && !answered) throw unusable("acknowledged");
}

/** Text blocks of a content array: strings or {type: text|output_text, text}. */
function blockText(blocks: unknown[]): string {
  if (blocks.length > PARSER_LIMITS.arrayItems) throw unusable("limit");
  return blocks
    .map((block) => {
      if (typeof block === "string") return block;
      if (isRecord(block) && (block.type === "text" || block.type === "output_text") && typeof block.text === "string") return block.text;
      throw unusable("malformed");
    })
    .join("");
}

/** An item's content: a string (decoded once if it is a whole n8n frame), text blocks, or a text object. */
export function itemContent(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (!trimmed.startsWith("{")) return content;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return content;
    }
    // Only a known frame is unwrapped; any other JSON-looking text (code, data) stays verbatim.
    if (isRecord(parsed) && (parsed.type === "message" || parsed.type === "with-buttons" || parsed.type === "error")) {
      checkFrame(parsed);
      if (typeof parsed.text !== "string") throw unusable("malformed");
      return parsed.text;
    }
    if (isRecord(parsed) && (parsed.executionStarted === true || Object.hasOwn(parsed, "resumeToken") || parsed.blockUserInput === true)) {
      checkFrame(parsed);
    }
    return content;
  }
  if (Array.isArray(content)) return blockText(content);
  if (isRecord(content)) return extractText(content);
  throw unusable("malformed");
}

/** Applies an RFC 6901 pointer to own properties only. */
export function applyPointer(root: unknown, pointer: string): unknown {
  const tokens = parsePointer(pointer);
  if (!tokens) throw unusable("malformed");
  let value = root;
  for (const token of tokens) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= value.length) throw unusable("malformed");
      value = value[Number(token)];
    } else if (isRecord(value) && Object.hasOwn(value, token)) {
      value = value[token];
    } else {
      throw unusable("malformed");
    }
  }
  return value;
}

const BINARY_MIME = /^(image|audio|video|font|multipart)\/|^application\/(octet-stream|pdf|zip|gzip|x-gzip|x-tar|vnd\.|msword|x-protobuf|protobuf|wasm)/;

function jsonMime(mime: string): boolean {
  return mime === "application/json" || mime.endsWith("+json");
}

export async function* parseAgentResponse(response: Response, options: ParseOptions): AsyncGenerator<AgentEvent> {
  const { signal } = options;
  const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const reader = response.body?.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bodyBytes = 0;
  let events = 0;
  let eof = !reader;
  const abortReason = () =>
    signal.reason instanceof AppError ? signal.reason : new AppError({ code: "aborted", provider: "n8n" });
  const onAbort = () => void reader?.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });

  /** The next decoded text, with done set once the body ended and the decoder was flushed. */
  const read = async (): Promise<{ text: string; done: boolean }> => {
    if (eof || !reader) return { text: "", done: true };
    if (signal.aborted) throw abortReason();
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch (error) {
      if (signal.aborted) throw abortReason();
      throw error;
    }
    if (signal.aborted) throw abortReason();
    try {
      if (result.done) {
        eof = true;
        return { text: decoder.decode(), done: true };
      }
      bodyBytes += result.value.byteLength;
      if (bodyBytes > PARSER_LIMITS.bodyBytes) throw unusable("limit");
      return { text: decoder.decode(result.value, { stream: true }), done: false };
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Invalid UTF-8 (fatal decoder).
      throw unusable("malformed");
    }
  };
  const countEvent = () => {
    if (++events > PARSER_LIMITS.events) throw unusable("limit");
  };
  const doneEvent = (): AgentEvent => {
    if (signal.aborted) throw abortReason();
    return { type: "done" };
  };

  try {
    if (signal.aborted) throw abortReason();
    // A vendor +json type is JSON, not a binary body, even though its subtype starts with vnd.
    if (!jsonMime(mime) && BINARY_MIME.test(mime)) throw unusable("malformed");
    let mode: N8nResolvedMode;
    let buffered = "";
    let ended = false;
    let firstLine: string | null = null;
    let sniffCapped = false;
    if (options.mode !== "auto") {
      mode = options.mode;
    } else if (mime === "text/event-stream") {
      mode = "sse";
    } else if (mime === "application/x-ndjson" || mime === "application/ndjson") {
      mode = "ndjson";
    } else if (mime === "text/html" || mime === "application/xhtml+xml") {
      // Usually a proxy, login, or error page.
      throw unusable("html");
    } else {
      // Sniff the first non-blank line, bounded, without guessing from the label alone.
      for (;;) {
        const start = buffered.length - buffered.trimStart().length;
        const newline = start < buffered.length ? buffered.indexOf("\n", start) : -1;
        if (newline !== -1) {
          firstLine = buffered.slice(start, newline).trim();
          if (Buffer.byteLength(firstLine) > PARSER_LIMITS.lineBytes) sniffCapped = true;
          break;
        }
        if (ended) {
          firstLine = buffered.trim();
          break;
        }
        if (bodyBytes > PARSER_LIMITS.lineBytes) {
          sniffCapped = true;
          break;
        }
        const next = await read();
        buffered += next.text;
        ended = next.done;
      }
      const head = buffered.trimStart();
      const jsonLike = /^[{["]/.test(head);
      let frame = false;
      if (!sniffCapped && firstLine !== null && firstLine.startsWith("{")) {
        try {
          const parsed: unknown = JSON.parse(firstLine);
          frame = isRecord(parsed) && typeof parsed.type === "string" && FRAME_TYPES.has(parsed.type);
        } catch {
          frame = false;
        }
      }
      if (sniffCapped) {
        // Past the sniff budget only plain text is safe to stream; anything JSON-like is refused.
        if (jsonLike || !(mime === "text/plain" || mime === "")) throw unusable("limit");
        mode = "text";
      } else if (frame) mode = "ndjson";
      else if (jsonMime(mime) || jsonLike) mode = "json";
      else if (firstLine === null) throw unusable("limit");
      else mode = "text";
    }
    yield { type: "mode", mode };
    const segments = new Segments();

    if (mode === "json") {
      let body = buffered;
      while (!ended) {
        const next = await read();
        body += next.text;
        ended = next.done;
      }
      if (!body.trim()) throw unusable("empty");
      let root: unknown;
      try {
        root = JSON.parse(body);
      } catch {
        throw unusable("malformed");
      }
      const chosen = options.responsePointer !== null ? applyPointer(root, options.responsePointer) : root;
      const text = extractText(chosen);
      if (ACKNOWLEDGEMENTS.has(text.trim().toLowerCase())) throw unusable("acknowledged");
      if (!text.trim()) throw unusable("empty");
      yield* segments.whole(text);
      yield doneEvent();
      return;
    }

    if (mode === "text") {
      if (options.mode === "auto" && firstLine !== null && ACKNOWLEDGEMENTS.has(firstLine.toLowerCase())) {
        const start = buffered.length - buffered.trimStart().length;
        const newline = buffered.indexOf("\n", start);
        if (newline === -1 || !buffered.slice(newline + 1).trim()) throw unusable("acknowledged");
      }
      yield* segments.stream(buffered);
      while (!ended) {
        const next = await read();
        ended = next.done;
        yield* segments.stream(next.text);
      }
      yield* segments.closeAll();
      if (!segments.hasText) throw unusable("empty");
      yield doneEvent();
      return;
    }

    const handle = (event: unknown): AgentEvent[] => {
      countEvent();
      if (!isRecord(event) || typeof event.type !== "string" || !FRAME_TYPES.has(event.type)) throw unusable("malformed");
      if (event.type === "error") throw workflowFailed();
      const key = segmentKey(event);
      if (event.type === "begin") return segments.begin(key);
      if (event.type === "end") return segments.end(key);
      return segments.item(key, itemContent(event.content));
    };
    const parseLine = (line: string): unknown => {
      try {
        return JSON.parse(line);
      } catch {
        throw unusable("malformed");
      }
    };
    const lines = new LineBuffer();
    let finished = false;

    if (mode === "ndjson") {
      // A generator, not an array: text produced before a later line fails must reach the UI.
      function* consume(text: string): Generator<AgentEvent> {
        for (const line of lines.push(text)) {
          if (finished) break;
          if (!line.trim()) continue;
          if (line.trim() === "[DONE]") {
            if (segments.hasOpen) throw unusable("truncated");
            finished = true;
            break;
          }
          yield* handle(parseLine(line));
        }
      }
      yield* consume(buffered);
      while (!ended && !finished) {
        const next = await read();
        ended = next.done;
        yield* consume(next.text);
      }
      const last = lines.end();
      if (!finished && last.trim()) {
        if (last.trim() === "[DONE]") {
          if (segments.hasOpen) throw unusable("truncated");
        } else {
          yield* handle(parseLine(last));
        }
      }
    } else {
      // SSE: data lines joined by LF, dispatched on a blank line; comments, event, id, and retry are ignored.
      let data: string[] | null = null;
      let dataBytes = 0;
      const dispatch = (): AgentEvent[] => {
        if (data === null) return [];
        const payload = data.join("\n");
        data = null;
        dataBytes = 0;
        if (payload.trim() === "[DONE]") {
          if (segments.hasOpen) throw unusable("truncated");
          finished = true;
          return [];
        }
        return handle(parseLine(payload));
      };
      const consume = function* (text: string): Generator<AgentEvent> {
        for (const line of lines.push(text)) {
          if (finished) break;
          if (line === "") yield* dispatch();
          else if (line.startsWith(":")) continue;
          else {
            const colon = line.indexOf(":");
            const field = colon === -1 ? line : line.slice(0, colon);
            if (field !== "data") continue;
            let value = colon === -1 ? "" : line.slice(colon + 1);
            if (value.startsWith(" ")) value = value.slice(1);
            dataBytes += Buffer.byteLength(value) + 1;
            if (dataBytes > PARSER_LIMITS.lineBytes) throw unusable("limit");
            (data ??= []).push(value);
          }
        }
      };
      yield* consume(buffered);
      while (!ended && !finished) {
        const next = await read();
        ended = next.done;
        yield* consume(next.text);
      }
      if (!finished) {
        const last = lines.end();
        if (last) yield* consume(`${last}\n`);
        // The final record counts even without a trailing blank line.
        yield* dispatch();
      }
    }
    if (segments.hasOpen) throw unusable("truncated");
    if (!segments.hasText) throw unusable("empty");
    yield doneEvent();
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (reader) {
      if (!eof) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
