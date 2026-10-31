/** The only chunk-id shape the knowledge base issues: `k_` plus 24 lowercase hex characters. */
const CHUNK_ID = /^k_[a-f0-9]{24}$/;
const SCHEME = /^oknowledge:/i;

/**
 * Parses a model-written `oknowledge:` link into a chunk id. Model text is untrusted, so malformed
 * percent escapes, surrounding whitespace, query strings, and forged ids all yield null instead of
 * throwing inside the Markdown renderer.
 */
export function parseKnowledgeCitation(href: string | undefined | null): string | null {
  if (!href || !SCHEME.test(href)) return null;
  let raw = href.replace(SCHEME, "").split(/[?#]/, 1)[0] ?? "";
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  raw = raw.trim();
  return CHUNK_ID.test(raw) ? raw : null;
}

/** Whether a link is a knowledge scheme at all, including malformed values that must render inert. */
export const isKnowledgeHref = (href: string | undefined | null): boolean => !!href && SCHEME.test(href);
