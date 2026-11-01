/**
 * Owned image URLs and their server-made previews. Stored chats reference attached images as
 * `okaychat-upload:<id>`; the server swaps in the bytes for the model, and the browser loads previews.
 * Only routes this app serves get a `variant`; nothing here ever touches a remote URL.
 */
export type ImageVariant = "thumb" | "medium" | "large";

export const UPLOAD_REF = "okaychat-upload:";

/** Long edges of the variants, matching `VARIANTS` in src/server/media/store.ts. */
export const VARIANT_WIDTH: Record<ImageVariant, number> = { thumb: 256, medium: 640, large: 1280 };

const VARIANT_ROUTE =
  /^\/api\/(?:images\/[A-Za-z0-9_-]+|uploads\/[A-Za-z0-9_.-]+\/file|sandbox\/[A-Za-z0-9_-]+\/stored|account\/avatar|public\/shares\/[A-Za-z0-9_-]+\/(?:images|uploads)\/[A-Za-z0-9_.-]+)(?:\?[^#]*)?$/;

/**
 * The app URL of an owned reference (`okaychat-upload:<id>`, optionally with a `#sha256=` content digest the
 * server uses to recognise resent bytes), or the URL itself.
 */
export function ownedImageUrl(url: string): string {
  if (url.startsWith(UPLOAD_REF)) return `/api/uploads/${encodeURIComponent(url.slice(UPLOAD_REF.length).split("#")[0]!)}/file`;
  return url;
}

/** Whether the server can make previews for this URL. Data/blob URLs and remote URLs cannot. */
export const hasVariants = (url: string): boolean => VARIANT_ROUTE.test(ownedImageUrl(url));

/** A preview of an owned image at a bounded size; other URLs come back unchanged. */
export function imageVariantUrl(url: string, variant: ImageVariant): string {
  const owned = ownedImageUrl(url);
  if (!VARIANT_ROUTE.test(owned)) return owned;
  const base = owned.replace(/([?&])variant=[^&#]*&?/, "$1").replace(/[?&]$/, "");
  return `${base}${base.includes("?") ? "&" : "?"}variant=${variant}`;
}

/** The original bytes for open/download: drops any variant parameter. */
export function originalImageUrl(url: string): string {
  return ownedImageUrl(url).replace(/([?&])variant=[^&#]*&?/, "$1").replace(/[?&]$/, "");
}

/**
 * `srcset` across the variants for a responsive slot. Needs the original's pixel size: variants bound the long
 * edge and never upscale, so each one's real width follows from it, and a wrong `w` descriptor would mis-size
 * the image. Undefined when the server cannot make previews or the size is unknown.
 */
export function imageSrcSet(url: string, width: number | null | undefined, height: number | null | undefined): string | undefined {
  if (!width || !height || !hasVariants(url)) return undefined;
  const entries: string[] = [];
  for (const variant of Object.keys(VARIANT_WIDTH) as ImageVariant[]) {
    const scale = Math.min(1, VARIANT_WIDTH[variant] / Math.max(width, height));
    entries.push(`${imageVariantUrl(url, variant)} ${Math.max(1, Math.round(width * scale))}w`);
    if (scale === 1) break;
  }
  return entries.join(", ");
}
