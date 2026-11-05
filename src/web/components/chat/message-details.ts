// What a reply's stored metadata can say, shaped for the Details popover. Missing values stay missing: the
// popover says "Not reported" rather than inventing a zero. Money is the stored accounting estimate; this file
// never consults today's model catalog, so old replies keep the cost they were recorded with.

import type { AssistantMetadata } from "@shared/types";

export type DetailKey = "model" | "input" | "cacheRead" | "cacheWrite" | "output" | "reasoning" | "cost" | "duration";

export type DetailValue =
  | { kind: "text"; text: string }
  | { kind: "tokens"; value: number }
  | { kind: "cost"; value: number }
  | { kind: "seconds"; value: number };

export interface DetailRow {
  key: DetailKey;
  /** Null means the provider did not report it; the UI renders the Not reported text. */
  value: DetailValue | null;
}

/** True when the reply has anything worth opening. A bare model name with no accounting still counts. */
export function hasReplyDetails(meta: AssistantMetadata): boolean {
  return meta.modelRef !== undefined || meta.usage !== undefined || meta.cost !== undefined || meta.durationMs !== undefined;
}

/**
 * Every row is always present so the popover never changes shape. Token totals are the whole turn's reported
 * usage; the context meter keeps its own final-step estimate.
 */
export function replyDetailRows(meta: AssistantMetadata, modelName: string | undefined): DetailRow[] | null {
  if (!hasReplyDetails(meta)) return null;
  const usage = meta.usage;
  const model = modelName ?? meta.modelRef;
  return [
    { key: "model", value: model ? { kind: "text", text: model } : null },
    { key: "input", value: usage ? { kind: "tokens", value: usage.input } : null },
    { key: "cacheRead", value: usage ? { kind: "tokens", value: usage.cacheRead } : null },
    { key: "cacheWrite", value: usage ? { kind: "tokens", value: usage.cacheWrite } : null },
    { key: "output", value: usage ? { kind: "tokens", value: usage.output } : null },
    { key: "reasoning", value: usage ? { kind: "tokens", value: usage.reasoning } : null },
    { key: "cost", value: meta.cost === undefined ? null : { kind: "cost", value: meta.cost } },
    { key: "duration", value: meta.durationMs === undefined ? null : { kind: "seconds", value: meta.durationMs / 1000 } },
  ];
}

/** The compact footer line: only the values that exist, never placeholders for the missing ones. */
export function compactUsage(meta: AssistantMetadata): { usage: AssistantMetadata["usage"]; cost?: number; durationMs?: number } {
  return { usage: meta.usage, ...(meta.cost !== undefined && { cost: meta.cost }), ...(meta.durationMs !== undefined && { durationMs: meta.durationMs }) };
}
