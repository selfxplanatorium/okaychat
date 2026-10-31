/// <reference types="node" />
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Duplex } from "node:stream";
import { MiniWebSocket, MiniWebSocketServer } from "./ws.js";

// A socket that records what the server writes and lets the test feed raw client frames back in.
class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  writable = true;
  writableLength = 0;
  write(data: Buffer) {
    this.written.push(Buffer.from(data));
    return true;
  }
  end() {
    this.writable = false;
  }
  destroy() {
    this.writable = false;
  }
  receive(data: Buffer) {
    this.emit("data", data);
  }
}

const maskedFrame = (opcode: number, payload: Buffer, fin = true, mask = Buffer.from([1, 2, 3, 4])) => {
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (length < 126) header[1] = 0x80 | length;
  else if (length < 65536) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i & 3]!));
  return Buffer.concat([header, mask, masked]);
};

function socket(maxPayload = 64 * 1024) {
  const raw = new FakeSocket();
  const ws = new MiniWebSocket(raw as unknown as Duplex, Buffer.alloc(0), { maxPayload });
  const messages: Array<{ data: string | Buffer; binary: boolean }> = [];
  const closes: Array<{ code: number; reason: string }> = [];
  ws.on("message", (data: string | Buffer, binary: boolean) => messages.push({ data, binary }));
  ws.on("close", (code: number, reason: Buffer) => closes.push({ code, reason: reason.toString() }));
  return { raw, ws, messages, closes };
}

test("text and binary frames are delivered, with masking removed", () => {
  const { raw, messages } = socket();
  raw.receive(maskedFrame(0x1, Buffer.from("hello")));
  raw.receive(maskedFrame(0x2, Buffer.from([1, 2, 3, 250])));
  assert.deepEqual(messages.map((m) => [m.binary, m.data]), [
    [false, "hello"],
    [true, Buffer.from([1, 2, 3, 250])],
  ]);
});

test("fragmented messages are reassembled in order", () => {
  const { raw, messages } = socket();
  raw.receive(maskedFrame(0x1, Buffer.from("hel"), false));
  raw.receive(maskedFrame(0x0, Buffer.from("lo "), false));
  raw.receive(maskedFrame(0x0, Buffer.from("world"), true));
  // A continuation cannot change the opcode: the first frame decides text or binary.
  assert.deepEqual(messages.map((m) => [m.binary, m.data.toString()]), [[false, "hello world"]]);
});

test("ping gets a pong with the same payload", () => {
  const { raw } = socket();
  raw.receive(maskedFrame(0x9, Buffer.from("abc")));
  const pong = raw.written.at(-1)!;
  assert.equal(pong[0], 0x8a);
  assert.equal(pong.subarray(2).toString(), "abc");
});

test("unmasked frames, reserved bits, and bad continuations close with a protocol error", () => {
  for (const frame of [
    Buffer.from([0x81, 0x01, 0x41]),
    Buffer.from([0xc1, 0x81, 1, 2, 3, 4, 0x41]),
    maskedFrame(0x0, Buffer.from("x")),
  ]) {
    const { raw, closes } = socket();
    raw.receive(frame);
    assert.equal(closes.at(-1)?.code, 1002);
  }
});

test("an oversized message closes with 1009 before buffering it", () => {
  const { raw, closes } = socket(8);
  raw.receive(maskedFrame(0x2, Buffer.alloc(9)));
  assert.equal(closes.at(-1)?.code, 1009);
});

test("invalid utf8 text closes with 1007", () => {
  const { raw, closes } = socket();
  raw.receive(maskedFrame(0x1, Buffer.from([0xc3, 0x28])));
  assert.equal(closes.at(-1)?.code, 1007);
});

test("control frames cannot be fragmented or carry more than 125 bytes", () => {
  const { raw, closes } = socket();
  raw.receive(maskedFrame(0x9, Buffer.alloc(10), false));
  assert.equal(closes.at(-1)?.code, 1002);
});

test("a close frame ends the socket once", () => {
  const { raw, closes } = socket();
  raw.receive(maskedFrame(0x8, Buffer.from([0x03, 0xe8])));
  raw.receive(maskedFrame(0x8, Buffer.from([0x03, 0xe8])));
  assert.deepEqual(closes, [{ code: 1000, reason: "" }]);
});

test("the mini server rejects a handshake without a valid key or version", () => {
  const server = new MiniWebSocketServer({ maxPayload: 1024 });
  const raw = new FakeSocket();
  server.handleUpgrade({ headers: {} } as never, raw as unknown as Duplex, Buffer.alloc(0), () => assert.fail("upgraded"));
  assert.equal(raw.writable, false);
});
