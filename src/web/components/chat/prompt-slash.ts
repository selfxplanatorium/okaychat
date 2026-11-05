// Slash prompts are deliberately narrow: only when the whole composer input is `/` plus letters, digits, or
// hyphens. Anything else (URLs, paths, prose) stays ordinary typing, and replacing the token is unambiguous.
// See docs/implementation/saved-prompts.md.

export interface SlashToken {
  /** The text after the slash, lowercased for matching. */
  query: string;
}

const QUERY = /^[a-zA-Z0-9-]*$/;

/** The whole input as a slash token, or null. An empty `/` is a valid token that lists the library. */
export function parseSlashToken(input: string): SlashToken | null {
  if (!input.startsWith("/")) return null;
  const rest = input.slice(1);
  return QUERY.test(rest) ? { query: rest.toLowerCase() } : null;
}

/**
 * A token is eligible only at the start of the whole input, with the selection collapsed at its end, and not
 * while an IME is composing. Checking the whole input keeps the replacement range exactly the input.
 */
export function slashTokenAt(input: string, selectionStart: number, selectionEnd: number, composing = false): SlashToken | null {
  if (composing || selectionStart !== selectionEnd || selectionStart !== input.length) return null;
  return parseSlashToken(input);
}

/** A stable key for "the token did not change": Escape may hide the menu until text or caret moves. */
export const slashTokenKey = (input: string, caret: number) => `${caret}:${input}`;
