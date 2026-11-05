/**
 * Secret scrubbing for text that reaches a log or an error surface. This is defense in depth, not
 * encryption: a key that does not look like a key can still slip through. Keep the patterns shared
 * so server logs and browser-side detail text cannot drift apart.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // okaychat external API credentials: the whole token or any prefix-bearing malformed form.
  [/\bokc_api_v1_[A-Za-z0-9_-]{0,43}(?:\.[A-Za-z0-9_-]{0,43})?/g, "okc_api_v1_[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]"],
  // "Authorization": "Bearer abc..." and bare Bearer tokens in a header dump.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic [redacted]"],
  // JSON quoted keys: {"apiKey":"value"}, {"api_key": "value"}, "authorization": "..." (camelCase too).
  [
    /("(?:x-api-key|api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password)"\s*:\s*")([^"]{3,})(")/gi,
    "$1[redacted]$3",
  ],
  // header dumps, query strings, and key=value pairs (quoted or not).
  [
    /\b(api[-_]?key|authorization|x-api-key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password)\b(\s*[:=]\s*['"]?)([^\s'",;}\]]{4,})/gi,
    "$1$2[redacted]",
  ],
];

export function redactSecrets(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
