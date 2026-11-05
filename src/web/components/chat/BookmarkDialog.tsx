import { useAuiState } from "@assistant-ui/react";
import { BookmarkXIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { closeBookmarks, useBookmarkDialog } from "@/state/bookmark-dialog";
import { loadThreadAnnotations, setBookmark, useThreadAnnotations } from "@/state/message-annotations";
import { useMessageJump } from "@/state/message-jump";
import { useCurrentThreadId } from "@/state/thread-meta";
import { useThreadSync } from "@/state/thread-sync";

// The branch jump list. It shows only marks whose message is in the branch currently on screen; marks elsewhere
// in the chat are counted, never labelled as deleted. Clicking a row reveals the real message and focuses it.

interface BranchPart {
  type: string;
  text?: string;
}

interface BranchMessage {
  id: string;
  role: string;
  content: readonly BranchPart[];
}

const EXCERPT = 160;

function excerptOf(message: BranchMessage): string {
  const text = message.content
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
    .trim();
  if (!text) return t("annotations.attachmentMessage");
  return [...text].slice(0, EXCERPT).join("");
}

export function BookmarkDialog() {
  const open = useBookmarkDialog((s) => s.open);
  const threadId = useCurrentThreadId();
  const annotations = useThreadAnnotations(threadId ?? undefined);
  const messages = useAuiState((s) => s.thread.messages) as unknown as readonly BranchMessage[];
  const running = useAuiState((s) => s.thread.isRunning || s.thread.isLoading);
  const sync = useThreadSync();
  const removeBlocked = running || !!sync;
  const jumpBlocked = sync === "stale";
  const jumpTo = useMessageJump((s) => s.jumpTo);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const skipReturnFocus = useRef(false);

  useEffect(() => {
    if (!open) return;
    // A jump suppressed the last close's focus return; the next open is ordinary again.
    skipReturnFocus.current = false;
    setQuery("");
    setError(null);
    if (threadId) void loadThreadAnnotations(threadId);
  }, [open, threadId]);

  if (!open || !threadId) return null;

  const ids = new Set(messages.map((m) => m.id));
  const rows = messages
    .filter((message) => annotations.bookmarks[message.id])
    .map((message) => ({
      messageId: message.id,
      role: message.role,
      excerpt: excerptOf(message),
    }));
  const otherBranches = Object.keys(annotations.bookmarks).filter((id) => !ids.has(id)).length;
  const term = query.trim().toLowerCase();
  const visible = (term ? rows.filter((row) => row.excerpt.toLowerCase().includes(term)) : rows).slice(0, 100);

  const remove = async (messageId: string, index: number) => {
    setRemoving(messageId);
    setError(null);
    try {
      await setBookmark(threadId, messageId, false);
      requestAnimationFrame(() => {
        const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-slot="bookmark-row-jump"]');
        const next = buttons?.[Math.min(index, (buttons?.length ?? 0) - 1)];
        if (next) next.focus({ preventScroll: true });
        else headingRef.current?.focus({ preventScroll: true });
      });
    } catch {
      setError(t("annotations.saveError"));
    } finally {
      setRemoving(null);
    }
  };

  const jump = (messageId: string) => {
    skipReturnFocus.current = true;
    jumpTo(threadId, messageId);
    closeBookmarks();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closeBookmarks();
      }}
    >
      <DialogContent
        className="gap-3 sm:max-w-lg"
        finalFocus={() => (skipReturnFocus.current ? false : true)}
      >
        <DialogTitle className="pe-6 text-base">{t("annotations.bookmarksTitle")}</DialogTitle>
        <DialogDescription className="sr-only">{t("annotations.emptyBookmarks")}</DialogDescription>
        <label className="flex flex-col gap-1 text-xs">
          <span className="sr-only">{t("annotations.searchBookmarks")}</span>
          <span className="relative">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("annotations.searchBookmarks")} className="ps-8" />
          </span>
        </label>
        {error && <p role="alert" className="text-error text-xs">{error}</p>}
        {annotations.error && !annotations.loaded && (
          <div className="flex flex-col items-start gap-2 text-xs">
            <p role="alert" className="text-error">{t("annotations.loadError")}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void loadThreadAnnotations(threadId, true)}>
              {t("common.retry")}
            </Button>
          </div>
        )}
        {visible.length === 0 ? (
          <p ref={headingRef} tabIndex={-1} className="text-muted-foreground rounded-lg px-2 py-6 text-center text-sm outline-none">
            {t("annotations.emptyBookmarks")}
          </p>
        ) : (
          <ScrollArea className="max-h-[60vh]" viewportClassName="pe-1">
            <div ref={listRef} className="flex flex-col gap-1">
              {visible.map((row, index) => (
                <div key={row.messageId} className="flex items-stretch gap-1">
                  <button
                    type="button"
                    data-slot="bookmark-row-jump"
                    disabled={jumpBlocked}
                    title={jumpBlocked ? t("annotations.syncRequired") : undefined}
                    onClick={() => jump(row.messageId)}
                    className="hover:bg-accent focus-visible:bg-accent flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg px-2.5 py-2 text-start outline-none transition-colors duration-(--motion-fast) ease-out-quart disabled:opacity-50"
                  >
                    <span className="text-muted-foreground text-[11px] font-medium">
                      {row.role === "user" ? t("thread.youSaid") : t("thread.assistantSaid")}
                    </span>
                    <span className="line-clamp-2 text-sm wrap-break-word">{row.excerpt}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t("annotations.removeBookmark")}
                    title={removeBlocked ? t("annotations.busy") : undefined}
                    disabled={removing === row.messageId || removeBlocked}
                    onClick={() => void remove(row.messageId, index)}
                    className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent flex w-9 shrink-0 items-center justify-center rounded-lg outline-none transition-colors duration-(--motion-fast) disabled:opacity-50 pointer-coarse:w-11"
                  >
                    <BookmarkXIcon className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
        {otherBranches > 0 && (
          <p className={cn("text-muted-foreground text-xs")}>{t("annotations.otherBranches", { count: otherBranches })}</p>
        )}
        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={closeBookmarks}>
            {t("common.close")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
