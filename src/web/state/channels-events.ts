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

export interface EphemeralCapability {
  connectionId: string;
  activityLeaseMs: number;
  typingLeaseMs: number;
}

export interface TransportHandlers {
  /** The cursor a reconnect should resume from. */
  getCursor: () => string | undefined;
  onFrames: (frames: ChannelEventFrame[]) => void;
  onReset: (reason: string) => void;
  onRevoked: () => void;
  onState: (state: TransportState) => void;
  onSyncRequested: () => void;
  /** The negotiated ephemeral capability, or null when this server does not offer one. */
  onReady?: (capability: EphemeralCapability | null) => void;
  /** A validated-by-the-caller ephemeral payload. Never enters the durable cursor. */
  onEphemeral?: (payload: unknown) => void;
  /** A malformed or oversized ephemeral frame: clear indicators, never touch durable state. */
  onEphemeralInvalid?: () => void;
  /** Any bytes arrived, including a heartbeat; resets the separate stream-stall deadline. */
  onBytes?: () => void;
}

export interface ChannelTransportHandle {
  stop: () => void;
  /** Asks the transport to try SSE again now, e.g. after a stale presence window. */
  reconnect: () => void;
}

const POLL_VISIBLE_MS = 5_000;
const POLL_HIDDEN_MS = 60_000;
const HIDDEN_CLOSE_MS = 30_000;
const COOLDOWN_MS = 60_000;

/** Routing a durable cursor needs an id; an ephemeral frame never carries one. */
function parseReadyCapability(data: string): EphemeralCapability | null {
  try {
    const parsed = JSON.parse(data) as { v?: unknown; ephemeral?: unknown };
    if (parsed.v !== 1 || !parsed.ephemeral || typeof parsed.ephemeral !== "object") return null;
    const capability = parsed.ephemeral as { v?: unknown; connectionId?: unknown; activityLeaseMs?: unknown; typingLeaseMs?: unknown };
    if (capability.v !== 1) return null;
    if (typeof capability.connectionId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(capability.connectionId)) return null;
    if (typeof capability.activityLeaseMs !== "number" || typeof capability.typingLeaseMs !== "number") return null;
    if (!Number.isInteger(capability.activityLeaseMs) || !Number.isInteger(capability.typingLeaseMs)) return null;
    return { connectionId: capability.connectionId, activityLeaseMs: capability.activityLeaseMs, typingLeaseMs: capability.typingLeaseMs };
  } catch {
    return null;
  }
}

export function startChannelTransport(handlers: TransportHandlers): ChannelTransportHandle {
  let stopped = false;
  let controller: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
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
    if (cooldownTimer) clearTimeout(cooldownTimer);
    pollTimer = reconnectTimer = hiddenTimer = cooldownTimer = null;
  };
  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

  const schedulePoll = (delay: number) => {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    // Jitter only lengthens the interval, so a visible tab never polls more often than every 5 s.
    pollTimer = setTimeout(() => void poll(), delay * (1 + Math.random() * 0.1));
  };

  /** A cooldown polls the durable fallback only, then tries SSE again instead of polling forever. */
  const enterCooldown = (ms = COOLDOWN_MS) => {
    if (stopped) return;
    pollUntil = Date.now() + ms;
    setState("polling");
    schedulePoll(visible() ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
    if (cooldownTimer) clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      pollUntil = 0;
      if (!stopped) void connect();
    }, ms);
  };

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
      enterCooldown();
      return;
    }
    setState(navigator.onLine === false ? "offline" : "reconnecting");
    const delay = immediate ? 0 : Math.min(30_000, 1_000 * 2 ** Math.max(0, failureTimes.length - 1)) * (0.8 + Math.random() * 0.4);
    reconnectTimer = setTimeout(() => void connect(), delay);
  };

  const handleFrames = (frames: SseFrame[]): "continue" | "reset" | "revoked" => {
    if (!frames.length) return "continue";
    const events: ChannelEventFrame[] = [];
    let cursor = handlers.getCursor();
    for (const frame of frames) {
      if (frame.event === "ready") {
        handlers.onReady?.(parseReadyCapability(frame.data));
        continue;
      }
      if (frame.event === "ephemeral") {
        // A durability marker on an ephemeral frame would let a reconnect replay it; drop it whole.
        if (frame.id) {
          handlers.onEphemeralInvalid?.();
          continue;
        }
        if (new TextEncoder().encode(frame.data).byteLength > 64 * 1024) {
          handlers.onEphemeralInvalid?.();
          continue;
        }
        try {
          handlers.onEphemeral?.(JSON.parse(frame.data));
        } catch {
          handlers.onEphemeralInvalid?.();
        }
        continue;
      }
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
      const res = await fetch(`/api/channels/events?ephemeral=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {
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
          const retryAfter = Number(res.headers.get("retry-after"));
          enterCooldown(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : COOLDOWN_MS);
          return;
        }
        if (res.status === 400) {
          handlers.onReset("history_expired");
          handlers.onSyncRequested();
          enterCooldown();
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
        // Any transport byte, heartbeat included, proves the stream is alive.
        handlers.onBytes?.();
        const frames = parser.push(decoder.decode(value, { stream: true }));
        const outcome = handleFrames(frames);
        if (outcome === "reset") {
          controller.abort();
          handlers.onSyncRequested();
          enterCooldown();
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
      // Never reschedule immediately: a cooldown is a polling interval, not a request loop. The
      // cooldown timer is what returns to SSE.
      if (!stopped) schedulePoll(visible() ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
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
      if (pollTimer) clearTimeout(pollTimer);
      hiddenTimer = null;
      pollTimer = null;
      pollUntil = 0;
      failureTimes = [];
      void connect();
    }
  };
  const onOnline = () => { failureTimes = []; pollUntil = 0; void connect(); };
  const onOffline = () => {
    clear();
    failureTimes = [];
    pollUntil = 0;
    if (stopped) return;
    setState("offline");
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  void connect();

  return {
    stop: () => {
      stopped = true;
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    },
    reconnect: () => {
      if (stopped) return;
      failureTimes = [];
      pollUntil = 0;
      clear();
      void connect();
    },
  };
}
