import { ImageOffIcon } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { t } from "@/i18n";
import { hasVariants, imageSrcSet, imageVariantUrl, originalImageUrl, type ImageVariant } from "@/lib/media";
import { cn } from "@/lib/utils";

export interface OwnedImageProps {
  src: string;
  alt: string;
  variant?: ImageVariant;
  width?: number | null;
  height?: number | null;
  /** With a known size, lets the browser pick among the variants for this slot width. */
  sizes?: string;
  eager?: boolean;
  /**
   * Opens this URL in a new tab when the image is clicked. The link wraps only the loaded image: the failure
   * fallback has its own controls, which must not sit inside another link.
   */
  href?: string;
  linkClassName?: string;
  /**
   * False when a parent control (a Library tile button) already handles activation: the fallback then shows
   * no Retry or Open original, which would otherwise be a control nested in a control.
   */
  controls?: boolean;
  className?: string;
  imgClassName?: string;
  style?: CSSProperties;
}

/**
 * An app-owned image shown at a server-made preview size. The box reserves the image's aspect ratio when the
 * size is known, loads lazily and decodes off the main thread, and on failure shows a fallback with Retry and
 * Open original instead of silently upgrading to the full original. Remote URLs never belong here: Markdown
 * images keep their consent flow in ProtectedMarkdownImage. Loading state belongs to one source: a new `src`
 * starts fresh, so an earlier failure never sticks to a different image.
 */
export function OwnedImage(props: OwnedImageProps) {
  return <OwnedImageFor key={props.src} {...props} />;
}

function OwnedImageFor({
  src,
  alt,
  variant = "medium",
  width,
  height,
  sizes,
  eager = false,
  href,
  linkClassName,
  controls = true,
  className,
  imgClassName,
  style,
}: OwnedImageProps) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  const base = imageVariantUrl(src, variant);
  // A retry must not be answered from a failed cache entry.
  const url = attempt ? `${base}${base.includes("?") ? "&" : "?"}retry=${attempt}` : base;
  const srcSet = sizes && !attempt ? imageSrcSet(src, width, height) : undefined;
  const ratio = width && height ? { aspectRatio: `${width} / ${height}` } : undefined;
  if (state === "failed") {
    return (
      <span
        data-slot="owned-image-fallback"
        role="group"
        aria-label={alt || t("thread.imageContent")}
        className={cn("bg-muted/50 text-muted-foreground flex min-h-24 flex-col items-center justify-center gap-2 rounded-lg border p-3 text-center text-xs", className)}
        style={{ ...ratio, ...style }}
      >
        <ImageOffIcon aria-hidden className="size-5" />
        <span>{t("thread.imageLoadFailed")}</span>
        {controls ? (
          <span className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              data-command="chat.retryImage"
              onClick={() => {
                setState("loading");
                setAttempt((n) => n + 1);
              }}
              className="border-border bg-background text-foreground hover:bg-muted focus-visible:ring-ring rounded-md border px-2.5 py-1 font-medium transition-colors duration-(--motion-fast) ease-out-quart focus-visible:ring-2 focus-visible:outline-none"
            >
              {t("common.retry")}
            </button>
            {hasVariants(src) ? (
              <a
                href={originalImageUrl(src)}
                target="_blank"
                rel="noreferrer"
                className="text-foreground focus-visible:ring-ring rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
              >
                {t("thread.openOriginal")}
              </a>
            ) : null}
          </span>
        ) : null}
      </span>
    );
  }
  const image = (
    <img
      key={url}
      src={url}
      srcSet={srcSet}
      sizes={srcSet ? sizes : undefined}
      alt={alt}
      width={width ?? undefined}
      height={height ?? undefined}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onLoad={() => setState("loaded")}
      onError={() => setState("failed")}
      className={cn(
        "transition-opacity duration-(--motion-slow) ease-out-quart motion-reduce:transition-none",
        state === "loaded" ? "opacity-100" : "bg-muted/50 opacity-90",
        className,
        imgClassName,
      )}
      style={{ ...ratio, ...style }}
    />
  );
  if (!href) return image;
  return (
    <a href={href} target="_blank" rel="noreferrer" className={linkClassName}>
      {image}
    </a>
  );
}
