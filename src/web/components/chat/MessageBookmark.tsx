import { ActionBarMorePrimitive } from "@assistant-ui/react";
import { BookmarkCheckIcon, BookmarkIcon } from "lucide-react";
import { useState } from "react";
import { MAX_BOOKMARKS_PER_THREAD } from "@shared/message-annotations";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { t } from "@/i18n";
import { ApiError } from "@/lib/api";
import { useCommand } from "@/keyboard/registry";
import { useAnnotationGate, focusedMessageId } from "./annotation-gates";
import { useAnnotationPending, useBookmark, setBookmark } from "@/state/message-annotations";

// Bookmarks are private navigation metadata: one row per (chat, message), never copied text, never chat activity.

function useBookmarkState(threadId: string | null | undefined, messageId: string) {
  const gate = useAnnotationGate(threadId, messageId);
  const bookmark = useBookmark(threadId ?? undefined, messageId);
  const pending = useAnnotationPending("bookmark", threadId ?? undefined, messageId);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const toggle = async (next: boolean) => {
    if (!threadId || !gate.available || pending) return;
    setFailed(false);
    setStatus(null);
    try {
      await setBookmark(threadId, messageId, next);
      setStatus(t(next ? "annotations.bookmarked" : "annotations.removedBookmark"));
    } catch (error) {
      setFailed(true);
      // The server's only bookmark cap conflict is the per-chat limit.
      if (error instanceof ApiError && error.status === 409) {
        setStatus(
          error.message.includes(String(MAX_BOOKMARKS_PER_THREAD))
            ? t("annotations.bookmarkLimit", { count: MAX_BOOKMARKS_PER_THREAD })
            : t("annotations.busy"),
        );
      }
    }
  };
  return { gate, bookmark, pending, failed, status, toggle };
}

/** "Bookmark" / "Remove bookmark" in either message's More menu, disabled with its reason. */
export function BookmarkMenuItem({ threadId, messageId }: { threadId: string | null | undefined; messageId: string }) {
  const { gate, bookmark, pending, failed, status, toggle } = useBookmarkState(threadId, messageId);
  const label = failed
    ? (status ?? t("annotations.saveError"))
    : !gate.available
      ? t(gate.reason ?? "annotations.busy")
      : bookmark
        ? t("annotations.removeBookmark")
        : t("annotations.bookmark");
  return (
    <ActionBarMorePrimitive.Item
      disabled={!gate.available || pending}
      title={!gate.temporary && !gate.stored ? t("annotations.messageNotStored") : undefined}
      onClick={() => void toggle(!bookmark)}
      className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors duration-(--motion-fast) ease-out-quart select-none disabled:opacity-50"
    >
      {bookmark ? <BookmarkCheckIcon className="size-4" /> : <BookmarkIcon className="size-4" />}
      {label}
      {failed && <span role="alert" className="sr-only">{t("annotations.saveError")}</span>}
      {status && <span role="status" className="sr-only">{status}</span>}
    </ActionBarMorePrimitive.Item>
  );
}

/** The persistent mark in a saved message's footer. A button, not a colour: its name states the action. */
export function BookmarkMarker({ threadId, messageId }: { threadId: string | null | undefined; messageId: string }) {
  const { gate, bookmark, pending, failed, status, toggle } = useBookmarkState(threadId, messageId);
  if (!bookmark) return null;
  return (
    <>
      <TooltipIconButton
        tooltip={failed ? t("annotations.saveError") : t("annotations.removeBookmark")}
        aria-label={t("annotations.removeBookmark")}
        aria-pressed
        disabled={!gate.available || pending}
        onClick={() => void toggle(false)}
        className="text-primary size-7 pointer-coarse:size-9 shrink-0 opacity-80 hover:opacity-100"
      >
        <BookmarkCheckIcon className="size-3.5" />
      </TooltipIconButton>
      {status && <span role="status" className="sr-only">{status}</span>}
    </>
  );
}

/** Registers the keyboard command for the focused message; never acts on the newest visible reply. */
export function BookmarkCommand({ threadId, messageId }: { threadId: string | null | undefined; messageId: string }) {
  const { gate, bookmark, toggle } = useBookmarkState(threadId, messageId);
  useCommand(
    "message.bookmark",
    () => {
      if (focusedMessageId() !== messageId || !gate.available) return false;
      void toggle(!bookmark);
      return true;
    },
    gate.available,
  );
  return null;
}
