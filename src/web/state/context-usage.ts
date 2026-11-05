import type { AssistantMetadata, CompactionState } from "../../shared/types";

interface ContextMessage {
  id: string;
  role: string;
  metadata: unknown;
}

export const metadataOf = (metadata: unknown): AssistantMetadata =>
  ((metadata as { custom?: AssistantMetadata } | undefined)?.custom ?? {}) as AssistantMetadata;

/** An agent reply reports no tokens, so the meter must not fall back to an older LLM measurement. */
export type ContextUsage = { tokens: number; window: number } | { unmanaged: "agent" } | null;

/** A trim supersedes earlier provider counts until a later assistant reply reports usage. */
export function contextUsage(messages: readonly ContextMessage[], compaction: CompactionState | null): ContextUsage {
  // The newest reply decides the mode: after an agent answer the chat has no managed context at all.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    if (metadataOf(message.metadata).usageMode === "agent") return { unmanaged: "agent" };
    break;
  }

  let latest: AssistantMetadata | null = null;
  let latestIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const meta = metadataOf(message.metadata);
    if (message.role === "assistant" && meta.contextTokens) {
      latest = meta;
      latestIndex = i;
      break;
    }
  }

  const trim = compaction?.trim;
  if (trim) {
    const summaryIndex = compaction.summary ? messages.findIndex((m) => m.id === compaction.boundaryMessageId) : -1;
    const throughIndex = messages.findIndex((m) => m.id === trim.throughMessageId);
    const lastIndex = messages.findIndex((m) => m.id === trim.lastMessageId);
    // Both boundaries must still belong to this branch, beyond any summarized history.
    if (throughIndex > summaryIndex && lastIndex >= throughIndex && latestIndex <= lastIndex) {
      return { tokens: trim.tokensAfter, window: latest?.contextWindow ?? 0 };
    }
  }
  return latest ? { tokens: latest.contextTokens!, window: latest.contextWindow ?? 0 } : null;
}
