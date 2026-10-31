import { spokenText } from "../text";

// Streaming text → sentences for speech synthesis. A sentence is only sent once the character after its
// punctuation has arrived, because a later delta may still change its ending. Code fences are followed so a
// ``` inside a fenced block never starts a new sentence.

/** Characters that end a spoken sentence in the scripts okaychat supports. */
const TERMINATORS = new Set([".", "!", "?", "…", "。", "！", "？"]);
/** No single synthesis request grows past this, even without punctuation. */
export const MAX_CHUNK = 600;
/** Force a cut here when speech has not paused for a long time. */
const SOFT_CHUNK = 420;

interface Cut {
  at: number;
  /** True when the character at `at` is a blank we already consumed. */
  blank: boolean;
}

/** The first safe sentence boundary outside a fenced code block, or null while more text is needed. */
function findCut(text: string): Cut | null {
  let fence = false;
  let lineStart = true;
  let lastSpace = -1;
  // Fenced spans as [start, end); end is Infinity while the fence is still open.
  const fences: { start: number; end: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    // A fence opens or closes only at the start of a line, after optional spaces.
    if (lineStart && char === " " ) continue;
    if (lineStart && char === "`" && text.slice(i, i + 3) === "```") {
      // Wait for the newline after the marker; the marker itself is safe to leave in the buffer.
      const end = text.indexOf("\n", i);
      if (end < 0) return null;
      if (fence) fences[fences.length - 1]!.end = end + 1;
      else fences.push({ start: i, end: Infinity });
      fence = !fence;
      i = end;
      lineStart = true;
      continue;
    }
    lineStart = char === "\n";
    if (fence) continue;
    if (char === "\n" && text[i + 1] === "\n") return { at: i + 2, blank: true };
    if (char === " " || char === "\t" || char === "\n") {
      lastSpace = i;
      continue;
    }
    if (TERMINATORS.has(char)) {
      const next = text[i + 1];
      // A terminator followed by whitespace is final; at the end of the stream it may still gain a digit
      // ("3." → "3.14"), so wait for the next delta.
      if (next !== undefined && /\s/.test(next)) return { at: i + 2, blank: true };
    }
  }
  if (text.length > MAX_CHUNK) {
    // Cut before the hard cap, at a word boundary where possible.
    const space = text.lastIndexOf(" ", MAX_CHUNK);
    let at = space > SOFT_CHUNK ? space : SOFT_CHUNK;
    // Never split a fence: spokenText can only drop code it sees whole. Cut before it, or after it,
    // or wait for an open fence at the start of the buffer to close.
    const inside = fences.find((f) => at > f.start && at < f.end);
    if (inside) {
      if (inside.start > 0) at = inside.start;
      else if (inside.end !== Infinity) at = inside.end;
      else return null;
    }
    return { at, blank: false };
  }
  return null;
}

export class SentenceChunker {
  private buffer = "";
  /** Characters already cut, for callers that need to know the reply's progress. */
  emitted = 0;

  /** Adds the next streamed delta and returns every sentence that is now safe to speak. */
  push(delta: string): string[] {
    if (!delta) return [];
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      const cut = findCut(this.buffer);
      if (!cut) break;
      const piece = this.buffer.slice(0, cut.at);
      this.buffer = this.buffer.slice(cut.at);
      this.emitted += cut.at;
      const text = spokenText(piece).trim();
      // Keep a code block's marker so the listener knows something was omitted, but drop pure whitespace.
      if (text) out.push(text);
      if (this.buffer.length > MAX_CHUNK * 2) break;
    }
    return out;
  }

  /** The end of the reply: everything left is final. */
  flush(): string[] {
    const text = spokenText(this.buffer).trim();
    this.emitted += this.buffer.length;
    this.buffer = "";
    return text ? [text] : [];
  }

  /** The raw text that has not been spoken yet. */
  get pending() {
    return this.buffer;
  }

  reset() {
    this.buffer = "";
    this.emitted = 0;
  }
}
