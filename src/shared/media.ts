/** Small canonical file-part patches returned after saving a message; never echo inline file bytes. */
export type ImagePartUpdate = { index: number; part: Record<string, unknown> };

export function imagePartUpdates(content: unknown): ImagePartUpdate[] {
  const parts = (content as { parts?: unknown[] } | null)?.parts;
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((value, index) => {
    const part = value as Record<string, unknown> | null;
    return part?.type === "file" && typeof part.url === "string" && part.url.startsWith("okaychat-upload:")
      ? [{ index, part }] : [];
  });
}

export function applyImagePartUpdates(content: unknown, updates: ImagePartUpdate[]): unknown {
  const message = content as { parts?: unknown[] } | null;
  if (!Array.isArray(message?.parts) || !updates.length) return content;
  const parts = [...message.parts];
  for (const { index, part } of updates) {
    if ((parts[index] as { type?: string } | undefined)?.type === "file") parts[index] = part;
  }
  return { ...message, parts };
}
