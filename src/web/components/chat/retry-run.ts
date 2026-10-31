/**
 * What "Retry with…" is allowed to answer and with which model. Kept apart from the component so the
 * gating (assistant messages only, a real parent, a model, no cached or running history) is testable.
 */
export interface RetryRun {
  parentId: string;
  modelRef: string;
}

export function retryRun(
  message: { role: string; parentId: string | null },
  modelRef: string | null | undefined,
  blocked: boolean,
): RetryRun | null {
  if (blocked || message.role !== "assistant" || !message.parentId || !modelRef) return null;
  return { parentId: message.parentId, modelRef };
}
