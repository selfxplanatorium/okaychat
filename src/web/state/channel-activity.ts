import { create } from "zustand";
import { CHANNEL_ACTIVITY_LIMITS, isChannelPresenceState, parseChannelActivityFrame, type ChannelActivityFrame, type ChannelPresenceState } from "@shared/channel-activity";
import { channelsApi } from "./channels-api";
import type { EphemeralCapability } from "./channels-events";

/**
 * One in-memory controller for presence and typing.
 *
 * It is deliberately not a second transport: the existing channel stream negotiates a connection id,
 * and this controller multiplexes one ordered sender over the activity and typing endpoints. Nothing
 * is persisted, and nothing is replayed: every connection generation starts from an empty view.
 */

export interface ChannelActivityView {
  /** A negotiated stream connection exists and is actively streaming. */
  available: boolean;
  /** At least one authorized snapshot/patch arrived for the current watch. */
  synchronized: boolean;
  channelId: string | null;
  rootId: string | null;
  /** Missing means "status unavailable"; offline is an explicit projected state. */
  presence: Readonly<Record<string, ChannelPresenceState>>;
  /** Keyed by `rootId ?? ""`; sorted account ids, self included so the UI can subtract it. */
  typing: Readonly<Record<string, readonly string[]>>;
}

export const EMPTY_CHANNEL_TYPING: readonly string[] = [];

const EMPTY_VIEW: ChannelActivityView = {
  available: false,
  synchronized: false,
  channelId: null,
  rootId: null,
  presence: {},
  typing: {},
};

export interface ChannelActivityApi {
  activity: (
    input: { connectionId: string; seq: number; state: "active" | "idle"; watch: { channelId: string; rootId: string | null } | null },
    signal?: AbortSignal,
  ) => Promise<{ acceptedSeq: number; watchRevision: number }>;
  typing: (
    input: { connectionId: string; seq: number; channelId: string; rootId: string | null; typing: boolean },
    signal?: AbortSignal,
  ) => Promise<{ acceptedSeq: number }>;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface ChannelActivityDeps {
  api: ChannelActivityApi;
  now: () => number;
  schedule: (fn: () => void, ms: number) => TimerHandle;
  cancel: (handle: TimerHandle) => void;
  random: () => number;
  onView: (view: ChannelActivityView) => void;
  onReconnect: () => void;
}

interface Scope {
  channelId: string;
  rootId: string | null;
}

const sameScope = (a: Scope | null, b: Scope | null): boolean => (a?.channelId ?? null) === (b?.channelId ?? null) && (a?.rootId ?? null) === (b?.rootId ?? null);

const visibleNow = (): boolean => typeof document === "undefined" || document.visibilityState !== "hidden";

export class ChannelActivityController {
  private capability: EphemeralCapability | null = null;
  private streaming = false;
  private publishDisabled = false;
  private view: ChannelActivityView = EMPTY_VIEW;
  private watch: Scope | null = null;
  private appliedWatch: Scope | null = null;
  private appliedRevision = 0;
  private watchPending: Scope | null = null;
  private buffered: ChannelActivityFrame | null = null;
  private activeIntent = false;
  private lastSignalAt = 0;
  private lastFrameAt = 0;
  private lastBytesAt = 0;
  private lastTypingSentAt = 0;
  /** Typing entries expire on their own lease: a missed clearing frame must not leave a name on screen. */
  private typingDeadlines: Record<string, Record<string, number>> = {};
  private lastInputAt = 0;
  private inputSinceLastTyping = false;
  private typingActive = false;
  private desiredActivity: { state: "active" | "idle"; watch: Scope | null; token: number } | null = null;
  private lastActivityToken = 0;
  private activityToken = 0;
  private desiredTyping: (Scope & { typing: boolean; token: number }) | null = null;
  private lastTypingToken = 0;
  private typingToken = 0;
  private seq = 0;
  private busy = false;
  private cooldownUntil = 0;
  private refreshTimer: TimerHandle | null = null;
  private idleTimer: TimerHandle | null = null;
  private typingStopTimer: TimerHandle | null = null;
  private tickTimer: TimerHandle | null = null;
  private cooldownTimer: TimerHandle | null = null;
  private watchDebounceTimer: TimerHandle | null = null;
  private stallSignalled = false;
  private disposed = false;
  private reconnect: () => void = () => {};

  constructor(private readonly deps: ChannelActivityDeps) {
    this.reconnect = deps.onReconnect;
  }

  viewState(): ChannelActivityView {
    return this.view;
  }

  setReconnectHandler(handler: () => void): void {
    this.reconnect = handler;
  }

  /** Called on `ready`: a null capability quietly disables indicators for an older server. */
  setAvailable(capability: EphemeralCapability | null): void {
    this.disposed = false;
    this.clearTimers();
    this.capability = capability;
    this.streaming = capability !== null;
    this.publishDisabled = false;
    this.seq = 0;
    this.lastActivityToken = 0;
    this.activityToken = 0;
    this.lastTypingToken = 0;
    this.typingToken = 0;
    this.desiredActivity = null;
    this.desiredTyping = null;
    this.buffered = null;
    this.watchPending = null;
    this.appliedWatch = null;
    this.appliedRevision = 0;
    this.typingActive = false;
    this.inputSinceLastTyping = false;
    this.cooldownUntil = 0;
    this.stallSignalled = false;
    const now = this.deps.now();
    this.lastFrameAt = now;
    this.lastBytesAt = now;
    this.setView({ ...EMPTY_VIEW, available: capability !== null, channelId: this.watch?.channelId ?? null, rootId: this.watch?.rootId ?? null });
    if (!capability) return;
    // Opening a stream is still not presence: this explicit first POST is.
    this.activeIntent = visibleNow();
    this.lastSignalAt = now;
    this.lastFrameAt = now;
    this.tickTimer = this.deps.schedule(() => this.tick(), 1_000);
    if (this.activeIntent) this.scheduleRefresh();
    this.queueActivity();
  }

  /** Transport left streaming (EOF, polling, offline, revoked). Everything ephemeral is discarded. */
  streamLost(): void {
    this.clearTimers();
    this.capability = null;
    this.streaming = false;
    this.publishDisabled = false;
    this.activeIntent = false;
    this.typingActive = false;
    this.desiredActivity = null;
    this.desiredTyping = null;
    this.lastActivityToken = 0;
    this.activityToken = 0;
    this.lastTypingToken = 0;
    this.typingToken = 0;
    this.watchPending = null;
    this.appliedWatch = null;
    this.buffered = null;
    this.setView({ ...EMPTY_VIEW });
  }

  dispose(): void {
    this.disposed = true;
    this.streamLost();
  }

  /** Any transport byte proves the socket is alive; the state freshness deadline is separate. */
  noteBytes(): void {
    this.lastBytesAt = this.deps.now();
  }

  /** A malformed or unknown ephemeral frame clears indicators and nothing else. */
  invalidFrame(): void {
    this.clearFrames();
  }

  receive(payload: unknown): void {
    if (!this.capability || !this.streaming) return;
    const serialized = JSON.stringify(payload) ?? "";
    if (new TextEncoder().encode(serialized).byteLength > CHANNEL_ACTIVITY_LIMITS.maxFrameBytes) {
      this.invalidFrame();
      return;
    }
    const frame = parseChannelActivityFrame(payload);
    if (!frame) {
      // An unknown ephemeral version is not a reason to drop the durable stream.
      this.invalidFrame();
      return;
    }
    if (this.watchPending || !sameScope(this.appliedWatch, this.watch)) {
      // At most one latest frame is kept while the watch response is in flight.
      this.buffered = frame;
      return;
    }
    this.applyFrame(frame);
  }

  setWatch(channelId: string | null, rootId: string | null = null): void {
    const next: Scope | null = channelId ? { channelId, rootId } : null;
    if (sameScope(this.watch, next)) return;
    this.watch = next;
    this.typingActive = false;
    this.inputSinceLastTyping = false;
    this.desiredTyping = null;
    if (this.typingStopTimer) this.deps.cancel(this.typingStopTimer);
    this.typingStopTimer = null;
    // Clear the old room's line synchronously; speculative status for the new room is never shown.
    this.setView({ ...this.view, channelId, rootId });
    this.clearFrames();
    if (!this.capability) return;
    this.watchPending = next;
    // The first watch bootstraps at once; later navigation is debounced so five quick clicks send
    // one latest scope instead of five.
    if (!this.appliedWatch) {
      this.queueActivity();
      return;
    }
    if (this.watchDebounceTimer) this.deps.cancel(this.watchDebounceTimer);
    this.watchDebounceTimer = this.deps.schedule(() => {
      this.watchDebounceTimer = null;
      this.queueActivity();
    }, 250);
  }

  /** Trusted app input: keydown, pointerdown, touch/pen, wheel, or scrolling. */
  signal(trusted: boolean): void {
    if (!trusted || this.disposed || !this.capability || !this.streaming || !visibleNow()) return;
    const now = this.deps.now();
    this.lastSignalAt = now;
    if (!this.activeIntent) {
      this.activeIntent = true;
      this.queueActivity();
      this.scheduleRefresh();
    } else if (!this.refreshTimer) {
      this.scheduleRefresh();
    }
    this.scheduleIdle();
  }

  typingInput(scope: Scope, text: string): void {
    if (this.disposed || !this.capability || !this.streaming || !visibleNow()) return;
    if (!this.watch || !sameScope(this.watch, scope)) return;
    this.signal(true);
    const now = this.deps.now();
    this.lastInputAt = now;
    if (!text.trim()) {
      this.stopTyping(scope);
      return;
    }
    this.inputSinceLastTyping = true;
    if (!this.typingActive) {
      this.typingActive = true;
      this.queueTyping(scope, true);
    } else if (now - this.lastTypingSentAt >= CHANNEL_ACTIVITY_LIMITS.typingRefreshMs && this.inputSinceLastTyping) {
      this.queueTyping(scope, true);
    }
    this.scheduleTypingStop();
  }

  typingStop(scope?: Scope): void {
    this.stopTyping(scope);
  }

  submit(scope?: Scope): void {
    this.stopTyping(scope);
  }

  hidden(): void {
    if (this.typingActive) this.stopTyping();
    this.clearTypingTimers();
    if (this.capability && this.activeIntent) {
      this.activeIntent = false;
      this.queueActivity();
    }
    if (this.refreshTimer) this.deps.cancel(this.refreshTimer);
    if (this.idleTimer) this.deps.cancel(this.idleTimer);
    this.refreshTimer = null;
    this.idleTimer = null;
  }

  visible(): void {
    if (!this.capability || !this.streaming || this.disposed) return;
    if (!visibleNow()) return;
    const now = this.deps.now();
    this.lastSignalAt = now;
    if (!this.activeIntent) {
      this.activeIntent = true;
      this.queueActivity();
    }
    this.scheduleRefresh();
    this.scheduleIdle();
  }

  // -------------------------------------------------------------------------------------------------

  private setView(patch: Partial<ChannelActivityView>): void {
    this.view = { ...this.view, ...patch };
    if (!this.disposed) this.deps.onView(this.view);
  }

  private clearFrames(): void {
    this.typingDeadlines = {};
    this.setView({ synchronized: false, presence: {}, typing: {} });
  }

  private typingView(): Record<string, readonly string[]> {
    const now = this.deps.now();
    const view: Record<string, readonly string[]> = {};
    for (const [scope, entries] of Object.entries(this.typingDeadlines)) {
      const live = Object.entries(entries).filter(([, until]) => until > now).map(([userId]) => userId).sort();
      if (live.length) view[scope] = live;
    }
    return view;
  }

  private stopTyping(scope?: Scope): void {
    this.clearTypingTimers();
    const wasActive = this.typingActive;
    this.typingActive = false;
    this.inputSinceLastTyping = false;
    if (!wasActive) return;
    const target = this.desiredTyping ?? (scope ?? this.watch);
    if (!target) return;
    if (scope && this.desiredTyping && !sameScope(this.desiredTyping, scope) && !sameScope(this.watch, scope)) return;
    this.queueTyping(target, false);
  }

  /** Every explicit intent gets a token so a repeated true still renews its lease. */
  private queueTyping(scope: Scope, typing: boolean): void {
    this.desiredTyping = { ...scope, typing, token: ++this.typingToken };
    this.kick();
  }

  private clearTypingTimers(): void {
    if (this.typingStopTimer) this.deps.cancel(this.typingStopTimer);
    this.typingStopTimer = null;
  }

  private scheduleTypingStop(): void {
    this.clearTypingTimers();
    const delay = Math.max(0, this.lastInputAt + CHANNEL_ACTIVITY_LIMITS.typingSilenceMs - this.deps.now());
    this.typingStopTimer = this.deps.schedule(() => {
      this.typingStopTimer = null;
      if (this.typingActive) this.stopTyping();
    }, delay);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) this.deps.cancel(this.refreshTimer);
    const jitter = 0.9 + this.deps.random() * 0.2;
    this.refreshTimer = this.deps.schedule(() => {
      this.refreshTimer = null;
      if (!this.capability || !this.streaming || !visibleNow()) return;
      if (!this.activeIntent) return;
      if (this.deps.now() - this.lastSignalAt >= CHANNEL_ACTIVITY_LIMITS.idleAfterMs) {
        this.markIdle();
        return;
      }
      this.queueActivity();
      this.scheduleRefresh();
    }, CHANNEL_ACTIVITY_LIMITS.activityRefreshMs * jitter);
  }

  private scheduleIdle(): void {
    if (this.idleTimer) this.deps.cancel(this.idleTimer);
    const delay = Math.max(0, this.lastSignalAt + CHANNEL_ACTIVITY_LIMITS.idleAfterMs - this.deps.now());
    this.idleTimer = this.deps.schedule(() => {
      this.idleTimer = null;
      if (!this.activeIntent) return;
      if (this.deps.now() - this.lastSignalAt < CHANNEL_ACTIVITY_LIMITS.idleAfterMs) {
        this.scheduleIdle();
        return;
      }
      this.markIdle();
    }, delay);
  }

  private markIdle(): void {
    if (!this.activeIntent) return;
    this.activeIntent = false;
    this.stopTyping();
    this.queueActivity();
  }

  private queueActivity(): void {
    if (!this.capability || !this.streaming) return;
    this.desiredActivity = {
      state: this.activeIntent && visibleNow() ? "active" : "idle",
      watch: this.watch,
      token: ++this.activityToken,
    };
    this.kick();
  }

  private kick(): void {
    if (this.busy || !this.capability || !this.streaming || this.publishDisabled || this.disposed) return;
    if (this.deps.now() < this.cooldownUntil) {
      this.scheduleCooldownFlush();
      return;
    }
    this.busy = true;
    void this.flush().finally(() => {
      this.busy = false;
    });
  }

  private scheduleCooldownFlush(): void {
    if (this.cooldownTimer) return;
    const delay = Math.max(0, this.cooldownUntil - this.deps.now());
    this.cooldownTimer = this.deps.schedule(() => {
      this.cooldownTimer = null;
      this.kick();
    }, delay);
  }

  private async flush(): Promise<void> {
    while (this.capability && this.streaming && !this.publishDisabled && !this.disposed) {
      if (this.deps.now() < this.cooldownUntil) {
        this.scheduleCooldownFlush();
        return;
      }
      const activity = this.desiredActivity;
      if (activity && activity.token !== this.lastActivityToken) {
          const capability = this.capability;
          const scope = activity.watch;
          const changingWatch = !sameScope(this.appliedWatch, scope);
          if (changingWatch) this.watchPending = scope;
          const seq = ++this.seq;
          try {
            const result = await this.deps.api.activity({ connectionId: capability.connectionId, seq, state: activity.state, watch: scope });
            if (!this.capability || this.capability.connectionId !== capability.connectionId) return;
            this.lastActivityToken = activity.token;
            if (changingWatch) {
              this.appliedWatch = scope;
              this.appliedRevision = result.watchRevision;
              this.watchPending = null;
              const buffered = this.buffered;
              this.buffered = null;
              if (buffered) this.applyFrame(buffered);
            }
          } catch (error) {
            this.handleFailure(error);
            return;
          }
          continue;
      }
      const typing = this.desiredTyping;
      if (typing && typing.token !== this.lastTypingToken) {
          const capability = this.capability;
          const seq = ++this.seq;
          try {
            await this.deps.api.typing({ connectionId: capability.connectionId, seq, channelId: typing.channelId, rootId: typing.rootId, typing: typing.typing });
            if (!this.capability || this.capability.connectionId !== capability.connectionId) return;
            this.lastTypingToken = typing.token;
            if (typing.typing) {
              this.lastTypingSentAt = this.deps.now();
              this.inputSinceLastTyping = false;
            }
          } catch (error) {
            this.handleFailure(error);
            return;
          }
          continue;
      }
      return;
    }
  }

  private handleFailure(error: unknown): void {
    const status = (error as { status?: unknown } | null)?.status;
    const retryAfterMs = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
    if (status === 429) {
      this.cooldownUntil = this.deps.now() + (typeof retryAfterMs === "number" ? retryAfterMs : 5_000);
      this.scheduleCooldownFlush();
      return;
    }
    // A lost/expired connection, a 404, or a network failure disables publishing until the next
    // negotiated stream; there is no automatic retry and no durable outbox.
    this.publishDisabled = true;
    this.watchPending = null;
    this.clearFrames();
  }

  private applyFrame(frame: ChannelActivityFrame): void {
    if (frame.kind === "clear") {
      if (frame.watchRevision === this.appliedRevision) this.clearFrames();
      return;
    }
    if (!this.appliedWatch || frame.channelId !== this.appliedWatch.channelId || frame.watchRevision !== this.appliedRevision) return;
    const watch = this.appliedWatch;
    this.stallSignalled = false;
    this.lastFrameAt = this.deps.now();
    if (frame.kind === "snapshot") {
      const presence: Record<string, ChannelPresenceState> = {};
      for (const entry of frame.presence) if (isChannelPresenceState(entry.state)) presence[entry.userId] = entry.state;
      const now = this.deps.now();
      this.typingDeadlines = {};
      for (const entry of frame.typing) {
        if (entry.rootId !== null && entry.rootId !== watch.rootId) continue;
        const key = entry.rootId ?? "";
        (this.typingDeadlines[key] ??= {})[entry.userId] = now + entry.remainingMs;
      }
      this.setView({ synchronized: true, presence, typing: this.typingView() });
      return;
    }
    const presence = { ...this.view.presence };
    for (const entry of frame.presence) if (isChannelPresenceState(entry.state)) presence[entry.userId] = entry.state;
    const now = this.deps.now();
    for (const scope of frame.typingScopes) {
      if (scope.rootId !== null && scope.rootId !== watch.rootId) continue;
      const key = scope.rootId ?? "";
      this.typingDeadlines[key] = Object.fromEntries(scope.items.map((item) => [item.userId, now + item.remainingMs]));
    }
    this.setView({ synchronized: true, presence, typing: this.typingView() });
  }

  private tick(): void {
    this.tickTimer = null;
    if (!this.capability || !this.streaming) return;
    const now = this.deps.now();
    if (this.view.synchronized && now - this.lastFrameAt > CHANNEL_ACTIVITY_LIMITS.displayFreshMs) {
      this.clearFrames();
      if (!this.stallSignalled) {
        this.stallSignalled = true;
        this.reconnect();
      }
    }
    if (now - this.lastBytesAt > CHANNEL_ACTIVITY_LIMITS.displayFreshMs && !this.stallSignalled) {
      this.stallSignalled = true;
      this.reconnect();
    }
    if (this.typingActive && now - this.lastInputAt >= CHANNEL_ACTIVITY_LIMITS.typingLeaseMs) this.stopTyping();
    // Drop names whose lease passed even if the clearing frame was lost.
    const before = JSON.stringify(this.view.typing);
    const pruned = this.typingView();
    if (JSON.stringify(pruned) !== before) this.setView({ typing: pruned });
    this.tickTimer = this.deps.schedule(() => this.tick(), 1_000);
  }

  private clearTimers(): void {
    for (const handle of [this.refreshTimer, this.idleTimer, this.typingStopTimer, this.tickTimer, this.cooldownTimer, this.watchDebounceTimer]) {
      if (handle) this.deps.cancel(handle);
    }
    this.refreshTimer = null;
    this.idleTimer = null;
    this.typingStopTimer = null;
    this.tickTimer = null;
    this.cooldownTimer = null;
    this.watchDebounceTimer = null;
  }
}

/** The reactive projection of the singleton controller. Selectors return primitives or stable refs. */
interface ChannelActivityStore extends ChannelActivityView {
  replace: (view: ChannelActivityView) => void;
}

export const useChannelActivity = create<ChannelActivityStore>((set) => ({
  ...EMPTY_VIEW,
  replace: (view) => set(view),
}));

let singletonReconnect: () => void = () => {};

export const channelActivity = new ChannelActivityController({
  api: channelsApi,
  now: () => Date.now(),
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle),
  random: () => Math.random(),
  onView: (view) => useChannelActivity.getState().replace(view),
  onReconnect: () => singletonReconnect(),
});

export function setChannelActivityReconnect(handler: (() => void) | null): void {
  singletonReconnect = handler ?? (() => {});
  channelActivity.setReconnectHandler(() => singletonReconnect());
}

/** The visible room or thread scope, or null when no channel workspace is open. */
export function setChannelWatch(channelId: string | null, rootId: string | null = null): void {
  channelActivity.setWatch(channelId, rootId);
}

export function channelTypingScope(channelId: string, rootId: string | null): { channelId: string; rootId: string | null } {
  return { channelId, rootId };
}

/**
 * Global trusted-input listeners for one transport lifetime. Passive where the browser allows it,
 * and no mousemove: presence follows deliberate interaction, not a cursor idling across the page.
 */
export function startChannelActivityInput(): () => void {
  const trusted = (event: Event) => channelActivity.signal(event.isTrusted);
  const onKey = (event: KeyboardEvent) => channelActivity.signal(event.isTrusted);
  const onVisibility = () => {
    if (document.visibilityState === "hidden") channelActivity.hidden();
    else channelActivity.visible();
  };
  const onPageHide = () => channelActivity.hidden();
  document.addEventListener("pointerdown", trusted, { passive: true });
  document.addEventListener("keydown", onKey);
  document.addEventListener("touchstart", trusted, { passive: true });
  document.addEventListener("wheel", trusted, { passive: true });
  document.addEventListener("scroll", trusted, { passive: true, capture: true });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  return () => {
    document.removeEventListener("pointerdown", trusted);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("touchstart", trusted);
    document.removeEventListener("wheel", trusted);
    document.removeEventListener("scroll", trusted, true);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
  };
}
