import { FileArchiveIcon, FileAudioIcon, FileIcon, FileSpreadsheetIcon, FileTextIcon, FileVideoIcon } from "lucide-react";
import type { ChannelAttachment } from "@shared/channels";
import { t } from "@/i18n";
import { formatBytes } from "@/i18n/format";
import { OwnedImage } from "@/components/ui/owned-image";

function FileGlyph({ mime }: { mime: string }) {
  if (/^audio\//.test(mime)) return <FileAudioIcon aria-hidden className="size-4 shrink-0" />;
  if (/^video\//.test(mime)) return <FileVideoIcon aria-hidden className="size-4 shrink-0" />;
  if (/zip|tar|gzip|compressed/.test(mime)) return <FileArchiveIcon aria-hidden className="size-4 shrink-0" />;
  if (/spreadsheet|csv/.test(mime)) return <FileSpreadsheetIcon aria-hidden className="size-4 shrink-0" />;
  if (/^text\/|pdf|json|xml|javascript/.test(mime)) return <FileTextIcon aria-hidden className="size-4 shrink-0" />;
  return <FileIcon aria-hidden className="size-4 shrink-0" />;
}

/** One message's attachments. Raster images get a bounded preview; everything else is a download chip. */
export function ChannelAttachmentList({ attachments, authorName }: { attachments: ChannelAttachment[]; authorName: string | null }) {
  if (!attachments.length) return null;
  const images = attachments.filter((item) => item.image);
  const files = attachments.filter((item) => !item.image);
  return (
    <div className="mt-1 flex flex-col gap-1.5" aria-label={t("channels.attachmentCount", { count: attachments.length })}>
      {images.length > 0 && (
        <div className="grid max-w-lg grid-cols-1 gap-1.5 sm:grid-cols-2">
          {images.map((item) => (
            <OwnedImage
              key={item.id}
              src={item.url}
              variant="medium"
              width={item.width}
              height={item.height}
              sizes="(max-width: 640px) 80vw, 320px"
              href={item.url}
              alt={t("channels.attachmentImageAlt", { name: item.name, author: authorName ?? t("channels.deletedAccount") })}
              className="max-h-64 w-full object-contain"
            />
          ))}
        </div>
      )}
      {files.map((item) => (
        <a
          key={item.id}
          href={`${item.url}?download=1`}
          download={item.name}
          className="border-border bg-muted/40 hover:bg-muted focus-visible:ring-ring flex w-fit max-w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none"
          aria-label={t("channels.attachmentDownload", { name: item.name })}
        >
          <FileGlyph mime={item.mime} />
          <span className="min-w-0 max-w-64 truncate">{item.name}</span>
          <span className="text-muted-foreground shrink-0">{formatBytes(item.size)}</span>
        </a>
      ))}
    </div>
  );
}
