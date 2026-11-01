interface TranscriptMessage {
  role: string;
  metadata?: { modality?: string };
}

/** Local replies use the normal chat pipeline, which need not copy the user's voice metadata. */
export function isSpokenMessage(messages: readonly TranscriptMessage[], index: number): boolean {
  const message = messages[index];
  if (!message) return false;
  if (message.metadata?.modality === "voice") return true;
  if (message.role !== "assistant") return false;
  let userIndex = index - 1;
  while (messages[userIndex]?.role === "assistant") userIndex--;
  return messages[userIndex]?.role === "user" && messages[userIndex]?.metadata?.modality === "voice";
}
