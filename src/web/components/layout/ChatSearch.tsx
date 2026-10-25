import { useAui } from "@assistant-ui/react";
import { Loader2Icon, MessageSquareIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import type { ThreadSummary } from "@shared/types";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useData } from "@/state/data";
import { dialogReturnFocus } from "@/keyboard/registry";

type Hit = { threadId: string; title: string | null; messageId: string; snippet: string };

export function ChatSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const aui = useAui();
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [hits, setHits] = useState<Hit[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [messageLoading, setMessageLoading] = useState(false);
  const loading = recentLoading || messageLoading;
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const results = useRef<HTMLDivElement>(null);
  const q = query.trim();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setQuery("");
    setThreads([]);
    setError(null);
    setRecentLoading(true);
    api<ThreadSummary[]>("/threads", { signal: controller.signal }).then(setThreads, () => {
      if (!controller.signal.aborted) setError("Could not load chats. Close search and try again.");
    }).finally(() => { if (!controller.signal.aborted) setRecentLoading(false); });
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    setHits([]);
    setMessageLoading(false);
    setSelected(0);
    if (!open || q.length < 2) return;
    const controller = new AbortController();
    setMessageLoading(true);
    const timer = setTimeout(() => {
      setError(null);
      api<Hit[]>(`/search?${new URLSearchParams({ q })}`, { signal: controller.signal }).then(setHits, () => {
        if (!controller.signal.aborted) setError("Could not search messages. Try again.");
      }).finally(() => { if (!controller.signal.aborted) setMessageLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, q]);

  const titles = threads.filter((t) => (q || t.status === "regular") && (t.title ?? "New chat").toLowerCase().includes(q.toLowerCase())).slice(0, 20);
  const titleIds = new Set(titles.map((t) => t.id));
  const rows = [
    ...titles.map((t) => ({ id: t.id, title: t.title, snippet: undefined as string | undefined })),
    ...hits.filter((h) => !titleIds.has(h.threadId)).map((h) => ({ id: h.threadId, title: h.title, snippet: h.snippet })),
  ];
  const choose = async (id: string) => {
    try {
      // Search spans projects. Clear the sidebar filter before opening a result.
      if (useData.getState().activeProject) {
        useData.getState().setActiveProject(null);
        await aui.threads.reload();
      }
      await aui.threads.switchToThread(id);
      navigate("/");
      onOpenChange(false);
    } catch { setError("Could not open this chat. Try again."); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl" showCloseButton={false} finalFocus={dialogReturnFocus}>
        <DialogTitle className="sr-only">Search chats</DialogTitle>
        <DialogDescription className="sr-only">Search chat titles and messages across all projects. Use arrow keys to choose a chat and Enter to open it.</DialogDescription>
        <div className="border-border flex items-center gap-3 border-b px-5 py-4">
          <SearchIcon aria-hidden className="text-muted-foreground size-5 shrink-0" />
          <input
            autoFocus
            aria-label="Search chats"
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-activedescendant={rows[selected] ? `chat-search-result-${selected}` : undefined}
            aria-controls="chat-search-results"
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-base outline-none"
            placeholder="Search chats…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const next = Math.max(0, Math.min(rows.length - 1, selected + (e.key === "ArrowDown" ? 1 : -1)));
                setSelected(next);
                results.current?.querySelectorAll("button")[next]?.scrollIntoView({ block: "nearest" });
              } else if (e.key === "Enter" && rows[selected]) {
                e.preventDefault();
                void choose(rows[selected].id);
              }
            }}
          />
          <button type="button" aria-label="Close search" onClick={() => onOpenChange(false)} className="text-muted-foreground hover:text-foreground rounded border px-1.5 py-1 text-xs">Esc</button>
        </div>
        <div ref={results} id="chat-search-results" role="listbox" aria-label="Chats" className="max-h-[min(55dvh,28rem)] overflow-y-auto p-2">
          <p className="text-muted-foreground px-3 pt-2 pb-2 text-xs">{q ? "Matching chats" : "Recent chats"}</p>
          {rows.map((row, index) => (
            <button key={row.id} id={`chat-search-result-${index}`} role="option" aria-selected={selected === index} type="button" onClick={() => void choose(row.id)} onFocus={() => setSelected(index)} onMouseMove={() => setSelected(index)} className={`focus-visible:outline-ring flex min-h-11 w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left text-sm ${selected === index ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}>
              <MessageSquareIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate">{row.title ?? "New chat"}</span>
                {row.snippet && <span className="text-muted-foreground mt-1 line-clamp-2 text-xs">{row.snippet.split(/(\u0002[^\u0003]*\u0003)/).map((part, i) => part.startsWith("\u0002") ? <mark key={i} className="bg-primary/15 text-foreground rounded-sm">{part.slice(1, -1)}</mark> : part)}</span>}
              </span>
            </button>
          ))}
          {loading && <p role="status" className="text-muted-foreground flex items-center gap-2 px-3 py-4 text-sm"><Loader2Icon className="size-4 animate-spin" /> Searching…</p>}
          {error && <p role="alert" className="text-destructive px-3 py-4 text-sm">{error}</p>}
          {!loading && !error && rows.length === 0 && <p role="status" className="text-muted-foreground px-3 py-6 text-sm">{q ? "No chats found. Try another word." : "Your chats will appear here."}</p>}
        </div>
        <div className="text-muted-foreground border-border border-t px-5 py-3 text-xs">↑ ↓ to choose · Enter to open · Esc to close</div>
      </DialogContent>
    </Dialog>
  );
}
