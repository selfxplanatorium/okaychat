import type { LanguageModelV4Usage } from "@ai-sdk/provider";
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
    if (usage) settleCreditRequest(id, { state: "reported", usage, cost: costOf(options.model.cost, usage) });
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
      if (params.abortSignal?.aborted) {
        settleCreditRequest(id, { state: "not_dispatched", errorCode: "aborted" });
        params.abortSignal.throwIfAborted();
      }
      try { markCreditDispatched(id); } catch (error) {
        settleCreditRequest(id, { state: "not_dispatched", errorCode: "admission_denied" });
        throw error;
      }
      let result;
      try { result = await doGenerate(); } catch (error) { fail(id, error); throw error; }
      // Persistence errors propagate with the request still open and the root still held.
      finish(id, result.usage);
      return result;
    },
    wrapStream: async ({ doStream, params }) => {
      const id = begin();
      if (params.abortSignal?.aborted) {
        settleCreditRequest(id, { state: "not_dispatched", errorCode: "aborted" });
        params.abortSignal.throwIfAborted();
      }
      const abort = new AbortController();
      params.abortSignal = params.abortSignal ? AbortSignal.any([params.abortSignal, abort.signal]) : abort.signal;
      try { markCreditDispatched(id); } catch (error) {
        settleCreditRequest(id, { state: "not_dispatched", errorCode: "admission_denied" });
        throw error;
      }
      let result;
      try { result = await doStream(); } catch (error) { fail(id, error); throw error; }
      const reader = result.stream.getReader();
      let ended = false;
      let persistenceFailed = false;
      const unknown = () => {
        if (!persistenceFailed) settleCreditRequest(id, { state: "unknown", errorCode: "stream_incomplete" });
      };
      return {
        ...result,
        stream: new ReadableStream({
          async pull(controller) {
            try {
              const { value, done } = await reader.read();
              if (done) { unknown(); ended = true; controller.close(); return; }
              // Capture before forwarding, including a finish received before subsequent failure.
              if (value.type === "finish") {
                try { finish(id, value.usage); } catch (error) { persistenceFailed = true; throw error; }
              }
              controller.enqueue(value);
            } catch (error) {
              abort.abort(error);
              try { await reader.cancel(error); } finally { unknown(); ended = true; }
              controller.error(error);
            }
          },
          async cancel(reason) {
            if (ended) return;
            abort.abort(reason);
            try { await reader.cancel(reason); } finally { unknown(); ended = true; }
          },
        }, { highWaterMark: 0 }),
      };
    },
  };
}
