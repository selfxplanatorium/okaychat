import type { LanguageModelMiddleware } from "ai";
import type { ModelInfo } from "../../shared/types.js";
import { estimateTokens } from "../compaction.js";
import { AppError } from "../errors.js";
import { onPermissionChange } from "./audit.js";
import { assertModelAllowed } from "./guard.js";
import { holdLease, reserveOperation } from "./limits.js";

/** Admission estimates include the actual step's messages and tool schemas, including tool results. */
export function modelPolicy(userId: string, info: ModelInfo, checkResource: () => void): LanguageModelMiddleware {
  const check = () => {
    checkResource();
    return assertModelAllowed(userId, info.ref);
  };
  const begin = (signal?: AbortSignal) => {
    check();
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    combined.throwIfAborted();
    const release = holdLease(reserveOperation({ userId, modelRef: info.ref }, "llm.call"), () => controller.abort(new AppError({ code: "aborted", message: "The operation lease expired." })));
    const unsubscribe = onPermissionChange(() => {
      try { check(); } catch (error) { controller.abort(error); }
    });
    let done = false;
    return { signal: combined, end: () => { if (done) return; done = true; unsubscribe(); release(); } };
  };
  return {
    transformParams: async ({ params }) => {
      const policy = check();
      const context = Math.min(info.context, policy.limits.contextTokens ?? Infinity);
      const input = estimateTokens({ prompt: params.prompt, tools: params.tools });
      const output = Math.min(info.maxOutput || Infinity, policy.limits.outputTokens ?? Infinity, params.maxOutputTokens ?? Infinity, context - input);
      if (output < 1) throw new AppError({ code: "context_length", status: 422, message: "This request exceeds the allowed context estimate.", details: { reason: "context_limit" } });
      return { ...params, ...(Number.isFinite(output) ? { maxOutputTokens: Math.floor(output) } : {}) };
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      const operation = begin(params.abortSignal);
      params.abortSignal = operation.signal;
      try { return await doGenerate(); } finally { operation.end(); }
    },
    wrapStream: async ({ doStream, params }) => {
      const operation = begin(params.abortSignal);
      params.abortSignal = operation.signal;
      try {
        const result = await doStream();
        const reader = result.stream.getReader();
        let chars = 0;
        return {
          ...result,
          stream: new ReadableStream({
            async pull(controller) {
              try {
                operation.signal.throwIfAborted();
                const { value, done } = await reader.read();
                if (done) { operation.end(); controller.close(); return; }
                if (value.type === "text-delta" || value.type === "reasoning-delta") chars += value.delta.length;
                // This stop is approximate; transports also receive their native output parameter.
                if (params.maxOutputTokens !== undefined && chars > params.maxOutputTokens * 4) {
                  await reader.cancel(); operation.end();
                  controller.error(new AppError({ code: "context_length", message: "The output estimate reached the allowed limit." }));
                  return;
                }
                controller.enqueue(value);
              } catch (error) { operation.end(); await reader.cancel(error).catch(() => {}); controller.error(error); }
            },
            async cancel(reason) { try { await reader.cancel(reason); } finally { operation.end(); } },
          }),
        };
      } catch (error) { operation.end(); throw error; }
    },
  };
}
