export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...rest.headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 401 && !path.startsWith("/auth")) {
    window.dispatchEvent(new Event("okaychat:unauthorized"));
  }
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError((body as { error?: string })?.error ?? res.statusText, res.status);
  return body as T;
}

export const formatTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`;

export const formatCost = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

const prefetched = new Map<string, { promise: Promise<unknown>; at: number }>();
// A prefetch serves the screen that is mounting now. An older one could show stale data.
const PREFETCH_TTL_MS = 10_000;

/** Starts a GET whose result a later `takePrefetched` call for the same path receives once. */
export function prefetch(path: string) {
  const promise = api(path);
  promise.catch(() => {});
  prefetched.set(path, { promise, at: Date.now() });
}

export function takePrefetched<T>(path: string): Promise<T> | undefined {
  const hit = prefetched.get(path);
  prefetched.delete(path);
  return hit && Date.now() - hit.at < PREFETCH_TTL_MS ? (hit.promise as Promise<T>) : undefined;
}
