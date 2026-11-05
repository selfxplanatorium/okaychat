import { PinIcon, StarIcon } from "lucide-react";
import type { NoteSummary } from "@shared/notes";
import { t } from "@/i18n";
import { formatRelativeTime } from "@/i18n/format";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function NoteList({
  items,
  selectedId,
  loading,
  error,
  nextCursor,
  onSelect,
  onToggleFavorite,
  onTogglePin,
  onLoadMore,
  onRetry,
}: {
  items: NoteSummary[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  nextCursor: string | null;
  onSelect: (id: string) => void;
  onToggleFavorite: (note: NoteSummary) => void;
  onTogglePin: (note: NoteSummary) => void;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  if (loading && !items.length) return <p role="status" className="text-muted-foreground p-4 text-sm">{t("notes.loading")}</p>;
  if (error && !items.length) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
        <p>{t("notes.loadFailed")}</p>
        <Button size="sm" variant="outline" onClick={onRetry}>{t("common.retry")}</Button>
      </div>
    );
  }
  if (!items.length) {
    return (
      <div className="flex flex-col gap-1 p-6 text-center">
        <p className="text-sm font-medium">{t("notes.empty")}</p>
        <p className="text-muted-foreground text-sm">{t("notes.emptyBody")}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 p-1">
      <ul className="flex flex-col gap-0.5" aria-label={t("notes.title")}>
        {items.map((note) => (
          <li key={note.id}>
            <div className={cn("group relative flex items-start gap-1 rounded-lg", selectedId === note.id && "depth-row-active")}>
              <button
                type="button"
                onClick={() => onSelect(note.id)}
                aria-current={selectedId === note.id ? "true" : undefined}
                className="focus-visible:outline-ring min-w-0 flex-1 rounded-lg px-2.5 py-2 text-start"
              >
                <span className="flex items-center gap-1.5">
                  {note.pinned && <PinIcon aria-label={t("notes.pinned")} className="text-muted-foreground size-3 shrink-0" />}
                  <span className="truncate text-sm font-medium">{note.title || t("notes.untitled")}</span>
                </span>
                <span className="text-muted-foreground mt-0.5 line-clamp-2 block text-xs">{note.excerpt || t("notes.emptyBody")}</span>
                <span className="text-muted-foreground mt-1 block text-[0.7rem]">{formatRelativeTime(note.updatedAt)}</span>
              </button>
              <div className="flex shrink-0 items-center gap-0.5 pe-1 pt-1 opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
                <button
                  type="button"
                  aria-label={note.favorite ? t("notes.unfavorite") : t("notes.favorite")}
                  aria-pressed={note.favorite}
                  onClick={() => onToggleFavorite(note)}
                  className={cn("rounded-md p-1.5 pointer-coarse:p-2.5", note.favorite ? "text-warning" : "text-muted-foreground hover:text-foreground")}
                >
                  <StarIcon aria-hidden className="size-3.5" fill={note.favorite ? "currentColor" : "none"} />
                </button>
                <button
                  type="button"
                  aria-label={note.pinned ? t("notes.unpin") : t("notes.pin")}
                  aria-pressed={note.pinned}
                  onClick={() => onTogglePin(note)}
                  className={cn("rounded-md p-1.5 pointer-coarse:p-2.5", note.pinned ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  <PinIcon aria-hidden className="size-3.5" />
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {nextCursor && (
        <Button variant="ghost" size="sm" className="mt-1 self-center" onClick={onLoadMore} disabled={loading}>
          {t("common.loadMore")}
        </Button>
      )}
    </div>
  );
}
