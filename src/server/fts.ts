/**
 * Shared FTS5 query construction. Each word is quoted, so user input never becomes an FTS operator,
 * and the last word is a prefix so results appear while typing. Private chat search and channel search
 * use the same helper; their indexes and authorization remain separate.
 */

/** Snippet markers that cannot appear in user text, so the client can split on them safely. */
export const SNIPPET_OPEN = "\u0002";
export const SNIPPET_CLOSE = "\u0003";

export function toFtsQuery(input: string): string | null {
  const words = input.match(/[\p{L}\p{N}_]+/gu);
  if (!words?.length) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}
