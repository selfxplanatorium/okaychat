import type { UIMessageChunk } from "ai";
import { tx } from "../db.js";
import { assertStorage } from "../quota.js";
import { normalizeImages } from "./refs.js";

/** Persist provider image bytes before they reach the browser or resumable stream buffer. */
export function storedImageChunks(userId: string, threadId: string, describeError: (error: unknown) => string): TransformStream<UIMessageChunk, UIMessageChunk> {
  return new TransformStream({
    transform(chunk, controller) {
      if (threadId.startsWith("tmp_") || chunk.type !== "file" || !chunk.url.startsWith("data:image/")) {
        controller.enqueue(chunk);
        return;
      }
      try {
        const message = tx(() => normalizeImages(userId, threadId, { role: "assistant", parts: [chunk] }, {
          charge: (bytes) => assertStorage(userId, bytes),
        })) as { parts: Array<{ url: string; mediaType: string }> };
        const part = message.parts[0]!;
        controller.enqueue({ ...chunk, url: part.url, mediaType: part.mediaType });
      } catch (error) {
        // A storage error must be visible, and must not fall back to sending the oversized original.
        controller.enqueue({ type: "error", errorText: describeError(error) });
      }
    },
  });
}
