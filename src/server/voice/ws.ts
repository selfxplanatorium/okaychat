import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocketLike, WebSocketServerLike } from "@hono/node-server";

// The server half of RFC 6455, enough for `/api/voice/call`: text and binary messages, fragmentation,
// ping/pong, and the close handshake. @hono/node-server's `upgradeWebSocket` needs a `ws`-like server; this
// avoids the dependency. No extensions (permessage-deflate) and no subprotocols are negotiated.

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const utf8 = new TextDecoder("utf-8", { fatal: true });

export interface MiniSocketOptions {
  /** Largest message, after reassembling fragments. Larger ones close the socket with 1009. */
  maxPayload: number;
}

type ReadyState = 0 | 1 | 2 | 3;

export class MiniWebSocket extends EventEmitter implements WebSocketLike {
  protocol = "";
  readyState: ReadyState = 1;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentBinary = false;
  private closeSent = false;
  private closed = false;

  constructor(private readonly socket: Duplex, head: Buffer, private readonly options: MiniSocketOptions) {
    super();
    socket.on("data", (data: Buffer) => this.receive(data));
    socket.on("close", () => this.finish(1006, ""));
    socket.on("error", (error) => {
      this.emit("error", error);
      socket.destroy();
    });
    if (head.length) queueMicrotask(() => this.receive(head));
  }

  /** Bytes queued in the kernel-side writer; callers drop audio instead of buffering without bound. */
  get bufferedAmount(): number {
    return (this.socket as Duplex & { writableLength?: number }).writableLength ?? 0;
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 1) return;
    if (typeof data === "string") this.frame(0x1, Buffer.from(data, "utf8"));
    else if (data instanceof ArrayBuffer) this.frame(0x2, Buffer.from(data));
    else this.frame(0x2, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.sendClose(code, reason);
    // A peer that never answers the close frame does not keep the socket open.
    setTimeout(() => this.socket.destroy(), 2000).unref();
  }

  /** Drops the connection without a close handshake (protocol violations). */
  terminate(code: number): void {
    if (this.readyState < 2) this.sendClose(code, "");
    this.readyState = 2;
    this.socket.end();
    // Emit now as well as on the socket's own close: a peer that already wrote a bad frame must not look open
    // to the call session while the kernel finishes tearing the socket down.
    this.finish(code, "");
    setTimeout(() => this.socket.destroy(), 500).unref();
  }

  private sendClose(code: number, reason: string) {
    if (this.closeSent) return;
    this.closeSent = true;
    const text = Buffer.from(reason.slice(0, 120), "utf8");
    const payload = Buffer.alloc(2 + text.length);
    payload.writeUInt16BE(code, 0);
    text.copy(payload, 2);
    this.frame(0x8, payload, true);
  }

  private frame(opcode: number, payload: Buffer, force = false) {
    if (!force && this.readyState !== 1) return;
    const length = payload.length;
    const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    if (length < 126) header[1] = length;
    else if (length < 65536) {
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    if (!this.socket.writable) return;
    this.socket.write(Buffer.concat([header, payload]));
  }

  private receive(data: Buffer) {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    while (this.buffer.length >= 2 && !this.closed) {
      const b0 = this.buffer[0]!;
      const b1 = this.buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      // Reserved bits mean an extension we did not negotiate.
      if (b0 & 0x70) return this.terminate(1002);
      // Clients must mask every frame (RFC 6455 §5.1).
      if (!masked) return this.terminate(1002);
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.options.maxPayload)) return this.terminate(1009);
        length = Number(big);
        offset = 10;
      }
      const control = opcode >= 0x8;
      if (control && (length > 125 || !fin)) return this.terminate(1002);
      if (!control && length + this.fragmentBytes > this.options.maxPayload) return this.terminate(1009);
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i++) payload[i] = this.buffer[offset + 4 + i]! ^ mask[i & 3]!;
      this.buffer = this.buffer.subarray(offset + 4 + length);
      this.handleFrame(fin, opcode, payload);
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer) {
    switch (opcode) {
      case 0x0: // continuation
        if (!this.fragments.length) return this.terminate(1002);
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
        if (fin) this.deliver(Buffer.concat(this.fragments), this.fragmentBinary);
        return;
      case 0x1:
      case 0x2:
        if (this.fragments.length) return this.terminate(1002);
        if (fin) return this.deliver(payload, opcode === 0x2);
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
        this.fragmentBinary = opcode === 0x2;
        return;
      case 0x8: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        if (this.readyState === 1) {
          this.readyState = 2;
          this.sendClose(code === 1005 ? 1000 : code, "");
        }
        this.socket.end();
        this.finish(code, reason);
        return;
      }
      case 0x9:
        this.frame(0xa, payload);
        return;
      case 0xa:
        return;
      default:
        return this.terminate(1002);
    }
  }

  private deliver(data: Buffer, binary: boolean) {
    this.fragments = [];
    this.fragmentBytes = 0;
    if (!binary) {
      try {
        this.emit("message", utf8.decode(data), false);
      } catch {
        this.terminate(1007);
      }
      return;
    }
    this.emit("message", data, true);
  }

  private finish(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason, "utf8"));
  }
}

/** `noServer` WebSocket server for @hono/node-server's `websocket` option. */
export class MiniWebSocketServer extends EventEmitter implements WebSocketServerLike {
  readonly options = { noServer: true };
  private readonly sockets = new Set<MiniWebSocket>();

  constructor(private readonly socketOptions: MiniSocketOptions) {
    super();
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: WebSocketLike) => void): void {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key) || request.headers["sec-websocket-version"] !== "13") {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    const headers = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`];
    this.emit("headers", headers);
    socket.write(`${headers.join("\r\n")}\r\n\r\n`);
    (socket as Duplex & { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true);
    const ws = new MiniWebSocket(socket, head, this.socketOptions);
    this.sockets.add(ws);
    ws.on("close", () => this.sockets.delete(ws));
    callback(ws);
  }

  close(): void {
    for (const ws of this.sockets) ws.close(1001, "server shutting down");
  }
}
