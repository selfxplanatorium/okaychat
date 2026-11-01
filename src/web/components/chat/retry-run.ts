/**
 * What "Retry with…" is allowed to answer and with which model. Kept apart from the component so the
 * gating (user or assistant messages, a real parent, a model, no cached or running history) is testable.
 */
export interface RetryRun {
  parentId: string;
  modelRef: string;
}

export function retryParentId(message: { id?: string; role: string; parentId: string | null }): string | null {
  if (message.role === "user") return message.id ?? null;
  return message.role === "assistant" ? message.parentId : null;
}

export function retryRun(
  message: { id?: string; role: string; parentId: string | null },
  modelRef: string | null | undefined,
  blocked: boolean,
): RetryRun | null {
  const parentId = retryParentId(message);
  if (blocked || !parentId || !modelRef) return null;
  return { parentId, modelRef };
}
