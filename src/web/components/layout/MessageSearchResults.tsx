import { useAui } from "@assistant-ui/react";
import { MessageSquareTextIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useData } from "@/state/data";

type Hit = { threadId: string; title: string | null; messageId: string; snippet: string };

/** Full-text matches inside messages, under the title matches of the sidebar search. */
export function MessageSearchResults({ query }: { query: string }) {
  const aui = useAui();
  const project = useData((s) => s.activeProject);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const q = query.trim();

  useEffect(() => {
    if (q.length < 2) return setHits(null);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q, ...(project ? { project } : {}) });
      api<Hit[]>(`/search?${params}`, { signal: controller.signal })
        .then(setHits)
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, project]);

  if (!hits) return null;
  return (
    <div className="mt-2">
      <div className="text-muted-foreground px-2.5 pt-2 pb-1 text-xs font-medium">In messages</div>
      {hits.length === 0 && <p className="text-muted-foreground px-2.5 py-1 text-sm">No messages match</p>}
      {hits.map((h) => (
        <button
          key={h.threadId}
          type="button"
          onClick={() => aui.threads.switchToThread(h.threadId)}
          className="hover:bg-sidebar-row-hover flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left"
        >
          <span className="flex items-center gap-1.5 truncate text-sm">
            <MessageSquareTextIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="truncate">{h.title ?? "New chat"}</span>
          </span>
          <span className="text-muted-foreground line-clamp-2 text-xs">
            {h.snippet.replace(/\*\*|__|`/g, "").split(/(\u0002[^\u0003]*\u0003)/).map((part, i) =>
              part.startsWith("\u0002") ? (
                <mark key={i} className="bg-primary/15 text-foreground rounded-sm px-0.5">
                  {part.slice(1, -1)}
                </mark>
              ) : (
                part
              ),
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
