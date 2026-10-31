/**
 * Result identity for a tool card inside one finished reply. The latest email read per opaque
 * message id survives folding; each send or reply is its own outcome, because two sends of the same
 * message are two distinct actions.
 */
export function emailResultKey(toolName: string, toolCallId: string, args: unknown): string | undefined {
  if (toolName === "email_read") {
    const messageId = (args as { messageId?: unknown } | null | undefined)?.messageId;
    const accountId = (args as { accountId?: unknown } | null | undefined)?.accountId;
    return typeof messageId === "string" && messageId ? `email-read:${String(accountId ?? "default")}:${messageId}` : undefined;
  }
  if (toolName === "email_send" || toolName === "email_reply") return `${toolName}:${toolCallId}`;
  return undefined;
}
