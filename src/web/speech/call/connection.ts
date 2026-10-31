import { CALL_AUDIO_HEADER, type CallEngine, type ClientMessage, type ServerMessage } from "@shared/voice";

export interface VoiceConnectionEvents {
  onMessage: (message: ServerMessage) => void;
  /** One sentence's PCM16 chunk after the four-byte sentence id. */
  onAudio: (id: number, pcm: Uint8Array) => void;
  /** The socket closed without a close frame this client sent: the call is gone. */
  onDropped: () => void;
}

/** A handshake that never answers must not leave the call stuck on "Connecting". */
export const CONNECT_TIMEOUT_MS = 12_000;

/**
 * One `/api/voice/call` socket. The call is bound to `threadId` for its whole life; the controller never changes
 * it, so switching chats cannot route audio into another chat.
 */
export class VoiceConnection {
  private socket: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private closing = false;
  private started = false;
  private openReject: ((error: Error) => void) | null = null;

  constructor(
    private readonly threadId: string,
    private readonly engine: CallEngine,
    private readonly events: VoiceConnectionEvents,
  ) {}

  open(): Promise<void> {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${scheme}://${location.host}/api/voice/call`);
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      let opened = false;
      let settled = false;
      this.openReject = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.openReject = null;
        reject(error);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.openReject = null;
        if (error) reject(error);
        else resolve();
      };
      // A proxy that accepts the TCP connection but never answers the upgrade would otherwise leave the
      // call "Connecting" forever.
      const timer = setTimeout(() => {
        this.closing = true;
        finish(new Error("The voice call could not connect."));
        try {
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
        } catch {}
        if (this.socket === socket) this.socket = null;
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        if (this.closing) {
          // The call ended while the handshake was still in flight: never send `start` or pings.
          try {
            socket.close(1000, "ended");
          } catch {}
          finish(new Error("The voice call was ended."));
          return;
        }
        opened = true;
        this.started = true;
        this.lastMessageAt = Date.now();
        this.send({ t: "start", threadId: this.threadId, engine: this.engine });
        this.ping = setInterval(() => {
          // The server answers every ping and ends a silent socket after 45 s. If nothing at all arrives for
          // two intervals the connection is dead even though the browser has not reported a close.
          if (Date.now() - this.lastMessageAt > 40_000) {
            this.abort();
            this.events.onDropped();
            return;
          }
          this.send({ t: "ping" });
        }, 10_000);
        finish();
      };
      socket.onerror = () => {
        finish(new Error("The voice call could not connect."));
      };
      socket.onclose = () => {
        this.clearPing();
        // A handshake rejected before it opened (auth or Origin) can close without an error event.
        finish(new Error("The voice call could not connect."));
        if (this.socket === socket) this.socket = null;
        if (!this.closing) this.events.onDropped();
      };
      socket.onmessage = (event) => {
        if (this.closing) return;
        this.lastMessageAt = Date.now();
        if (typeof event.data === "string") {
          let message: ServerMessage;
          try {
            message = JSON.parse(event.data) as ServerMessage;
          } catch {
            return;
          }
          this.events.onMessage(message);
          return;
        }
        const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : null;
        if (!bytes || bytes.byteLength <= CALL_AUDIO_HEADER) return;
        const id = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
        this.events.onAudio(id, bytes.subarray(CALL_AUDIO_HEADER));
      };
    });
  }

  get isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get hasStarted() {
    return this.started;
  }

  send(message: ClientMessage): void {
    if (this.closing) return;
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  sendAudio(pcm: Int16Array): void {
    if (this.closing) return;
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(pcm);
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.clearPing();
    const socket = this.socket;
    this.socket = null;
    // A pending handshake is ended too; leaving it CONNECTING would still fire `onopen` later.
    this.openReject?.(new Error("The voice call was ended."));
    this.openReject = null;
    if (!socket) return;
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "end" } satisfies ClientMessage));
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000, "ended");
    } catch {}
  }

  /** Drops the socket after a fatal error the server already reported; no `end` is needed. */
  abort(): void {
    this.closing = true;
    this.clearPing();
    const socket = this.socket;
    this.socket = null;
    this.openReject?.(new Error("The voice call ended."));
    this.openReject = null;
    try {
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) socket.close();
    } catch {}
  }

  private clearPing() {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
  }
}
