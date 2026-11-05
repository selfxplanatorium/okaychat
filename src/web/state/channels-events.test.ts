import assert from "node:assert/strict";
import { test } from "node:test";
import { SseParser, parseFrame } from "./channels-events";

test("SSE parsing survives fragmented UTF-8, CRLF, comments, and multiline data", () => {
  const parser = new SseParser();
  const first = parser.push('retry: 3000\r\n\r\nevent: ready\r\ndata: {"v":1}\r\n\r\n: hear');
  assert.deepEqual(first.map((frame) => frame.event), ["ready"]);
  const second = parser.push('tbeat\n\nid: abc\nevent: message.changed\ndata: {"channelId":"c",\ndata: "entityId":"m"}\n\n');
  assert.equal(second.length, 1);
  assert.equal(second[0]!.id, "abc");
  assert.equal(second[0]!.event, "message.changed");
  assert.equal(second[0]!.data, '{"channelId":"c",\n"entityId":"m"}');
  assert.deepEqual(parser.flush(), []);
});

test("a frame without an event but with data is kept, and comments alone are ignored", () => {
  assert.deepEqual(parseFrame("data: hello\n"), { data: "hello" });
  assert.equal(parseFrame(": comment only\n"), null);
});

test("an oversized unterminated frame is rejected instead of buffered forever", () => {
  const parser = new SseParser();
  assert.throws(() => parser.push("data: " + "x".repeat(300_000)), /frame too large/);
});
