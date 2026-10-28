import type { TtsSplit } from "@shared/speech";

/** Reads the answer, not its Markdown: code blocks, tables, link targets, and formatting marks are dropped. */
export function spokenText(markdown: string): string {
  return markdown
    .replace(/<details[\s\S]*?<\/details>/gi, " ")
    .replace(/```[\s\S]*?```/g, "\n(code omitted)\n")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/\$\$[\s\S]*?\$\$/g, " (formula) ")
    .replace(/\$[^$\n]+\$/g, " (formula) ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_`~|]/g, "")
    .replace(/\[\^?\d+\]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Pieces shorter than this join the previous one, so a reply does not turn into many tiny requests.
const MIN_CHARS = 50;
const MIN_WORDS = 4;
/** Stays below every engine's per-request limit (OpenAI: 4096 characters). */
export const MAX_PIECE = 1500;

/** Splits text for read aloud. Smaller pieces start playing sooner; each piece is one synthesis request. */
export function splitForSpeech(text: string, mode: TtsSplit): string[] {
  const raw =
    mode === "none"
      ? [text]
      : mode === "paragraph"
        ? text.split(/\n+/)
        : text.split(/(?<=[.!?…。！？])\s+|\n+/);
  const merged: string[] = [];
  for (const piece of raw.map((p) => p.trim()).filter(Boolean)) {
    const last = merged.at(-1);
    const short = (s: string) => s.length < MIN_CHARS || s.split(/\s+/).length < MIN_WORDS;
    if (last !== undefined && mode === "sentence" && short(last) && last.length + piece.length < MAX_PIECE) merged[merged.length - 1] = `${last} ${piece}`;
    else merged.push(piece);
  }
  return merged.flatMap((p) => cut(p, MAX_PIECE));
}

/** Breaks an overlong piece at the last space before the limit. */
function cut(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const at = rest.lastIndexOf(" ", max);
    const end = at > max / 2 ? at : max;
    out.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) out.push(rest);
  return out;
}
