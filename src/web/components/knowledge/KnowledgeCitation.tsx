import { ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KnowledgePassage } from "@shared/knowledge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { formatNumber } from "@/i18n/format";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useKnowledgeCitationStore } from "@/state/chat-knowledge";

/**
 * Opens the exact readable passage behind an inline citation or a knowledge tool card. Revalidation while
 * open is advisory for the UI (it cannot recall bytes a browser already holds): a failed check clears the
 * title, text, and source URL and shows a generic unavailable notice, never a stale passage.
 */
export function KnowledgeCitationHost() {
  const chunkId = useKnowledgeCitationStore((s) => s.chunkId);
  const close = useKnowledgeCitationStore((s) => s.close);
  // The result carries the chunk it answers, so a new chunk is loading on its first render, never "failed".
  const [result, setResult] = useState<{ chunkId: string; passage?: KnowledgePassage; failed?: boolean } | null>(null);
  const sequence = useRef(0);
  const current = result?.chunkId === chunkId ? result : null;
  const passage = current?.passage ?? null;
  const error = current?.failed ? t("knowledge.citationUnavailable") : null;
  const loading = !!chunkId && !current;

  const load = useCallback((id: string) => {
    const seq = ++sequence.current;
    return api<KnowledgePassage>(`/knowledge/chunks/${encodeURIComponent(id)}`)
      .then((value) => {
        if (seq === sequence.current && useKnowledgeCitationStore.getState().chunkId === id) {
          setResult({ chunkId: id, passage: value });
        }
      })
      .catch(() => {
        if (seq === sequence.current && useKnowledgeCitationStore.getState().chunkId === id) {
          // Clear the previous passage first; a revoked citation must not keep showing text or a URL.
          setResult({ chunkId: id, failed: true });
        }
      });
  }, []);

  useEffect(() => {
    if (!chunkId) {
      sequence.current += 1;
      setResult(null);
      return;
    }
    // A new selection clears the old passage before its own request can answer.
    setResult(null);
    void load(chunkId);
    // Account or selection changes invalidate an answer still in flight.
    return () => { sequence.current += 1; };
  }, [chunkId, load]);

  useEffect(() => {
    if (!chunkId) return;
    const revalidate = () => { if (useKnowledgeCitationStore.getState().chunkId === chunkId) void load(chunkId); };
    const timer = window.setInterval(revalidate, 2_000);
    const onVisible = () => { if (document.visibilityState === "visible") revalidate(); };
    const onFocus = () => revalidate();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [chunkId, load]);

  return (
    <Dialog open={!!chunkId} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[min(85vh,44rem)] gap-3 overflow-y-auto sm:max-w-2xl">
        <DialogTitle className="pe-6 text-base">{passage?.chunk.title ?? (error ? t("knowledge.unavailableCollection") : t("knowledge.citationTitle"))}</DialogTitle>
        {passage && (
          <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="text-foreground">{passage.source.name}</span>
            <span>{t("knowledge.citationOffset", { start: formatNumber(passage.chunk.start), end: formatNumber(passage.chunk.end) })}</span>
          </DialogDescription>
        )}
        {loading && <p role="status" className="text-muted-foreground text-sm">{t("knowledge.citationLoading")}</p>}
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        {!loading && !error && passage && (
          <>
            <pre className="bg-muted/50 max-w-full overflow-x-auto rounded-lg border p-3 text-sm leading-relaxed whitespace-pre-wrap break-words">{passage.chunk.text}</pre>
            <div className="flex flex-wrap justify-end gap-2">
              {passage.source.url ? (
                <a
                  href={passage.source.url}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                >
                  <ExternalLinkIcon /> {t("knowledge.sourcePage")}
                </a>
              ) : null}
              <Button variant="ghost" size="sm" onClick={close}>
                {t("common.close")}
              </Button>
            </div>
          </>
        )}
        {!loading && !error && !passage && chunkId ? <p className="text-muted-foreground text-sm">{t("knowledge.citationUnavailable")}</p> : null}
      </DialogContent>
    </Dialog>
  );
}
