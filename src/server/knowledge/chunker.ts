import { createHash } from "node:crypto";

// Structure-aware chunking for knowledge sources. The layout follows headings, paragraphs, fenced code,
// and Markdown tables, then packs blocks up to a token target with a small overlap so a passage that
// spans a boundary is still retrievable from either side. Offsets are character positions in the exact
// extracted text, so a citation can show the real passage and a client slice matches the stored chunk.

/** Target chunk size in estimated tokens. Chunks land between roughly 700 and 900. */
export const TARGET_TOKENS = 800;
/** Rough English average. Code and CJK differ; this is a budget estimate, never a provider count. */
export const CHARS_PER_TOKEN = 4;
export const OVERLAP_RATIO = 0.12;
const MAX_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;

export interface RawChunk {
  /** Deterministic id from the source id, offsets, and content. */
  id: string;
  ordinal: number;
  title: string;
  start: number;
  end: number;
  text: string;
  tokens: number;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / CHARS_PER_TOKEN));
}

interface Line {
  start: number;
  end: number;
  text: string;
}

interface Block {
  start: number;
  end: number;
  kind: "heading" | "paragraph" | "code" | "table";
  title: string;
}

function lines(text: string): Line[] {
  const out: Line[] = [];
  let pos = 0;
  while (pos < text.length) {
    const newline = text.indexOf("\n", pos);
    const end = newline === -1 ? text.length : newline + 1;
    out.push({ start: pos, end, text: text.slice(pos, end) });
    pos = end;
  }
  return out;
}

const isBlank = (line: string) => !line.trim();
const fence = (line: string) => /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
const heading = (line: string) => /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)?.[2]?.trim();
const tableRow = (line: string) => /^\s*\|/.test(line);

/** Splits the document into structural blocks with absolute offsets. */
function blocks(text: string): Block[] {
  const rows = lines(text);
  const out: Block[] = [];
  let title = "";
  for (let i = 0; i < rows.length; ) {
    const row = rows[i]!;
    if (isBlank(row.text)) {
      i++;
      continue;
    }
    const headingText = heading(row.text);
    if (headingText !== undefined) {
      title = headingText;
      out.push({ start: row.start, end: row.end, kind: "heading", title });
      i++;
      continue;
    }
    const marker = fence(row.text);
    if (marker) {
      const close = new RegExp(`^\\s*${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      let j = i + 1;
      while (j < rows.length && !close.test(rows[j]!.text)) j++;
      const end = j < rows.length ? rows[j]!.end : text.length;
      out.push({ start: row.start, end, kind: "code", title });
      i = j < rows.length ? j + 1 : j;
      continue;
    }
    if (tableRow(row.text)) {
      let j = i + 1;
      while (j < rows.length && tableRow(rows[j]!.text)) j++;
      out.push({ start: row.start, end: rows[j - 1]!.end, kind: "table", title });
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < rows.length) {
      const next = rows[j]!;
      if (isBlank(next.text) || heading(next.text) !== undefined || fence(next.text) || tableRow(next.text)) break;
      j++;
    }
    out.push({ start: row.start, end: rows[j - 1]!.end, kind: "paragraph", title });
    i = j;
  }
  return out;
}

/** Splits an oversized block at line or sentence boundaries, then at whitespace as a last resort. */
function splitBlock(text: string, block: Block, bucket: Block[], ceiling: number): void {
  const body = text.slice(block.start, block.end);
  if (body.length <= ceiling) {
    bucket.push(block);
    return;
  }
  const separators = block.kind === "paragraph" ? /(?<=[.!?])\s+|\n{2,}/g : /\n/g;
  const cuts: number[] = [];
  for (const match of body.matchAll(separators)) cuts.push(match.index + match[0].length);
  let start = block.start;
  const push = (end: number) => {
    if (end <= start) return;
    bucket.push({ ...block, start, end });
    start = end;
  };
  for (const rel of cuts) {
    if (rel <= 0) continue;
    const absolute = block.start + rel;
    if (absolute - start >= ceiling) push(absolute);
  }
  // A single sentence or line longer than the ceiling: fall back to whitespace/character cuts.
  while (block.end - start > ceiling) {
    let cut = start + ceiling;
    const space = text.lastIndexOf(" ", cut);
    if (space > start + ceiling / 2) cut = space + 1;
    push(cut);
  }
  push(block.end);
}

interface Span {
  start: number;
  end: number;
  title: string;
}

/** Packs blocks into adjacent spans, merging a tiny tail into the previous span when it fits. */
function pack(text: string, ceiling: number): Span[] {
  const spans: Span[] = [];
  let current: Span | null = null;
  for (const block of blocks(text).flatMap((block) => {
    const bucket: Block[] = [];
    splitBlock(text, block, bucket, ceiling);
    return bucket;
  })) {
    const length = Math.max(0, block.end - block.start);
    if (!current) {
      current = { start: block.start, end: block.end, title: block.title };
      continue;
    }
    const gap = block.start >= current.end ? block.start - current.end : 0;
    if (current.end - current.start + gap + length > ceiling) {
      spans.push(current);
      current = { start: block.start, end: block.end, title: block.title };
    } else {
      current.end = block.end;
      if (!current.title) current.title = block.title;
    }
  }
  if (current && current.end > current.start) spans.push(current);
  // A trailing fragment is easier to cite together with the passage before it.
  if (spans.length > 1) {
    const last = spans.at(-1)!;
    const previous = spans.at(-2)!;
    if (estimateTokens(text.slice(last.start, last.end)) < 120 && previous.end - previous.start + (last.end - last.start) <= ceiling * 1.1) {
      previous.end = last.end;
      spans.pop();
    }
  }
  return spans.length ? spans : [];
}

/** Extends each span back over a slice of its predecessor, snapped to a word or line boundary. */
function overlap(text: string, spans: Span[], ratio: number): Span[] {
  return spans.map((span, index) => {
    if (index === 0) return span;
    const previous = spans[index - 1]!;
    const back = Math.max(1, Math.ceil((previous.end - previous.start) * ratio));
    let start = Math.max(previous.start + 1, previous.end - back);
    while (start < previous.end && start > 0 && !/[\s\n]/.test(text[start - 1]!)) start++;
    while (start < previous.end && /\s/.test(text[start]!)) start++;
    if (start >= span.start) return span;
    return { ...span, start };
  });
}

/**
 * Chunks `text` deterministically. The same source id and text always produce the same ids, offsets, and
 * order, so a retry can replace rows without reshuffling citations.
 */
export function chunkDocument(text: string, opts: { sourceId: string; title?: string; targetTokens?: number; overlapRatio?: number } = { sourceId: "" }): RawChunk[] {
  if (!text.trim()) return [];
  const normalized = text.replace(/\r\n/g, "\n");
  const ceiling = Math.max(200, Math.round((opts.targetTokens ?? TARGET_TOKENS) * CHARS_PER_TOKEN));
  const ratio = Math.min(0.4, Math.max(0, opts.overlapRatio ?? OVERLAP_RATIO));
  const spans = overlap(normalized, pack(normalized, ceiling), ratio);
  const out: RawChunk[] = [];
  for (const span of spans) {
    let start = span.start;
    let end = span.end;
    while (start < end && /\s/.test(normalized[start]!)) start++;
    while (end > start && /\s/.test(normalized[end - 1]!)) end--;
    if (end <= start) continue;
    const body = normalized.slice(start, end);
    const title = span.title || opts.title || "Document";
    const hash = createHash("sha256").update(`${opts.sourceId}\n${start}\n${end}\n${body}`).digest("hex").slice(0, 24);
    out.push({ id: `k_${hash}`, ordinal: out.length, title, start, end, text: body, tokens: estimateTokens(body) });
  }
  return out;
}

/** A short excerpt for a tool card or list, without splitting a surrogate pair. */
export function excerpt(text: string, max = 240): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.length - (cut.codePointAt(cut.length - 1)! > 0xffff ? 1 : 0))}…`;
}
