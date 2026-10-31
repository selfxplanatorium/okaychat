import type { UIMessage } from "ai";
import { promptText } from "../prompts.js";

// A user message spoken in a local-engine call carries `voiceCall: "local"` in its metadata (assistant-ui nests
// it under `custom`). The model gets a short note beside that message, never in the system prefix, so a call
// does not change the cached prefix of the chat. The note follows from stored metadata, so every later request
// replays the same bytes.

export function isVoiceTurn(message: UIMessage): boolean {
  const metadata = message.metadata as { voiceCall?: unknown; custom?: { voiceCall?: unknown } } | undefined;
  return message.role === "user" && (metadata?.voiceCall === "local" || metadata?.custom?.voiceCall === "local");
}

/** Adds the voice-call note to the per-turn block of every spoken user message. */
export function withVoiceNotes(messages: UIMessage[], contexts: Map<string, string>): Map<string, string> {
  const spoken = messages.filter(isVoiceTurn);
  if (!spoken.length) return contexts;
  const note = promptText("voiceCall");
  const out = new Map(contexts);
  for (const message of spoken) out.set(message.id, [contexts.get(message.id), note].filter(Boolean).join("\n\n"));
  return out;
}
