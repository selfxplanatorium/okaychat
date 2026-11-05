import type { AssistantMetadata, TokenUsage } from "./types.js";

/**
 * Generation receipts and explicit continuation. A reply may only be continued when the server
 * recorded a trustworthy terminal reason (`length`), so the client never infers a cutoff from text.
 */

export const FINISH_REASONS = ["stop", "length", "tool-calls", "content-filter", "error", "other", "unknown"] as const;
export type FinishReason = (typeof FINISH_REASONS)[number];

export const GENERATION_STATES = ["running", "waiting", "finished", "aborted", "error", "interrupted"] as const;
export type GenerationState = (typeof GENERATION_STATES)[number];

/** The visible text a Continue action appends as a normal user message. Never localized or hidden. */
export const CONTINUE_TEXT = "Continue from where the previous answer stopped. Do not repeat the existing answer.";

/** Safe display projection of one run's receipt; the full config stays server-side. */
export interface GenerationSummary {
  runId: string;
  state: GenerationState;
  finishReason: FinishReason | null;
  continuationOf?: string;
  usage?: TokenUsage;
  cost?: number;
  contextTokens?: number;
  durationMs?: number;
  assistantName?: string | null;
  assistantIcon?: string | null;
}

/** The eligible terminal combination: a finished reply the provider itself stopped for length. */
export const canContinue = (summary: GenerationSummary | undefined): boolean =>
  !!summary && summary.state === "finished" && summary.finishReason === "length";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads the generation summary from assistant metadata, wherever assistant-ui put it. */
export function generationOf(metadata: unknown): GenerationSummary | undefined {
  if (!isRecord(metadata)) return undefined;
  const custom = isRecord(metadata.custom) ? metadata.custom : undefined;
  const raw = custom?.generation ?? metadata.generation;
  if (!isRecord(raw) || typeof raw.runId !== "string") return undefined;
  if (!(GENERATION_STATES as readonly string[]).includes(String(raw.state))) return undefined;
  const finishReason = (FINISH_REASONS as readonly string[]).includes(String(raw.finishReason)) ? (raw.finishReason as FinishReason) : null;
  const continuationOf = typeof raw.continuationOf === "string" ? raw.continuationOf : undefined;
  const usage = isRecord(raw.usage) ? (raw.usage as unknown as TokenUsage) : undefined;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  return {
    runId: raw.runId,
    state: raw.state as GenerationState,
    finishReason,
    ...(continuationOf ? { continuationOf } : {}),
    ...(usage ? { usage } : {}),
    ...(number(raw.cost) !== undefined ? { cost: number(raw.cost) } : {}),
    ...(number(raw.contextTokens) !== undefined ? { contextTokens: number(raw.contextTokens) } : {}),
    ...(number(raw.durationMs) !== undefined ? { durationMs: number(raw.durationMs) } : {}),
    ...(typeof raw.assistantName === "string" || raw.assistantName === null ? { assistantName: raw.assistantName as string | null } : {}),
    ...(typeof raw.assistantIcon === "string" || raw.assistantIcon === null ? { assistantIcon: raw.assistantIcon as string | null } : {}),
  };
}

/** Adds a receipt projection to assistant metadata for the terminal chunk. */
export const withGeneration = (metadata: AssistantMetadata, generation: GenerationSummary): AssistantMetadata => ({ ...metadata, generation });

/** The explicit continuation request carried by the new user turn's config. */
export interface ContinuationRequest {
  targetMessageId: string;
  requestMessageId: string;
}

export function continuationOfConfig(config: unknown): ContinuationRequest | undefined {
  if (!isRecord(config)) return undefined;
  const continuation = config.continuation;
  if (!isRecord(continuation)) return undefined;
  const targetMessageId = continuation.targetMessageId;
  const requestMessageId = continuation.requestMessageId;
  if (typeof targetMessageId !== "string" || typeof requestMessageId !== "string") return undefined;
  if (!targetMessageId || !requestMessageId || targetMessageId.length > 200 || requestMessageId.length > 200) return undefined;
  return { targetMessageId, requestMessageId };
}

/** True when a reply was ever edited, even after Undo. */
export function everEditedOf(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  const custom = isRecord(metadata.custom) ? metadata.custom : undefined;
  return custom?.everEdited === true || metadata.everEdited === true;
}

/** A terminal receipt that cannot be continued even though it ended for length. */
export const isEditedTarget = (editedAt: number | null | undefined, everEdited: boolean): boolean => everEdited || editedAt != null;
