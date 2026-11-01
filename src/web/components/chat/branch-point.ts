/** Assistant forks preserve their reply; user forks answer the copied user message. */
export function branchPoint(message: { id: string; role: string }) {
  if (message.role !== "user" && message.role !== "assistant") return null;
  return { messageId: message.id, run: message.role === "user" };
}
