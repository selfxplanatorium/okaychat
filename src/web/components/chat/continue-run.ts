import type { useAui } from "@assistant-ui/react";
import { CONTINUE_TEXT, canContinue, everEditedOf, generationOf, type GenerationSummary } from "@shared/generation";
import { storedMessageExists } from "@/runtime/message-persistence";

type Aui = ReturnType<typeof useAui>;

/**
 * Pure gates and the single append path for explicit continuation. The server re-checks every condition;
 * these only decide whether to show the control, and explain why it is disabled.
 */

export interface ContinueGateInput {
  threadId: string | null;
  messageId: string;
  generation: GenerationSummary | undefined;
  /** Any tool part still running or waiting for approval/input blocks continuation. */
  unresolvedTools: boolean;
  isLatest: boolean;
  running: boolean;
  syncing: boolean;
  edited: boolean;
  everEdited: boolean;
  stored: boolean;
  hasText: boolean;
  temporary: boolean;
}

export type ContinueGate =
  | { eligible: true }
  | { eligible: false; reason?: "generation.syncRequired" | "generation.savingMessage" | "generation.editedTarget" | "generation.waitingTools" | "generation.targetChanged" };

/** Trusts only the server's receipt projection: no text heuristics and no local finish guess. */
export function continueGate(input: ContinueGateInput): ContinueGate {
  if (!input.threadId || input.temporary) return { eligible: false };
  if (!input.generation || !canContinue(input.generation)) return { eligible: false };
  if (input.edited || input.everEdited) return { eligible: false, reason: "generation.editedTarget" };
  if (input.unresolvedTools) return { eligible: false, reason: "generation.waitingTools" };
  if (!input.hasText) return { eligible: false };
  if (input.running) return { eligible: false };
  if (input.syncing) return { eligible: false, reason: "generation.syncRequired" };
  if (!input.stored || !storedMessageExists(input.threadId, input.messageId)) return { eligible: false, reason: "generation.savingMessage" };
  if (!input.isLatest) return { eligible: false };
  return { eligible: true };
}

/** A tool part that is not settled: streaming input, waiting for approval, or still executing. */
export const hasUnresolvedTools = (parts: ReadonlyArray<{ type: string; status?: { type?: string } }>): boolean =>
  parts.some((part) => part.type.startsWith("tool-") && (part.status?.type === "running" || part.status?.type === "requires-action"));

export interface ContinuationMetadata {
  custom: { continuation: { targetMessageId: string } };
}

/** Appends the visible continuation user turn, parented on the displayed leaf. */
export function appendContinuation(aui: Aui, targetMessageId: string): void {
  aui.thread.append({
    role: "user",
    parentId: targetMessageId,
    content: [{ type: "text", text: CONTINUE_TEXT }],
    metadata: { custom: { continuation: { targetMessageId } } },
    startRun: true,
  });
}

/** Reads the continuation intent the composer carries on the new user turn. */
export function continuationIntentOf(metadata: unknown): { targetMessageId: string } | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const custom = (metadata as { custom?: unknown }).custom;
  if (!custom || typeof custom !== "object") return undefined;
  const continuation = (custom as { continuation?: unknown }).continuation;
  if (!continuation || typeof continuation !== "object") return undefined;
  const target = (continuation as { targetMessageId?: unknown }).targetMessageId;
  return typeof target === "string" && target.length > 0 && target.length <= 200 ? { targetMessageId: target } : undefined;
}

/** The generation summary of a message's metadata and whether it was ever edited. */
export function generationInfo(metadata: unknown): { generation: GenerationSummary | undefined; everEdited: boolean } {
  return { generation: generationOf(metadata), everEdited: everEditedOf(metadata) };
}
