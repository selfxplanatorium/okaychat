import { useRef } from "react";
import { AlertCircleIcon, LoaderCircleIcon, PaperclipIcon, RotateCcwIcon, XIcon } from "lucide-react";
import type { ChannelSummary } from "@shared/channels";
import { t } from "@/i18n";
import { formatBytes } from "@/i18n/format";
import { useChannels } from "@/state/channels";
import { cn } from "@/lib/utils";

const NO_CHIPS: never[] = [];

/**
 * The paperclip, its hidden file input, and the pending chips. The drop zone lives on the composer shell;
 * this component never replaces the input, so keyboard and screen-reader users always have a real control.
 */
export function ChannelAttachmentPicker({ room, composerKey }: { room: ChannelSummary; composerKey: string }) {
  const input = useRef<HTMLInputElement>(null);
  const chips = useChannels((state) => state.pendingAttachments[composerKey] ?? NO_CHIPS);
  const uploading = useChannels((state) => state.uploading[composerKey] ?? 0);
  if (!room.capabilities.attach) return null;
  const attach = (files: FileList | File[]) => void useChannels.getState().attachFiles(composerKey, [...files]);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {chips.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label={t("channels.attachments")}>
          {chips.map((chip) => (
            <li
              key={chip.localId}
              className={cn(
                "border-border bg-muted/50 flex max-w-full items-center gap-1 rounded-lg border px-1.5 py-1 text-xs",
                chip.status === "failed" && "border-destructive/40 bg-destructive/5",
              )}
            >
              {chip.status === "uploading" ? (
                <>
                  <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 animate-spin" />
                  <span className="sr-only">{t("channels.attachmentPending")}</span>
                </>
              ) : chip.status === "failed" ? (
                <AlertCircleIcon aria-hidden className="text-destructive size-3.5 shrink-0" />
              ) : (
                <PaperclipIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
              )}
              <span className="min-w-0 max-w-40 truncate" title={chip.name}>{chip.name}</span>
              <span className="text-muted-foreground shrink-0">{formatBytes(chip.size)}</span>
              {chip.status === "failed" && chip.error && <span className="text-destructive truncate">{chip.error}</span>}
              {chip.status === "failed" && chip.file && (
                <button
                  type="button"
                  aria-label={t("channels.retry")}
                  onClick={() => {
                    const file = chip.file;
                    useChannels.getState().removePendingAttachment(composerKey, chip.localId);
                    if (file) void useChannels.getState().attachFiles(composerKey, [file]);
                  }}
                  className="text-muted-foreground hover:text-foreground rounded p-1 pointer-coarse:p-2"
                >
                  <RotateCcwIcon aria-hidden className="size-3" />
                </button>
              )}
              <button
                type="button"
                aria-label={t("channels.attachmentRemove", { name: chip.name })}
                onClick={() => useChannels.getState().removePendingAttachment(composerKey, chip.localId)}
                className="text-muted-foreground hover:text-foreground rounded p-1 pointer-coarse:p-2"
              >
                <XIcon aria-hidden className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={input}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const files = event.target.files;
          if (files?.length) attach(files);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        data-channel-attach
        aria-label={t("channels.attach")}
        title={t("channels.attachFiles")}
        disabled={uploading >= 5 || chips.length >= 5}
        onClick={() => input.current?.click()}
        className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-lg p-2 pointer-coarse:p-3 disabled:opacity-40"
      >
        <PaperclipIcon aria-hidden className="size-4" />
      </button>
    </div>
  );
}
