// Pure helpers for the message layout flags. Both layouts render the same attributes; only the
// stylesheet (theme/messages.css) branches on html[data-message-layout], so a switch is a style recalc.

export type MessageRun = "single" | "start" | "middle" | "end";

const RUN_ROLES: ReadonlySet<string> = new Set(["user", "assistant"]);

/** Same-role adjacency in the displayed branch. Unknown index or role -> "single". */
export function messageRunAt(messages: readonly { role: string }[], index: number): MessageRun {
  const role = messages[index]?.role;
  if (!role || !RUN_ROLES.has(role)) return "single";
  const before = messages[index - 1]?.role === role;
  const after = messages[index + 1]?.role === role;
  if (before && after) return "middle";
  if (before) return "end";
  if (after) return "start";
  return "single";
}

export type BubbleShape = { wide: boolean; empty: boolean };

/** Tools that are one collapsed work-log row, never a card. */
const COMPACT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "web_search", "web_fetch", "read_knowledge_chunk", "view_artifact",
  "mcp_list_resources", "mcp_read_resource",
]);

const WIDE_PART_TYPES: ReadonlySet<string> = new Set(["file", "image", "data"]);

/**
 * Cards, media, files and an interrupted reply use the whole lane, so nothing inside is squeezed.
 * An unknown tool counts as wide for the same reason.
 */
export function assistantBubbleShape(
  parts: readonly { type: string; toolName?: string }[],
  status: string | undefined,
): BubbleShape {
  const wide = status === "incomplete" || parts.some((part) =>
    WIDE_PART_TYPES.has(part.type)
    || part.type.startsWith("data-")
    || (part.type === "tool-call" && !COMPACT_TOOL_NAMES.has(part.toolName ?? "")),
  );
  const empty = parts.length === 0 && (status === undefined || status === "complete");
  return { wide, empty };
}
