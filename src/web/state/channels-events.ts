import type { ChannelEventFrame } from "@shared/channels";

/**
 * One channel event transport per tab and account. Streams while visible; falls back to bounded polling
 * after repeated failures or while hidden. The server cursor is the only authority, so reconnects cannot
 * skip or duplicate content: frames are id-only invalidations and snapshots are refetched.
 */

export type TransportState = "streaming" | "polling" | "reconnecting" | "offline";

export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

export const MAX_FRAME_BYTES = 256 * 1024;

/** Incremental SSE frame parser. Call with decoded text chunks, then `flush()` when the stream ends. */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseFrame[] {
    this.buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const frames: SseFrame[] = [];
    for (;;) {
      const end = this.buffer.indexOf("\n\n");
      if (end < 0) break;
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      if (new TextEncoder().encode(raw).byteLength > MAX_FRAME_BYTES) throw new Error("SSE frame too large");
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
    }
    if (new TextEncoder().encode(this.buffer).byteLength > MAX_FRAME_BYTES) throw new Error("SSE frame too large");
    return frames;
  }

  flush(): SseFrame[] {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    const frame = parseFrame(this.buffer);
    this.buffer = "";
    return frame ? [frame] : [];
  }
}

export function parseFrame(raw: string): SseFrame | null {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length && !event) return null;
  return { ...(id ? { id } : {}), ...(event ? { event } : {}), data: data.join("\n") };
}

export interface TransportHandlers {
  /** The cursor a reconnect should resume from. */
  getCursor: () => string | undefined;
  onFrames: (frames: ChannelEventFrame[]) => void;
  onReset: (reason: string) => void;
  onRevoked: () => void;
  onState: (state: TransportState) => void;
  onSyncRequested: () => void;
}

const POLL_VISIBLE_MS = 5_000;
const POLL_HIDDEN_MS = 60_000;
const HIDDEN_CLOSE_MS = 30_000;

export function startChannelTransport(handlers: TransportHandlers): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  let failureTimes: number[] = [];
  let pollUntil = 0;

  const setState = (state: TransportState) => {
    if (!stopped) handlers.onState(state);
  };
  const clear = () => {
    controller?.abort();
    controller = null;
    if (pollTimer) clearTimeout(pollTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (hiddenTimer) clearTimeout(hiddenTimer);
    pollTimer = reconnectTimer = hiddenTimer = null;
  };
  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

  const scheduleReconnect = (immediate = false) => {
    if (stopped) return;
    if (!visible()) {
      setState("polling");
      schedulePoll(POLL_HIDDEN_MS);
      return;
    }
    const now = Date.now();
    failureTimes = [...failureTimes.filter((at) => now - at < 60_000), now];
    if (failureTimes.length >= 3 || now < pollUntil) {
      pollUntil = now + 60_000;
      setState("polling");
      schedulePoll(POLL_VISIBLE_MS, true);
      return;
    }
    setState(navigator.onLine === false ? "offline" : "reconnecting");
    const delay = immediate ? 0 : Math.min(30_000, 1_000 * 2 ** Math.max(0, failureTimes.length - 1)) * (0.8 + Math.random() * 0.4);
    reconnectTimer = setTimeout(() => void connect(), delay);
  };

  const schedulePoll = (delay: number, immediate = false) => {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    if (immediate) void poll();
    else pollTimer = setTimeout(() => void poll(), delay * (0.8 + Math.random() * 0.4));
  };

  const handleFrames = (frames: SseFrame[]): "continue" | "reset" | "revoked" => {
    if (!frames.length) return "continue";
    const events: ChannelEventFrame[] = [];
    let cursor = handlers.getCursor();
    for (const frame of frames) {
      if (frame.event === "ready") continue;
      if (frame.event === "reset") {
        let reason = "history_expired";
        try {
          const parsed = JSON.parse(frame.data) as { reason?: unknown };
          if (typeof parsed.reason === "string") reason = parsed.reason;
        } catch { /* keep the conservative reason */ }
        handlers.onReset(reason);
        return "reset";
      }
      if (frame.event === "revoked") {
        handlers.onRevoked();
        return "revoked";
      }
      if (!frame.id || !frame.event) continue;
      cursor = frame.id;
      try {
        const event = JSON.parse(frame.data) as ChannelEventFrame["event"];
        if (event && typeof event.type === "string") events.push({ cursor: frame.id, event });
      } catch {
        // A malformed event is not a body; reconnect and refetch instead of trusting it.
        throw new Error("malformed event");
      }
    }
    if (events.length) handlers.onFrames(events);
    return "continue";
  };

  const connect = async () => {
    if (stopped) return;
    clear();
    if (!visible()) {
      setState("polling");
      schedulePoll(POLL_HIDDEN_MS);
      return;
    }
    if (navigator.onLine === false) {
      setState("offline");
      return;
    }
    controller = new AbortController();
    const cursor = handlers.getCursor();
    try {
      const res = await fetch(`/api/channels/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, {
        credentials: "same-origin",
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        if (res.status === 401 || res.status === 403) {
          handlers.onRevoked();
          return;
        }
        if (res.status === 429) {
          setState("polling");
          schedulePoll(POLL_VISIBLE_MS, true);
          return;
        }
        if (res.status === 400) {
          handlers.onReset("history_expired");
          handlers.onSyncRequested();
          schedulePoll(POLL_VISIBLE_MS, true);
          return;
        }
        scheduleReconnect();
        return;
      }
      setState("streaming");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const frames = parser.push(decoder.decode(value, { stream: true }));
        const outcome = handleFrames(frames);
        if (outcome === "reset") {
          controller.abort();
          handlers.onSyncRequested();
          schedulePoll(POLL_VISIBLE_MS, true);
          return;
        }
        if (outcome === "revoked") {
          controller.abort();
          return;
        }
      }
      const tail = parser.push(decoder.decode());
      handleFrames([...tail, ...parser.flush()]);
      scheduleReconnect();
    } catch (error) {
      if (stopped || (error as Error).name === "AbortError") return;
      scheduleReconnect();
    }
  };

  const poll = async () => {
    if (stopped) return;
    const cursor = handlers.getCursor();
    if (!cursor) {
      setState("reconnecting");
      scheduleReconnect();
      return;
    }
    try {
      const res = await fetch(`/api/channels/changes?cursor=${encodeURIComponent(cursor)}`, { credentials: "same-origin" });
      if (res.status === 401 || res.status === 403) {
        handlers.onRevoked();
        return;
      }
      if (!res.ok) {
        schedulePoll(visible() ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
        return;
      }
      const body = (await res.json()) as { reset?: boolean; reason?: string; events?: ChannelEventFrame[] };
      if (body.reset) {
        handlers.onReset(body.reason ?? "history_expired");
        handlers.onSyncRequested();
      } else if (body.events?.length) {
        handlers.onFrames(body.events);
      }
      if (!stopped) {
        if (Date.now() < pollUntil) schedulePoll(POLL_VISIBLE_MS, true);
        else schedulePoll(visible() ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
      }
    } catch {
      if (!stopped) schedulePoll(visible() ? 10_000 : POLL_HIDDEN_MS);
    }
  };

  const onVisibility = () => {
    if (stopped) return;
    if (document.visibilityState === "hidden") {
      hiddenTimer = setTimeout(() => {
        controller?.abort();
        setState("polling");
        schedulePoll(POLL_HIDDEN_MS);
      }, HIDDEN_CLOSE_MS);
    } else {
      if (hiddenTimer) clearTimeout(hiddenTimer);
      hiddenTimer = null;
      pollUntil = 0;
      failureTimes = [];
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      void connect();
    }
  };
  const onOnline = () => { failureTimes = []; pollUntil = 0; void connect(); };
  const onOffline = () => { controller?.abort(); setState("offline"); };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  void connect();

  return () => {
    stopped = true;
    clear();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}
