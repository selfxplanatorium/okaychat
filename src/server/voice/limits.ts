// Hard bounds for one voice call. See docs/implementation/voice-calls.md ("Limits").

const minutes = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export interface CallLimits {
  /** Longest call, counted from `ready`. */
  maxSeconds: number;
  /** A call with no utterance and no spoken sentence for this long ends. */
  idleSeconds: number;
  /** No message at all (the client pings every 10 s) for this long means the connection is gone. */
  silentSocketSeconds: number;
  /** Longest single utterance. The admin's recording limit applies when it is lower. */
  maxUtteranceSeconds: number;
  /** All microphone bytes of one call. */
  maxInputBytes: number;
  /** Characters of one `say`. */
  maxSayChars: number;
  /** All spoken characters of one call. */
  maxTtsChars: number;
  /** Sentences waiting to be spoken. */
  maxQueue: number;
  /** Seconds the client has to send `start` after the upgrade. */
  startSeconds: number;
  /** Longest time from upgrade to `ready` while the worker warms or downloads models. */
  prepareSeconds: number;
  /** Call starts per account in `startWindowSeconds`. */
  maxStarts: number;
  startWindowSeconds: number;
  /** Largest WebSocket message. */
  maxMessageBytes: number;
}

export const callLimits = (): CallLimits => ({
  maxSeconds: Math.round(minutes("OKAYCHAT_VOICE_MAX_MINUTES", 30) * 60),
  idleSeconds: Math.round(minutes("OKAYCHAT_VOICE_IDLE_MINUTES", 5) * 60),
  silentSocketSeconds: 45,
  maxUtteranceSeconds: 120,
  maxInputBytes: 64 * 1024 * 1024,
  maxSayChars: 1500,
  maxTtsChars: 200_000,
  maxQueue: 64,
  startSeconds: 10,
  prepareSeconds: 10 * 60,
  maxStarts: 10,
  startWindowSeconds: 600,
  maxMessageBytes: 256 * 1024,
});

/** Sliding window of call starts per account, in memory. A restart resets it, like the login limits. */
export class StartLimiter {
  private readonly starts = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number) {}

  /** Records a start and returns true, or returns false when the account is over its limit. */
  take(userId: string, now = Date.now()): boolean {
    const recent = (this.starts.get(userId) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.max) {
      this.starts.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.starts.set(userId, recent);
    if (this.starts.size > 10_000) for (const [id, list] of this.starts) if (!list.some((at) => now - at < this.windowMs)) this.starts.delete(id);
    return true;
  }

  reset() {
    this.starts.clear();
  }
}
