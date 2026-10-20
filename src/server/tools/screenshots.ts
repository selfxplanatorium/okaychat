import type { FilePart, ModelMessage } from "ai";
import type { VisualShot } from "../documents/visual.js";

// A screenshot cannot ride inside a tool result across every provider: OpenAI-compatible chat APIs
// stringify tool content, and Responses/Anthropic shapes differ. Instead the tool returns text, and the
// image is appended once as a synthetic user message before the next model step. This works for every
// vision model and keeps the persisted history (and later turns) free of image tokens.

/** A reply may spend this many screenshots. Each one costs image tokens on top of the text. */
export const MAX_SHOTS_PER_TURN = 6;

const NOTE =
  "The view_artifact screenshots below show exactly what the user would see. Use them to judge layout, spacing, tables, clipping, and styling, then fix the artifact if needed. They are not a new user request, and they are not repeated in later turns.";

/**
 * Appends any not-yet-injected view_artifact screenshots as one user message. `injected` is per turn, so
 * a screenshot is sent once even though prepareStep runs before every step.
 */
export function injectScreenshots(messages: ModelMessage[], shots: Map<string, VisualShot>, injected: Set<string>): ModelMessage[] {
  const fresh: VisualShot[] = [];
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== "view_artifact" || injected.has(part.toolCallId)) continue;
      const shot = shots.get(part.toolCallId);
      if (!shot) continue; // From an earlier turn: the bytes are gone and the note in the tool output stands.
      injected.add(part.toolCallId);
      fresh.push(shot);
    }
  }
  if (!fresh.length) return messages;
  const content: Array<{ type: "text"; text: string } | FilePart> = [
    { type: "text", text: NOTE },
    // The SDK's current file part, rather than the deprecated image part; providers still receive an image.
    ...fresh.map((shot): FilePart => ({ type: "file", data: { type: "data", data: shot.png }, mediaType: "image/png" })),
  ];
  return [...messages, { role: "user", content }];
}
