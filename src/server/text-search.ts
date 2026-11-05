/**
 * Literal FTS5 compilation for user-typed search. Only Unicode letters and numbers become tokens, each
 * is quoted as a literal with a prefix wildcard, and terms combine with AND. No user text ever reaches
 * MATCH as grammar, and the caller always passes the result as one bound parameter.
 */
const TOKEN = /[\p{L}\p{N}]+/gu;

export function ftsTokens(query: string, limit = 20): string[] {
  if (!query.trim()) return [];
  const tokens = query.match(TOKEN) ?? [];
  return tokens.slice(0, limit);
}

export function ftsMatchQuery(tokens: readonly string[]): string {
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" AND ");
}
