/**
 * Whether a Markdown image may be fetched automatically. Only app-owned image routes are allowed
 * without consent; every other http(s) URL is shown as a placeholder with an explicit Load action.
 * A proxy would still leak the query string to the attacker, so this blocks the request instead.
 */
export type MarkdownImageSource =
  | { kind: "app"; url: string }
  | { kind: "inline"; url: string }
  | { kind: "remote"; url: string }
  | { kind: "blocked"; url?: string };

// Exact app routes. A path such as `/api/images/../mcp` does not match after URL normalization, and
// `//evil.example/api/images/x` is protocol-relative, so it is treated as remote.
const APP_IMAGE =
  /^\/api\/(?:images\/[A-Za-z0-9_-]+|uploads\/[A-Za-z0-9_.-]+\/file|sandbox\/[A-Za-z0-9_-]+\/stored|account\/avatar|public\/shares\/[A-Za-z0-9_-]+\/(?:(?:images|uploads)\/[A-Za-z0-9_.-]+|artifacts\/[A-Za-z0-9_-]+\/file))(?:\?[^#]*)?$/;

const INLINE_RASTER = /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[a-z0-9+/=\s]+$/i;

export function markdownImageSource(raw: string | undefined): MarkdownImageSource {
  const value = raw?.trim() ?? "";
  if (!value) return { kind: "blocked" };
  if (INLINE_RASTER.test(value)) return { kind: "inline", url: value };
  if (/^blob:/i.test(value)) return { kind: "inline", url: value };
  if (/^data:/i.test(value)) return { kind: "blocked", url: value };
  // Protocol-relative URLs never reach the app's own origin.
  if (value.startsWith("//")) return { kind: "remote", url: `https:${value}` };
  if (APP_IMAGE.test(value)) return { kind: "app", url: value };
  if (/^https?:\/\//i.test(value)) return { kind: "remote", url: value };
  // A relative path would resolve against the app origin, so it is not an app-owned image route.
  return { kind: "blocked", url: value };
}

export function remoteImageHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/**
 * Consent is per exact URL, not per mount. A streaming Markdown tree reuses this component while the
 * `src` changes, so a boolean would let an approved innocuous image authorize the next attacker URL.
 * The failure flag is keyed the same way, so URL A failing does not hide URL B.
 */
export interface ImageConsentState {
  approvedUrl?: string | null;
  failedUrl?: string | null;
}

export type ImageReveal = "blocked" | "consent" | "image" | "failed";

export function imageReveal(source: MarkdownImageSource, consent: ImageConsentState): ImageReveal {
  if (source.kind === "blocked" || !source.url) return "blocked";
  if (consent.failedUrl === source.url) return "failed";
  if (source.kind === "remote" && consent.approvedUrl !== source.url) return "consent";
  return "image";
}
