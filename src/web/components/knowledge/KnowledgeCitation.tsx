import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { KnowledgePassage } from "@shared/knowledge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { formatNumber } from "@/i18n/format";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useKnowledgeCitationStore } from "@/state/chat-knowledge";

/** Opens the exact owned passage behind an inline citation or a knowledge tool card. */
export function KnowledgeCitationHost() {
  const chunkId = useKnowledgeCitationStore((s) => s.chunkId);
  const close = useKnowledgeCitationStore((s) => s.close);
  const [passage, setPassage] = useState<KnowledgePassage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!chunkId) return;
    let live = true;
    setLoading(true);
    setError(null);
    setPassage(null);
    api<KnowledgePassage>(`/knowledge/chunks/${encodeURIComponent(chunkId)}`)
      .then((result) => { if (live) setPassage(result); })
      .catch(() => { if (live) setError(t("knowledge.citationFailed")); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [chunkId]);

  return (
    <Dialog open={!!chunkId} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[min(85vh,44rem)] gap-3 overflow-y-auto sm:max-w-2xl">
        <DialogTitle className="pe-6 text-base">{passage?.chunk.title ?? t("knowledge.citationTitle")}</DialogTitle>
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
        {!loading && !error && !passage && chunkId ? <p className="text-muted-foreground text-sm">{t("knowledge.citationFailed")}</p> : null}
      </DialogContent>
    </Dialog>
  );
}
