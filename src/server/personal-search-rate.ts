// Notes and calendar search run an FTS query per request. The query itself is bounded, but a looping
// editor or script should not be able to keep a core busy, so each account gets a small in-process
// window. It is deliberately not a general API limiter: plain list refreshes stay unlimited, and a
// restart clearing the window is harmless.
const WINDOW_MS = 60_000;
const WINDOW_LIMIT = 120;
const MAX_KEYS = 10_000;

interface Window {
  start: number;
  count: number;
}

const windows = new Map<string, Window>();

export function admitPersonalSearch(userId: string, now = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
  let window = windows.get(userId);
  if (!window || now - window.start >= WINDOW_MS) {
    if (!window && windows.size >= MAX_KEYS) {
      for (const [key, value] of windows) if (now - value.start >= WINDOW_MS) windows.delete(key);
      if (windows.size >= MAX_KEYS) return { ok: false, retryAfterMs: WINDOW_MS };
    }
    window = { start: now, count: 0 };
    windows.set(userId, window);
  }
  if (window.count >= WINDOW_LIMIT) return { ok: false, retryAfterMs: Math.max(1_000, WINDOW_MS - (now - window.start)) };
  window.count++;
  return { ok: true };
}

/** Test seam: a fresh process-like window per suite. */
export function resetPersonalSearchRate(): void {
  windows.clear();
}
