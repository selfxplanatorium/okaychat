import type { CreditOrigin } from "../../shared/token-credits.js";
import { admitCreditRoot, assertCreditPermit, closeCreditRoot, CreditError, getCreditBalance, type CreditPermit } from "./store.js";
interface Runtime { controller: AbortController; work: Set<Promise<void>> }
const runtimes = new WeakMap<CreditPermit, Runtime>();
function runtime(permit: CreditPermit): Runtime {
  let value = runtimes.get(permit);
  if (!value) { value = { controller: new AbortController(), work: new Set() }; runtimes.set(permit, value); }
  return value;
}
export function creditSignal(permit: CreditPermit, signal?: AbortSignal): AbortSignal {
  const root = runtime(permit).controller.signal;
  return signal ? AbortSignal.any([root, signal]) : root;
}
export function holdCreditWork(permit: CreditPermit): () => void {
  const value = runtime(permit);
  let done!: () => void;
  const promise = new Promise<void>(resolve => { done = resolve; });
  value.work.add(promise);
  return () => { value.work.delete(promise); done(); };
}
export async function endCreditRoot(permit: CreditPermit): Promise<void> {
  const value = runtime(permit);
  value.controller.abort();
  while (value.work.size) await Promise.all(value.work);
  closeCreditRoot(permit);
}
export async function withCreditRoot<T>(userId: string, origin: CreditOrigin, fn: (permit: CreditPermit) => Promise<T>): Promise<T> {
  const permit = admitCreditRoot(userId, origin);
  try { return await fn(permit); } finally { await endCreditRoot(permit); }
}
export function finiteCredits(userId: string): boolean { return getCreditBalance(userId).creditTokens !== null; }
export function assertMeteredService(userId: string, service: string): void {
  if (finiteCredits(userId)) throw new CreditError("token_credit_unmetered", "This service cannot be used with a token allowance. Contact your administrator.", { service });
}
export async function withUnmeteredRoot<T>(userId: string, service: string, fn: () => Promise<T>): Promise<T> {
  assertMeteredService(userId, service);
  return withCreditRoot(userId, "unmetered", async () => fn());
}
/** How long an aborted turn may take to flush its final frames before the root is forced closed. */
export const CREDIT_ABORT_GRACE_MS = 15_000;

/**
 * The stream owns admission through EOF/cancel. An abort reaches the inner work through
 * `creditSignal`, which ends it with its own final frames; a consumer that stops pulling after an
 * abort is cut off after a grace period so the root cannot stay held.
 */
export function creditOwnedStream<T>(source: ReadableStream<T>, permit: CreditPermit, signal?: AbortSignal): ReadableStream<T> {
  const reader = source.getReader();
  let cleanup: Promise<void> | undefined;
  let output: ReadableStreamDefaultController<T>;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const end = (cancel: boolean, reason?: unknown) => cleanup ??= (async () => {
    signal?.removeEventListener("abort", onAbort);
    clearTimeout(grace);
    if (cancel) runtime(permit).controller.abort(reason);
    try { if (cancel) await reader.cancel(reason); } finally { await endCreditRoot(permit); }
  })();
  const onAbort = () => {
    runtime(permit).controller.abort(signal?.reason);
    grace = setTimeout(() => {
      void end(true, signal?.reason).then(() => output.error(signal?.reason), (error) => output.error(error));
    }, CREDIT_ABORT_GRACE_MS);
    grace.unref?.();
  };
  return new ReadableStream<T>({
    start(c) { output = c; signal?.addEventListener("abort", onAbort, { once: true }); if (signal?.aborted) onAbort(); },
    async pull(c) {
      try { const r = await reader.read(); if (r.done) { await end(false); c.close(); } else c.enqueue(r.value); }
      catch (error) { try { await end(true, error); } finally { c.error(error); } }
    },
    async cancel(reason) { await end(true, reason); },
  }, { highWaterMark: 0 });
}
