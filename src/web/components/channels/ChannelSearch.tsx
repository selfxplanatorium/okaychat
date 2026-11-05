import { useEffect, useState } from "react";
import { SearchIcon } from "lucide-react";
import type { ChannelSearchHit } from "@shared/channels";
import { t } from "@/i18n";
import { api } from "@/lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { channelsApi } from "@/state/channels-api";

const OPEN = "\u0002";
const CLOSE = "\u0003";

function Snippet({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let rest = text;
  for (let index = 0; rest.length; index++) {
    const open = rest.indexOf(OPEN);
    const close = open >= 0 ? rest.indexOf(CLOSE, open) : -1;
    if (open < 0 || close < 0) {
      parts.push(rest);
      break;
    }
    if (open > 0) parts.push(rest.slice(0, open));
    parts.push(<mark key={index} className="bg-primary/20 text-foreground rounded px-0.5">{rest.slice(open + 1, close)}</mark>);
    rest = rest.slice(close + 1);
  }
  return <>{parts}</>;
}

export function ChannelSearch({
  open,
  channelId,
  onOpenChange,
  onJump,
}: {
  open: boolean;
  channelId: string;
  onOpenChange: (open: boolean) => void;
  onJump: (messageId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ChannelSearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setItems([]);
      setError(null);
      setCursor(null);
    }
  }, [open]);
  useEffect(() => {
    if (!open || !query.trim()) {
      setItems([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      setSearching(true);
      setError(null);
      void channelsApi
        .search(channelId, query)
        .then((page) => {
          if (!live) return;
          setItems(page.items);
          setCursor(page.nextCursor);
        })
        .catch(() => live && setError(t("channels.notFound")))
        .finally(() => live && setSearching(false));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [channelId, open, query]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-16 max-h-[70vh] translate-y-0 gap-3">
        <DialogHeader>
          <DialogTitle>{t("channels.searchRooms")}</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <SearchIcon aria-hidden className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2" />
          <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("channels.searchPlaceholder")} aria-label={t("channels.searchRooms")} className="ps-9" />
        </div>
        <div className="min-h-16 overflow-y-auto">
          {error ? (
            <p className="text-destructive py-4 text-sm">{error}</p>
          ) : items.length ? (
            <ul className="flex flex-col gap-1">
              {items.map((hit) => (
                <li key={hit.messageId}>
                  <button
                    type="button"
                    onClick={() => {
                      onJump(hit.messageId);
                      onOpenChange(false);
                    }}
                    className="hover:bg-muted w-full rounded-lg px-2 py-1.5 text-start text-sm"
                  >
                    <Snippet text={hit.snippet} />
                  </button>
                </li>
              ))}
            </ul>
          ) : query.trim() && !searching ? (
            <p className="text-muted-foreground py-4 text-sm">{t("channels.searchEmpty")}</p>
          ) : null}
          {cursor && (
            <div className="flex justify-center py-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  void api<{ items: ChannelSearchHit[]; nextCursor: string | null }>(`/channels/search?channelId=${encodeURIComponent(channelId)}&q=${encodeURIComponent(query)}&before=${encodeURIComponent(cursor)}`)
                    .then((page) => { setItems((current) => [...current, ...page.items]); setCursor(page.nextCursor); })
                    .catch(() => setError(t("channels.notFound")));
                }}
              >
                {t("channels.loadOlder")}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
