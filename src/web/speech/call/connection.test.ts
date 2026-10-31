/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONNECT_TIMEOUT_MS, VoiceConnection } from "./connection";

// A WebSocket that never answers on its own; the test plays the server.
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: unknown) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

function install() {
  const sockets: FakeWebSocket[] = [];
  const originalWebSocket = globalThis.WebSocket;
  const originalLocation = globalThis.location;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: class extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    },
  });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol: "https:", host: "app.test" } });
  const restore = () => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: originalWebSocket });
    Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation });
  };
  return { sockets, restore };
}

const connection = (events = { onMessage: () => {}, onAudio: () => {}, onDropped: () => {} }) =>
  new VoiceConnection("r-thread", "local", events);

test("closing a socket that is still connecting closes it and never sends start", async () => {
  const { sockets, restore } = install();
  try {
    const link = connection();
    const opening = link.open();
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0]!.readyState, FakeWebSocket.CONNECTING);
    link.close();
    await assert.rejects(opening, /ended/);
    assert.equal(sockets[0]!.closed?.code, 1000);
    // A late handshake callback must not start a call or a ping.
    sockets[0]!.open();
    assert.deepEqual(sockets[0]!.sent, []);
  } finally {
    restore();
  }
});

test("an opened socket sends start, and close ends it explicitly", async () => {
  const { sockets, restore } = install();
  try {
    const link = connection();
    const opening = link.open();
    sockets[0]!.open();
    await opening;
    assert.deepEqual(sockets[0]!.sent, [JSON.stringify({ t: "start", threadId: "r-thread", engine: "local" })]);
    assert.equal(link.isOpen, true);
    link.close();
    assert.equal(sockets[0]!.sent.at(-1), JSON.stringify({ t: "end" }));
    assert.equal(sockets[0]!.closed?.code, 1000);
    assert.equal(link.isOpen, false);
  } finally {
    restore();
  }
});

test("the handshake has a bounded timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sockets, restore } = install();
  try {
    const link = connection();
    const opening = link.open();
    t.mock.timers.tick(CONNECT_TIMEOUT_MS);
    await assert.rejects(opening, /could not connect/);
    assert.equal(sockets[0]!.closed !== null, true);
    link.abort();
  } finally {
    restore();
  }
});
