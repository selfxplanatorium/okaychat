import { creditSignal, holdCreditWork } from "./admission.js";
import type { LanguageModelV4Usage, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { LanguageModelMiddleware } from "ai";
import type { ModelInfo, TokenUsage } from "../../shared/types.js";
import { costOf, type UsageKind } from "../usage.js";
import { assertCreditPermit, beginCreditRequest, markCreditDispatched, settleCreditRequest, validCreditUsage, type CreditContext, type CreditPermit } from "./store.js";

/** Raw adapter totals are optional. Never turn absent telemetry into a reported zero. */
export function rawCreditUsage(raw: LanguageModelV4Usage | undefined): TokenUsage | undefined {
  const input = raw?.inputTokens?.total;
  const output = raw?.outputTokens?.total;
  if (input === undefined || output === undefined) return;
  return validCreditUsage({ input, output, reasoning: raw?.outputTokens?.reasoning ?? 0, cacheRead: raw?.inputTokens?.cacheRead ?? 0, cacheWrite: raw?.inputTokens?.cacheWrite ?? 0 });
}

/**
 * Integration must place this immediately around the raw adapter, inside policy middleware.
 * The caller owns the root through consumption and child cleanup. This module does not admit roots.
 */
export function creditModelMiddleware(options: {
  permit: CreditPermit; userId: string; model: ModelInfo; kind: UsageKind; context?: CreditContext;
}): LanguageModelMiddleware {
  const begin = () => {
    assertCreditPermit(options.permit, options.userId);
    return beginCreditRequest(options.permit, { providerId: options.model.providerId, modelId: options.model.id, kind: options.kind, context: options.context });
  };
  const finish = (id: string, raw?: LanguageModelV4Usage) => {
    const usage = rawCreditUsage(raw);
    // The price is a display estimate from external catalog data; a malformed one must not block the debit.
    const cost = usage ? costOf(options.model.cost, usage) : 0;
    if (usage) settleCreditRequest(id, { state: "reported", usage, cost: Number.isFinite(cost) && cost >= 0 ? cost : 0 });
    else settleCreditRequest(id, { state: "unknown", errorCode: "missing_usage" });
  };
  // Only explicit HTTP rejection evidence is safe to call free. A protocol/error frame after
  // output or a connection loss is ambiguous, even when the SDK describes it as retryable.
  const fail = (id: string, error: unknown) => {
    const status = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
    settleCreditRequest(id, { state: [400, 401, 403, 404, 413, 422, 429].includes(Number(status)) ? "rejected" : "unknown", errorCode: "provider_error" });
  };
  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      const id = begin();
      const release = holdCreditWork(options.permit);
      params.abortSignal = creditSignal(options.permit, params.abortSignal);
      try {
        if (params.abortSignal.aborted) {
          settleCreditRequest(id, { state: "not_dispatched", errorCode: "aborted" });
          params.abortSignal.throwIfAborted();
        }
        try { markCreditDispatched(id); } catch (error) {
          settleCreditRequest(id, { state: "not_dispatched", errorCode: "admission_denied" }); throw error;
        }
        let result;
        try { result = await doGenerate(); } catch (error) { fail(id, error); throw error; }
        finish(id, result.usage);
        return result;
      } finally { release(); }
    },
    wrapStream: async ({ doStream, params }) => {
      const id = begin();
      const release = holdCreditWork(options.permit);
      const abort = new AbortController();
      const signal = AbortSignal.any([creditSignal(options.permit, params.abortSignal), abort.signal]);
      params.abortSignal = signal;
      if (signal.aborted) {
        try { settleCreditRequest(id, { state: "not_dispatched", errorCode: "aborted" }); signal.throwIfAborted(); } finally { release(); }
      }
      try { markCreditDispatched(id); } catch (error) {
        try { settleCreditRequest(id, { state: "not_dispatched", errorCode: "admission_denied" }); } finally { release(); } throw error;
      }
      let result;
      try { result = await doStream(); } catch (error) { try { fail(id, error); } finally { release(); } throw error; }
      const reader = result.stream.getReader();
      let output: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
      let cleanup: Promise<void> | undefined;
      let persistenceFailed = false;
      const end = (cancel: boolean, reason?: unknown) => cleanup ??= (async () => {
        signal.removeEventListener("abort", onAbort);
        if (cancel) abort.abort(reason);
        try { if (cancel) await reader.cancel(reason); }
        finally {
          try { if (!persistenceFailed) settleCreditRequest(id, { state: "unknown", errorCode: "stream_incomplete" }); }
          finally { release(); }
        }
      })();
      const onAbort = () => { void end(true, signal.reason).then(() => output.error(signal.reason), error => output.error(error)); };
      return {
        ...result,
        stream: new ReadableStream({
          start(controller) { output = controller; signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort(); },
          async pull(controller) {
            try {
              const { value, done } = await reader.read();
              if (done) { await end(false); controller.close(); return; }
              if (value.type === "finish") {
                try { finish(id, value.usage); } catch (error) { persistenceFailed = true; throw error; }
              }
              controller.enqueue(value);
            } catch (error) { try { await end(true, error); } finally { controller.error(error); } }
          },
          async cancel(reason) { await end(true, reason); },
        }, { highWaterMark: 0 }),
      };
    },
  };
}
