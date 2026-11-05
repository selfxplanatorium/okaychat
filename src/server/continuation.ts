import { CONTINUE_TEXT } from "../shared/generation.js";
import { canContinue } from "../shared/generation.js";
import type { UIMessage } from "ai";
import { db } from "./db.js";
import { AppError } from "./errors.js";
import { projectGenerationMetadata } from "./generation-runs.js";

/**
 * Admission guards for an explicit continuation. A Continue request is an ordinary visible user turn,
 * but the server verifies the target is a trustworthy length-limited reply with no competing child, so
 * a forged request cannot attach a new answer to an arbitrary old message.
 */

export interface ContinuationRequest {
  targetMessageId: string;
  requestMessageId: string;
}

const textOf = (content: unknown): string => {
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .flatMap((part) => {
      const p = part as { type?: unknown; text?: unknown };
      return p.type === "text" && typeof p.text === "string" ? [p.text] : [];
    })
    .join("");
};

const unresolvedTool = (content: unknown): boolean => {
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return false;
  const settled = new Set(["output-available", "output-error", "output-denied"]);
  return parts.some((part) => {
    const p = part as { type?: unknown; state?: unknown };
    return typeof p.type === "string" && p.type.startsWith("tool-") && !settled.has(String(p.state));
  });
};

/** The visible continuation message is exactly the fixed text, with no attachments or hidden parts. */
export function isContinuationMessage(message: UIMessage): boolean {
  if (message.role !== "user" || message.parts.length !== 1) return false;
  const part = message.parts[0]!;
  return part.type === "text" && part.text === CONTINUE_TEXT;
}

/** Validates a stored thread's target and this request before any provider request begins. */
export function assertContinuation(userId: string, threadId: string, request: ContinuationRequest, messages: UIMessage[]): void {
  const own = db.prepare("SELECT 1 FROM threads WHERE id = ? AND user_id = ?").get(threadId, userId);
  if (!own) throw new AppError({ code: "not_found", message: "Thread not found." });
  const targetRow = db
    .prepare("SELECT content, parent_id, edited_at, original_enc FROM messages WHERE thread_id = ? AND id = ?")
    .get(threadId, request.targetMessageId) as { content: string; parent_id: string | null; edited_at: number | null; original_enc: string | null } | undefined;
  if (!targetRow) throw new AppError({ code: "not_found", message: "The answer to continue is no longer in this chat." });
  const content = JSON.parse(targetRow.content) as { role?: unknown; parts?: unknown };
  if (content.role !== "assistant") throw new AppError({ code: "validation", message: "Only an assistant answer can be continued." });
  if (targetRow.edited_at !== null || targetRow.original_enc !== null) {
    throw new AppError({ code: "validation", message: "This answer was edited, so its cutoff is no longer trustworthy. Write a new message instead." });
  }
  if (!textOf(content).trim()) throw new AppError({ code: "validation", message: "There is no text to continue." });
  if (unresolvedTool(content)) throw new AppError({ code: "validation", message: "This answer is still waiting for a tool. Finish or stop it first." });
  const receipt = projectGenerationMetadata(threadId, request.targetMessageId);
  if (!receipt) throw new AppError({ code: "validation", message: "This answer has no recorded cutoff, so it cannot be continued automatically." });
  // A concurrent Continue starts its receipt before this one checks: answer with a conflict, not a
  // claim that the answer never had a length cutoff.
  if (receipt.state === "running" || receipt.state === "waiting") {
    throw new AppError({ code: "conflict", message: "This answer is already being continued. Reload the chat to see the newer reply." });
  }
  if (!canContinue(receipt)) throw new AppError({ code: "validation", message: "This answer did not stop at its output limit, so there is nothing to continue." });

  const requestMessage = messages.findLast((message) => message.role === "user");
  if (!requestMessage || requestMessage.id !== request.requestMessageId) {
    throw new AppError({ code: "validation", message: "The continuation request did not match the visible message." });
  }
  if (!isContinuationMessage(requestMessage)) {
    throw new AppError({ code: "validation", message: "The continuation message changed before it was sent. Try again." });
  }
  // A different persisted child means this answer already continued; the click is stale.
  const otherChild = db
    .prepare("SELECT 1 FROM messages WHERE thread_id = ? AND parent_id = ? AND id <> ? LIMIT 1")
    .get(threadId, request.targetMessageId, request.requestMessageId);
  if (otherChild) throw new AppError({ code: "conflict", message: "This answer was already continued. Reload the chat to see the newer reply." });
}

/** True when the SQL unique index would reject a second Continue receipt for the same request turn. */
export const isContinueConflict = (error: unknown): boolean => /UNIQUE constraint failed/i.test(String((error as Error)?.message ?? error));
