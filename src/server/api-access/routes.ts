import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  API_ACCESS_LIMITS,
  API_LIMITS,
  API_SCOPES,
  type ApiKeySummary,
  type ApiScope,
  type ApiUsageDays,
  type ApiUsageResponse,
  type ModelList,
} from "../../shared/api-access.js";
import type { ModelInfo, ReasoningEffort } from "../../shared/types.js";
import type { AppEnv } from "../auth.js";
import { getConnection, listModels, resolveModel, type Connection } from "../catalog/providers.js";
import { newId } from "../crypto.js";
import { AppError, errorJson } from "../errors.js";
import { createModel } from "../llm.js";
import { assertModelAllowed } from "../permissions/guard.js";
import { resolvePrompt } from "../prompt-policy.js";
import { estimateTokens } from "../compaction.js";
import { apiContext, apiAuth, apiGate, apiPath, liveDenial, type ApiEnv } from "./auth.js";
import { generateCompletion } from "./generate.js";
import {
  apiAccessEnabled,
  apiModelAllowed,
  authenticateApiToken,
  createApiKey,
  getApiKey,
  hasScope,
  listApiKeys,
  principalAlive,
  revokeApiKey,
} from "./keys.js";
import { abortApiCalls, admitApiCall, admitCatalogCall, chargeApiRate } from "./limits.js";
import {
  apiFailure,
  apiHeaders,
  contextLengthExceeded,
  describeApiFailure,
  invalidPolicy,
  methodNotAllowed,
  notFound,
  permissionDenied,
  protocolError,
  sendApiError,
  unsupportedParameter,
} from "./protocol.js";
import { acceptsJson, hasUnsupportedEncoding, parseChatRequest, readBoundedBody, readStrictManagementBody, validApiModel } from "./schema.js";
import { apiAuditPage, apiRequestsPage, apiUsage, decodeRequestCursor, markApiDispatched, openApiRequest, pruneApiTelemetry, settleApiRequest } from "./store.js";

// Session-owned key management (mounted under the existing `/api`) and the independent `/v1` inference
// router (docs/implementation/api-access.md). No bearer credential can reach the management routes, and
// no cookie can authenticate an inference request.

const SUPPORTED_FORMATS = new Set(["openai-responses", "openai-chat", "anthropic", "google", "ollama"]);

/** The single eligibility predicate for listing and dispatch. */
export function apiEligible(info: ModelInfo): boolean {
  if (info.providerId === "chatgpt" || info.ref.startsWith("n8n/")) return false;
  return SUPPORTED_FORMATS.has(info.format);
}

/** A failure after the receipt exists but before the provider was invoked still records honestly. */
function settleFailed(id: string, principal: { userId: string; keyId: string }, model: ModelInfo, status: number, code: string): void {
  try {
    settleApiRequest({
      id,
      userId: principal.userId,
      keyId: principal.keyId,
      providerId: model.providerId,
      modelId: model.id,
      settlement: { state: "failed", httpStatus: status, errorCode: code, finishReason: null, usage: null },
    });
  } catch {
    // A receipt that cannot be settled is reported by the request itself; no success is claimed.
  }
}

// Management rate limits: reads 120/minute, mutations 20/minute, per account. In-memory and bounded, like
// the auth failure counters; a restart resets them, which only helps a caller who can also restart us.
const management = new Map<string, { read: number; mutate: number; resetAt: number }>();
const MANAGEMENT_LIMIT = 10_000;

function managementAllowed(userId: string, kind: "read" | "mutate"): boolean {
  const now = Date.now();
  let entry = management.get(userId);
  if (!entry || entry.resetAt <= now) {
    entry = { read: 0, mutate: 0, resetAt: now + 60_000 };
    if (management.size >= MANAGEMENT_LIMIT) management.clear();
    management.set(userId, entry);
  }
  entry[kind]++;
  return entry[kind] <= (kind === "read" ? 120 : 20);
}

/** Test seam. */
export function resetManagementLimits(): void {
  management.clear();
}

const createBody = z.strictObject({
  label: z.string(),
  scopes: z.array(z.string()).min(1).max(API_SCOPES.length),
  expiresAt: z.number().nullable(),
});

/** GET routes reject a nonempty request body instead of silently ignoring it. */
function hasRequestBody(c: Context): boolean {
  const length = c.req.header("content-length");
  if (length !== undefined && length !== "0") return true;
  const encoding = c.req.header("transfer-encoding");
  return encoding !== undefined && encoding !== "";
}

const noStore = (c: Context) => {
  c.header("Cache-Control", "no-store");
};

function rateLimited(c: Context): Response | null {
  if (!managementAllowed(c.get("user").id, "read")) {
    return errorJson(c, new AppError({ code: "rate_limited", message: "Too many API management requests. Try again shortly.", retryAfterMs: 60_000 }));
  }
  return null;
}

function mutateLimited(c: Context): Response | null {
  if (!managementAllowed(c.get("user").id, "mutate")) {
    return errorJson(c, new AppError({ code: "rate_limited", message: "Too many API key changes. Try again shortly.", retryAfterMs: 60_000 }));
  }
  return null;
}

export const apiKeyRoutes = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  })
  .get("/api-keys", (c) => {
    const limited = rateLimited(c);
    if (limited) return limited;
    if (hasRequestBody(c)) return errorJson(c, new AppError({ code: "validation", message: "This request takes no body." }));
    const userId = c.get("user").id;
    noStore(c);
    return c.json({ keys: listApiKeys(userId), limits: API_ACCESS_LIMITS, enabled: apiAccessEnabled(userId), serverTime: Date.now() });
  })
  .post("/api-keys", async (c) => {
    const limited = mutateLimited(c);
    if (limited) return limited;
    if (!acceptsJson(c.req.header("content-type")) || hasUnsupportedEncoding(c.req.header("content-encoding"))) {
      return errorJson(c, new AppError({ code: "validation", message: "Send the request as application/json." }));
    }
    let raw: unknown;
    try {
      raw = await readStrictManagementBody(c.req.raw);
    } catch {
      return errorJson(c, new AppError({ code: "validation", message: "The request body is not valid JSON." }));
    }
    const body = createBody.safeParse(raw);
    if (!body.success) return errorJson(c, new AppError({ code: "validation", message: "Check the label, scopes, and expiry." }));
    noStore(c);
    const result = createApiKey(c.get("user").id, {
      label: body.data.label,
      scopes: body.data.scopes as ApiScope[],
      expiresAt: body.data.expiresAt,
    });
    return c.json(result, 201);
  })
  // Static paths come before `/api-keys/:id`, or they would be shadowed.
  .get("/api-keys/usage", (c) => {
    const limited = rateLimited(c);
    if (limited) return limited;
    if (hasRequestBody(c)) return errorJson(c, new AppError({ code: "validation", message: "This request takes no body." }));
    const userId = c.get("user").id;
    const days = Number(c.req.query("days") ?? 30) as ApiUsageDays;
    if (![1, 7, 30, 90].includes(days)) return errorJson(c, new AppError({ code: "validation", message: "Choose a range of 1, 7, 30, or 90 days." }));
    const groupBy = (c.req.query("groupBy") ?? "day") as ApiUsageResponse["groupBy"];
    if (groupBy !== "day" && groupBy !== "model" && groupBy !== "key") return errorJson(c, new AppError({ code: "validation", message: "Choose a grouping of day, model, or key." }));
    const keyId = c.req.query("keyId");
    if (keyId && !getApiKey(userId, keyId)) return errorJson(c, new AppError({ code: "not_found", message: "API key not found." }));
    noStore(c);
    return c.json(apiUsage(userId, { days, groupBy, ...(keyId ? { keyId } : {}) }));
  })
  .get("/api-keys/requests", (c) => {
    const limited = rateLimited(c);
    if (limited) return limited;
    if (hasRequestBody(c)) return errorJson(c, new AppError({ code: "validation", message: "This request takes no body." }));
    const userId = c.get("user").id;
    const limit = Number(c.req.query("limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return errorJson(c, new AppError({ code: "validation", message: "Choose a limit between 1 and 100." }));
    const keyId = c.req.query("keyId");
    if (keyId && !getApiKey(userId, keyId)) return errorJson(c, new AppError({ code: "not_found", message: "API key not found." }));
    const before = c.req.query("before");
    if (before !== undefined && !decodeRequestCursor(before)) return errorJson(c, new AppError({ code: "validation", message: "Invalid cursor." }));
    noStore(c);
    return c.json(apiRequestsPage(userId, { limit, ...(keyId ? { keyId } : {}), ...(before ? { before } : {}) }));
  })
  .get("/api-keys/audit", (c) => {
    const limited = rateLimited(c);
    if (limited) return limited;
    if (hasRequestBody(c)) return errorJson(c, new AppError({ code: "validation", message: "This request takes no body." }));
    const userId = c.get("user").id;
    const limit = Number(c.req.query("limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return errorJson(c, new AppError({ code: "validation", message: "Choose a limit between 1 and 100." }));
    const before = c.req.query("before");
    if (before !== undefined && !/^\d+$/.test(before)) return errorJson(c, new AppError({ code: "validation", message: "Invalid cursor." }));
    noStore(c);
    return c.json(apiAuditPage(userId, { limit, ...(before ? { before: Number(before) } : {}) }));
  })
  .delete("/api-keys/:id", (c) => {
    const limited = mutateLimited(c);
    if (limited) return limited;
    if (hasRequestBody(c)) return errorJson(c, new AppError({ code: "validation", message: "This request takes no body." }));
    noStore(c);
    const key = revokeApiKey(c.get("user").id, c.req.param("id"));
    if (!key) return errorJson(c, new AppError({ code: "not_found", message: "API key not found." }));
    return c.json({ key });
  });

// Inference ---------------------------------------------------------------------------------------------

const ADMISSION_TIMEOUT = Symbol("admission-timeout");

function supportedEffort(info: ModelInfo, effort: ReasoningEffort): boolean {
  if (!info.reasoning) return false;
  if (info.reasoningEfforts) return info.reasoningEfforts.includes(effort);
  // The existing createModel effort-budget fallback covers Anthropic only; other formats advertise nothing.
  return info.format === "anthropic";
}

function connectionFingerprint(conn: Connection): string {
  return [conn.providerId, conn.enabled ? "1" : "0", conn.shared ? "s" : "o", conn.baseURL ?? "", conn.apiKey ?? ""].join("\u0000");
}

interface Resolved {
  model: ModelInfo;
  conn: Connection;
  policy: ReturnType<typeof assertModelAllowed>;
}

async function resolveForApi(userId: string, ref: string, signal: AbortSignal): Promise<Resolved> {
  if (ref.startsWith("n8n/") || ref.slice(0, ref.indexOf("/")) === "chatgpt") {
    throw apiFailure(404, "invalid_request_error", "model_not_found", "That model is not available through this API.");
  }
  if (!apiAccessEnabled(userId)) throw permissionDenied("Your administrator has disabled external API access.");
  if (!apiModelAllowed(userId, ref)) throw permissionDenied();
  const policy = assertModelAllowed(userId, ref);
  // resolveModel already rechecks model policy and shared entitlements; map its authored failures at the boundary.
  const resolved = await resolveModel(userId, ref);
  if (!apiEligible(resolved.model)) throw apiFailure(404, "invalid_request_error", "model_not_found", "That model is not available through this API.");
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  return { ...resolved, policy };
}

function outputCeiling(request: { max_tokens?: number; max_completion_tokens?: number }, model: ModelInfo, policy: ReturnType<typeof assertModelAllowed>): number {
  const requested = request.max_completion_tokens ?? request.max_tokens ?? API_LIMITS.defaultOutputTokens;
  return Math.floor(
    Math.min(
      requested,
      model.maxOutput > 0 ? model.maxOutput : API_LIMITS.maxOutputTokens,
      policy.limits.outputTokens ?? Number.POSITIVE_INFINITY,
      API_LIMITS.maxOutputTokens,
    ),
  );
}

/** Builds the system blocks and client conversation, then rejects an over-context estimate. */
function buildMessages(userId: string, model: ModelInfo, body: ReturnType<typeof parseChatRequest>, ceiling: number, policy: ReturnType<typeof assertModelAllowed>) {
  let admin = "";
  try {
    admin = resolvePrompt("apiSystem", { userId, modelRef: model.ref });
  } catch {
    throw invalidPolicy();
  }
  if (Buffer.byteLength(admin, "utf8") > 65_536) throw invalidPolicy();
  const systemBlocks = [admin, ...body.messages.filter((message) => message.role === "system").map((message) => message.content)].filter((text) => text.trim());
  const conversation = body.messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role, content: message.content }));
  const context = Math.min(model.context, policy.limits.contextTokens ?? Number.POSITIVE_INFINITY);
  const estimate = estimateTokens({ prompt: [...systemBlocks.map((content) => ({ role: "system", content })), ...conversation] });
  if (estimate + ceiling + API_LIMITS.contextSafetyTokens > context) {
    throw contextLengthExceeded();
  }
  return { systemBlocks, conversation };
}

export const inferenceRoutes = new Hono<ApiEnv>()
  .use("*", apiContext)
  .use("*", apiGate)
  .use("*", async (c, next) => {
    const path = apiPath(c);
    // Hono dispatches HEAD as GET while `c.req.method` stays HEAD; the contract fixes the method.
    if (c.req.method === "HEAD" && (path === "/models" || path === "/chat/completions")) {
      return methodResponse(c, path === "/models" ? "GET" : "POST");
    }
    return next();
  })
  // Authentication is bound to the matched routes, not to a path comparison, so no spelling of a path
  // that the router accepts (percent-encoded segments included) can reach a handler without a principal.
  .get("/models", apiAuth, async (c) => {
    const requestId = c.get("apiRequestId");
    const principal = c.get("apiPrincipal");
    if (new URL(c.req.url).search) {
      return sendApiError(c, apiFailure(400, "invalid_request_error", "invalid_request", "Query parameters are not supported."), requestId);
    }
    if (hasRequestBody(c)) {
      await c.req.raw.body?.cancel().catch(() => {});
      return sendApiError(c, apiFailure(400, "invalid_request_error", "invalid_request", "This request takes no body."), requestId);
    }
    if (!hasScope(principal, "models:read")) {
      return sendApiError(c, apiFailure(403, "permission_error", "insufficient_scope", "This key cannot list models."), requestId);
    }
    if (!apiAccessEnabled(principal.userId)) return sendApiError(c, permissionDenied("Your administrator has disabled external API access."), requestId);
    const release = admitCatalogCall();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(apiFailure(504, "server_error", "timeout", "The model catalog took too long to respond.")), API_LIMITS.catalogDurationMs);
      deadline.unref?.();
    });
    try {
      const models = await Promise.race([listModels(principal.userId), timeout]);
      const eligible = [...new Set(models.filter(apiEligible).filter((model) => apiModelAllowed(principal.userId, model.ref)).map((model) => model.ref))].sort();
      if (eligible.length > 10_000) return sendApiError(c, apiFailure(503, "server_error", "catalog_limit", "The model catalog is too large to list."), requestId);
      if (!principalAlive(principal) || !apiAccessEnabled(principal.userId)) return sendApiError(c, liveDenialFailure(), requestId);
      const body: ModelList = {
        object: "list",
        data: eligible.map((ref) => ({ id: ref, object: "model" as const, created: 0 as const, owned_by: ref.slice(0, ref.indexOf("/")) })),
      };
      const serialized = JSON.stringify(body);
      if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024) return sendApiError(c, apiFailure(503, "server_error", "catalog_limit", "The model catalog is too large to list."), requestId);
      return new Response(serialized, { status: 200, headers: { ...apiHeaders(requestId), "Content-Type": "application/json; charset=utf-8" } });
    } catch (error) {
      return sendApiError(c, describeApiFailure(error), requestId);
    } finally {
      clearTimeout(deadline);
      release();
    }
  })
  .post("/chat/completions", apiAuth, async (c) => {
    const requestId = c.get("apiRequestId");
    const principal = c.get("apiPrincipal");
    if (new URL(c.req.url).search) {
      return sendApiError(c, apiFailure(400, "invalid_request_error", "invalid_request", "Query parameters are not supported."), requestId);
    }
    if (!hasScope(principal, "chat:write")) {
      return sendApiError(c, apiFailure(403, "permission_error", "insufficient_scope", "This key cannot create completions."), requestId);
    }
    if (!apiAccessEnabled(principal.userId)) return sendApiError(c, permissionDenied("Your administrator has disabled external API access."), requestId);
    if (!acceptsJson(c.req.header("content-type"))) {
      return sendApiError(c, apiFailure(415, "invalid_request_error", "unsupported_media_type", "Use Content-Type: application/json."), requestId);
    }
    if (hasUnsupportedEncoding(c.req.header("content-encoding"))) {
      return sendApiError(c, apiFailure(415, "invalid_request_error", "unsupported_media_type", "Content encoding is not supported."), requestId);
    }
    const declared = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > API_LIMITS.bodyBytes) {
      await c.req.raw.body?.cancel().catch(() => {});
      return sendApiError(c, apiFailure(413, "invalid_request_error", "request_too_large", "The request body is too large."), requestId);
    }
    const admittedAt = Date.now();
    let receiptOpened = false;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(apiFailure(504, "server_error", "timeout", "The request took too long.")), API_LIMITS.durationMs);
    timer.unref?.();
    const clientSignal = c.req.raw.signal;
    const signal = AbortSignal.any([deadline.signal, clientSignal]);
    try {
      const text = await readBoundedBody(c.req.raw, { maxBytes: API_LIMITS.bodyBytes, idleMs: 10_000, totalMs: 15_000 }, signal);
      const body = parseChatRequest(text);
      const resolved = await resolveForApi(principal.userId, body.model, signal);
      const { model, conn } = resolved;
      const ceiling = outputCeiling(body, model, resolved.policy);
      if (body.temperature !== undefined) {
        if (!model.temperature) throw unsupportedParameter("This model does not accept temperature.", "temperature");
        if (model.reasoning && body.reasoning_effort !== "none") {
          throw unsupportedParameter("This reasoning model does not accept temperature.", "temperature");
        }
      }
      const effort = body.reasoning_effort;
      if (effort !== undefined && !supportedEffort(model, effort)) {
        throw unsupportedParameter("This model does not support that reasoning effort.", "reasoning_effort");
      }
      const { systemBlocks, conversation } = buildMessages(principal.userId, model, body, ceiling, resolved.policy);
      pruneApiTelemetry(principal.userId, admittedAt);
      const admission = admitApiCall(principal.userId, principal.keyId, model.ref);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        admission.release();
      };
      // Nothing after this point may throw before the receipt exists without releasing the slot.
      try {
        openApiRequest({ id: requestId, userId: principal.userId, keyId: principal.keyId, modelRef: model.ref, stream: body.stream === true, now: admittedAt });
        receiptOpened = true;
      } catch (error) {
        release();
        return sendApiError(c, describeApiFailure(error), requestId);
      }
      const fingerprint = connectionFingerprint(conn);
      const recheck = () => {
        if (!principalAlive(principal)) throw liveDenial();
        if (!apiAccessEnabled(principal.userId) || !apiModelAllowed(principal.userId, model.ref)) throw liveDenial();
        assertModelAllowed(principal.userId, model.ref);
        const live = getConnection(principal.userId, conn.providerId);
        if (!live || !live.enabled || connectionFingerprint(live) !== fingerprint) throw liveDenial();
      };
      try {
        let handle: ReturnType<typeof createModel>;
        try {
          handle = createModel(model, conn, {
            userId: principal.userId,
            effort,
            guard: recheck,
            responseBounds: { maxBytes: API_LIMITS.providerBytes, maxRecordBytes: API_LIMITS.providerRecordBytes },
          });
        } catch (error) {
          const failure = describeApiFailure(error, { abortedByClient: clientSignal.aborted });
          settleFailed(requestId, principal, model, failure.status, failure.code);
          release();
          return sendApiError(c, failure, requestId);
        }
        const messages = handle.markCache(systemBlocks, conversation);
        markApiDispatched(requestId, principal.userId, Date.now());
        // The generation owns the slot and deadline until its body ends or its receipt settles.
        return await generateCompletion({
          userId: principal.userId,
          keyId: principal.keyId,
          requestId,
          admittedAt,
          model,
          conn,
          handle,
          messages,
          maxOutputTokens: ceiling,
          ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
          stream: body.stream === true,
          includeUsage: body.stream_options?.include_usage === true,
          signal,
          recheck,
          heartbeat: admission.heartbeat,
          onDone: release,
        });
      } catch (error) {
        // A synchronous failure after the receipt exists still settles honestly and frees the slot.
        const failure = describeApiFailure(error, { abortedByClient: clientSignal.aborted });
        settleFailed(requestId, principal, model, failure.status, failure.code);
        release();
        throw error;
      }
    } catch (error) {
      const failure = describeApiFailure(error, { abortedByClient: clientSignal.aborted });
      return sendApiError(c, failure, requestId);
    } finally {
      // A failure before a receipt was opened has no generation to own the deadline.
      if (!receiptOpened) clearTimeout(timer);
    }
  })
  .all("*", (c) => {
    const requestId = c.get("apiRequestId");
    const path = apiPath(c);
    if (path === "/models") return sendApiError(c, methodNotAllowed("GET"), requestId);
    if (path === "/chat/completions") return sendApiError(c, methodNotAllowed("POST"), requestId);
    return sendApiError(c, notFound(), requestId);
  })
  .onError((error, c) => {
    const requestId = c.get("apiRequestId") ?? newId("areq");
    return sendApiError(c, describeApiFailure(error), requestId);
  });

const liveDenialFailure = () => permissionDenied("This API credential is no longer active.");

/** A bodyless 405 for HEAD, which Hono would otherwise route to the GET handler. */
function methodResponse(c: Context, allow: string): Response {
  return new Response(null, {
    status: 405,
    headers: { ...apiHeaders(c.get("apiRequestId")), Allow: allow, "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Session routes are exported separately so `routes.ts` can mount them behind `requireUser`. */
export { authenticateApiToken, chargeApiRate, abortApiCalls, validApiModel, protocolError };
