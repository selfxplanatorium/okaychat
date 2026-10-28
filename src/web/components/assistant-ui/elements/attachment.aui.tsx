"use client";

import {
  type PropsWithChildren,
  useMemo,
  useState,
  type FC,
  isValidElement,
} from "react";
import {
  XIcon,
  PlusIcon,
  FileText,
  FileAudioIcon,
  Loader2Icon,
  AlertCircleIcon,
} from "lucide-react";
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
  useAui,
} from "@assistant-ui/react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useAttachmentSrc } from "@/hooks/use-attachment-src";
import { cn } from "@/lib/utils";
import { attachmentPreview, textAttachments } from "@/runtime/message-attachments";

type AttachmentPreviewProps = {
  src: string;
  name: string;
};

const AttachmentPreview: FC<AttachmentPreviewProps> = ({ src, name }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  return (
    <img
      src={src}
      alt={`Preview of ${name}`}
      className={cn(
        "block h-auto max-h-[80vh] w-auto max-w-full rounded-sm object-contain transition-[opacity] duration-(--motion-slow) ease-out-quart motion-reduce:transition-none",
        isLoaded
          ? "aui-attachment-preview-image-loaded opacity-100"
          : "aui-attachment-preview-image-loading opacity-0",
      )}
      onLoad={() => setIsLoaded(true)}
    />
  );
};

type AttachmentPreviewDialogProps = PropsWithChildren<{
  src: string | undefined;
  name: string;
}>;

const AttachmentPreviewDialog: FC<AttachmentPreviewDialogProps> = ({
  children,
  src,
  name,
}) => {
  if (!src) return children;

  return (
    <Dialog>
      <DialogTrigger
        nativeButton={false}
        className="aui-attachment-preview-trigger cursor-zoom-in"
        render={
          isValidElement(children) ? (
            children
          ) : (
            <button type="button">{children}</button>
          )
        }
      />
      <DialogContent className="aui-attachment-preview-dialog-content [&>button]:bg-foreground/60 [&>button]:hover:bg-foreground/80 [&_svg]:text-background p-2 sm:max-w-3xl [&>button]:rounded-full [&>button]:p-1 [&>button]:opacity-100 [&>button]:ring-0!">
        <DialogTitle className="aui-sr-only sr-only">
          Preview {name}
        </DialogTitle>
        <div className="aui-attachment-preview bg-background relative mx-auto flex max-h-[80dvh] w-full items-center justify-center overflow-hidden rounded-sm">
          <AttachmentPreview src={src} name={name} />
        </div>
      </DialogContent>
    </Dialog>
  );
};

const AttachmentThumb: FC<{ src: string | undefined }> = ({ src }) => {
  return (
    <Avatar className="aui-attachment-tile-avatar h-full w-full rounded-none after:hidden">
      <AvatarImage
        src={src}
        alt=""
        className="aui-attachment-tile-image rounded-none object-cover"
      />
      <AvatarFallback>
        <FileText className="aui-attachment-tile-fallback-icon text-muted-foreground/80 size-6 stroke-[1.5]" />
      </AvatarFallback>
    </Avatar>
  );
};

/** File extension as a short type label, or the attachment kind when the name has none. */
const kindLabel = (name: string, fallback: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : fallback;
};

/** Non-image files show their name and type, so a sent message tells which files went with it. */
const FileChipBody: FC<{ name: string; contentType: string; kind: string; removable?: boolean }> = ({
  name,
  contentType,
  kind,
  removable,
}) => {
  const Icon = contentType.startsWith("audio/") ? FileAudioIcon : FileText;
  return (
    // A removable chip keeps its text clear of the corner remove button.
    <div className={cn("aui-attachment-chip flex h-full min-w-0 items-center gap-2.5 ps-2.5", removable ? "pe-8" : "pe-3.5")}>
      <div className="bg-background/70 flex size-9 shrink-0 items-center justify-center rounded-md">
        <Icon className="text-muted-foreground size-5 stroke-[1.5]" />
      </div>
      <div className="flex min-w-0 flex-col text-start leading-tight">
        <span className="text-foreground truncate text-sm">{name}</span>
        <span className="text-muted-foreground truncate text-xs">{kindLabel(name, kind)}</span>
      </div>
    </div>
  );
};

const tileClass =
  "aui-attachment-tile bg-muted hover:after:bg-foreground/10 focus-visible:ring-ring/50 relative overflow-hidden rounded-[calc(var(--composer-radius,1rem)-var(--composer-padding,8px))] transition-transform outline-none after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-black/10 after:transition-colors after:ring-inset focus-visible:ring-1 motion-reduce:transition-none dark:after:ring-white/10";

const AttachmentUI: FC = () => {
  const aui = useAui();
  const isComposer = aui.attachment.source !== "message";
  const src = useAttachmentSrc();

  const isImage = useAuiState((s) => s.attachment.type === "image");
  const name = useAuiState((s) => s.attachment.name);
  const contentType = useAuiState((s) => s.attachment.contentType ?? "");
  const typeLabel = useAuiState((s) => {
    const type = s.attachment.type;
    switch (type) {
      case "image":
        return "Image";
      case "document":
        return "Document";
      case "file":
        return "File";
      default:
        return type;
    }
  });

  // An attachment on a submission is still being prepared, whether or not the
  // adapter reports progress while it uploads.
  const uploadState = useAuiState((s) =>
    s.attachment.status.type === "incomplete" &&
    s.attachment.status.reason === "error"
      ? "error"
      : s.attachment.status.type === "running" ||
          (s.optional.message?.submission !== undefined &&
            s.attachment.status.type !== "complete")
        ? "uploading"
        : undefined,
  );
  const isUploading = uploadState === "uploading";
  const isError = uploadState === "error";

  const errorMessage = useAuiState((s) =>
    s.attachment.status.type === "incomplete" &&
    s.attachment.status.reason === "error"
      ? (s.attachment.status.message ?? "Upload failed")
      : undefined,
  );

  return (
    <TooltipProvider>
      <Tooltip>
        <AttachmentPrimitive.Root
          className={cn(
            "aui-attachment-root relative",
            // Added files land in the composer with a small spring.
            isComposer && "animate-pop-in motion-reduce:animate-none",
            isImage &&
              !isComposer &&
              "aui-attachment-root-message only:*:first:size-24",
          )}
        >
          <AttachmentPreviewDialog src={src} name={name}>
            <TooltipTrigger
              render={
                <div
                  className={cn(
                    tileClass,
                    isImage ? "size-14" : "h-14 w-max max-w-60",
                    src
                      ? "cursor-zoom-in active:scale-[0.96]"
                      : "cursor-default",
                    isError &&
                      "after:ring-destructive/60 dark:after:ring-destructive/60",
                  )}
                  role={src ? "button" : "group"}
                  tabIndex={0}
                  aria-label={`${src ? `Preview ${name}` : `${typeLabel} attachment ${name}`}${
                    isError
                      ? ", upload failed"
                      : isUploading
                        ? ", uploading"
                        : ""
                  }`}
                />
              }
            >
              {isImage ? (
                <AttachmentThumb src={src} />
              ) : (
                <FileChipBody name={name} contentType={contentType} kind={typeLabel} removable={isComposer} />
              )}
              {isUploading && (
                <div
                  aria-hidden="true"
                  className="aui-attachment-tile-uploading bg-background/60 animate-in fade-in-0 absolute inset-0 flex items-center justify-center backdrop-blur-[2px] motion-reduce:animate-none"
                >
                  <Loader2Icon className="text-muted-foreground size-4 animate-spin" />
                </div>
              )}
              {isError && (
                <div
                  aria-hidden="true"
                  className="aui-attachment-tile-error bg-background/70 animate-in fade-in-0 absolute inset-0 flex items-center justify-center backdrop-blur-[2px] motion-reduce:animate-none"
                >
                  <AlertCircleIcon className="text-destructive size-4" />
                </div>
              )}
            </TooltipTrigger>
          </AttachmentPreviewDialog>
          {isComposer && <AttachmentRemove name={name} />}
        </AttachmentPrimitive.Root>
        <TooltipContent side="top">
          <AttachmentPrimitive.Name />
          {errorMessage && (
            <p className="aui-attachment-error-message">{errorMessage}</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

const AttachmentRemove: FC<{ name: string }> = ({ name }) => {
  return (
    <AttachmentPrimitive.Remove
      render={
        <TooltipIconButton
          tooltip={`Remove ${name}`}
          className="aui-attachment-tile-remove absolute end-1 top-1 size-5 rounded-full bg-black/50! text-white after:absolute after:-inset-1.5 hover:bg-black/70! hover:text-white! active:scale-[0.96] motion-reduce:transition-none"
          side="top"
        />
      }
    >
      <XIcon className="aui-attachment-remove-icon size-3 stroke-[2.5]" />
    </AttachmentPrimitive.Remove>
  );
};

/** A text attachment of a sent message (text files, pasted text, extracted documents, transcripts). Opens its text. */
const TextAttachmentTile: FC<{ name: string; body: string }> = ({ name, body }) => {
  const preview = attachmentPreview(body);
  const lines = preview ? preview.split("\n").length : 0;
  const chip = (
    <FileChipBody
      name={name}
      contentType=""
      kind="File"
    />
  );
  if (!preview)
    return (
      <div role="group" aria-label={`File attachment ${name}`} className={cn(tileClass, "h-14 w-max max-w-60 cursor-default")}>
        {chip}
      </div>
    );
  return (
    <Dialog>
      <DialogTrigger
        render={
          <button
            type="button"
            aria-label={`Open ${name}`}
            title={`${name} · ${lines} ${lines === 1 ? "line" : "lines"}`}
            className={cn(tileClass, "h-14 w-max max-w-60 cursor-pointer active:scale-[0.96]")}
          />
        }
      >
        {chip}
      </DialogTrigger>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-3 p-4 sm:max-w-3xl">
        <DialogTitle className="truncate pe-8 text-base">{name}</DialogTitle>
        <pre className="bg-muted/60 min-h-0 flex-1 overflow-auto rounded-md p-3 font-mono text-xs leading-5 whitespace-pre-wrap wrap-break-word">
          {preview}
        </pre>
      </DialogContent>
    </Dialog>
  );
};

/** Text attachments live in the message content as `<attachment>` parts; only file parts arrive as attachments. */
const MessageTextAttachments: FC = () => {
  const content = useAuiState((s) => s.message.content);
  const attachments = useAuiState((s) => s.message.attachments);
  const items = useMemo(
    () => (content ? textAttachments(content as Parameters<typeof textAttachments>[0], attachments) : []),
    [content, attachments],
  );
  return items.map((item) => <TextAttachmentTile key={item.key} name={item.name} body={item.body} />);
};

export const UserMessageAttachments: FC = () => {
  return (
    <div className="aui-user-message-attachments-end col-span-full col-start-1 row-start-1 flex w-full flex-row flex-wrap justify-end gap-2 empty:hidden">
      <MessagePrimitive.Attachments>
        {() => <AttachmentUI />}
      </MessagePrimitive.Attachments>
      <MessageTextAttachments />
    </div>
  );
};

export const ComposerAttachments: FC = () => {
  return (
    <div className="aui-composer-attachments flex w-full flex-row items-center gap-2 overflow-x-auto empty:hidden">
      <ComposerPrimitive.Attachments>
        {() => <AttachmentUI />}
      </ComposerPrimitive.Attachments>
    </div>
  );
};

export const ComposerAddAttachment: FC<{ className?: string }> = ({ className }) => {
  return (
    <ComposerPrimitive.AddAttachment
      render={
        <TooltipIconButton
          tooltip="Add Attachment"
          command="composer.attach"
          side="bottom"
          variant="ghost"
          size="icon"
          className={cn(
            "aui-composer-add-attachment text-muted-foreground hover:text-foreground hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 pointer-coarse:size-9 rounded-full active:scale-[0.96] motion-reduce:transition-none",
            className,
          )}
          aria-label="Add Attachment"
        />
      }
    >
      <PlusIcon className="aui-attachment-add-icon size-4" />
    </ComposerPrimitive.AddAttachment>
  );
};
