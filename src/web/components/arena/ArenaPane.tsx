import { useEffect, useRef } from "react";
import { CopyIcon, Loader2Icon } from "lucide-react";
import type { ArenaPaneState, ArenaSide, BlindPane, RevealedPane } from "@shared/arena";
import { Button } from "@/components/ui/button";
import { SimpleMarkdown } from "@/components/ui/simple-markdown";
import { t, type PlainMessageKey } from "@/i18n";
import { cn } from "@/lib/utils";

const STATUS: Record<ArenaPaneState, PlainMessageKey> = {
  running: "arena.answerStarting",
  done: "arena.answerComplete",
  failed: "arena.answerFailed",
  cancelled: "arena.answerCancelled",
  interrupted: "arena.answerInterrupted",
};

/** Arena answers are model-authored text: no remote images, and no chat artifact or tool renderers. */
export function arenaMarkdown(text: string): string {
  // Drop every image node but keep its alt text, so a model cannot pull a remote image into an answer.
  return text
    .replace(/!\[([^\]]*)\]\((?:[^()\\]|\\.)*\)/g, (_match, alt: string) => alt.trim())
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, (_match, alt: string) => alt.trim());
}

function statusKey(pane: BlindPane): PlainMessageKey {
  if (pane.state === "running") return pane.text ? "arena.answerWriting" : "arena.answerStarting";
  return STATUS[pane.state];
}

/**
 * One identical Arena column. Only the fixed A/B label and the status differ while blind; after a vote the
 * model label joins the same header and the text stays in place. No provider, price, or reasoning metadata is
 * rendered before the server says the pair is revealed.
 */
export function ArenaPane({
  pane,
  side,
  model,
  expired,
  copied,
  onCopy,
}: {
  pane: BlindPane;
  side: ArenaSide;
  model?: RevealedPane["model"];
  expired: boolean;
  copied: boolean;
  onCopy: (side: ArenaSide) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const heading = side === "A" ? t("arena.answerA") : t("arena.answerB");
  const running = pane.state === "running";
  const limit = pane.finish === "length";
  const hasText = pane.text.trim().length > 0;

  // A reader who scrolled up must stay there; a fresh answer starts at its top.
  useEffect(() => {
    if (body.current && pane.text.length === 0) body.current.scrollTop = 0;
  }, [pane.text.length]);

  return (
    <section
      aria-label={model ? `${heading}: ${model.label}` : heading}
      tabIndex={0}
      className="border-border bg-card focus-visible:outline-ring flex min-w-0 flex-col rounded-xl border shadow-[var(--depth-highlight)] outline-none lg:min-h-0"
    >
      <header className="border-border flex min-w-0 items-center gap-2 border-b px-3 py-2.5">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {heading}
          {model && <span className="text-muted-foreground font-normal"> · {model.label}</span>}
        </h2>
        <span
          role="status"
          aria-live="polite"
          className={cn("text-muted-foreground flex shrink-0 items-center gap-1 text-xs", running && "text-foreground")}
        >
          {running && <Loader2Icon aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />}
          {pane.state === "done" && limit ? t("arena.answerComplete") : t(statusKey(pane))}
        </span>
      </header>
      <div
        ref={body}
        className="min-h-0 flex-1 px-3 py-3 lg:overflow-y-auto"
        // Status changes announce; token deltas do not.
        aria-live="off"
      >
        {expired && !hasText ? (
          <p className="text-muted-foreground text-sm">{t("arena.answerExpired")}</p>
        ) : (
          <>
            {pane.state === "failed" && (
              <p role="alert" className="text-destructive mb-2 text-xs">
                {t("arena.answerFailed")}
              </p>
            )}
            {hasText ? (
              <SimpleMarkdown imagePolicy="none" className="text-sm">{arenaMarkdown(pane.text)}</SimpleMarkdown>
            ) : pane.state !== "running" ? (
              <p className="text-muted-foreground text-sm">{t("arena.answerEmpty")}</p>
            ) : (
              <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <Loader2Icon aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />
                {pane.text ? t("arena.answerWriting") : t("arena.answerStarting")}
              </p>
            )}
            {limit && (
              <p className="text-muted-foreground mt-2 text-xs">{t("arena.answerLimit")}</p>
            )}
          </>
        )}
      </div>
      <footer className="border-border flex items-center gap-1 border-t px-2 py-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="pointer-coarse:min-h-11"
          disabled={!hasText}
          data-command={side === "A" ? "arena.copyA" : "arena.copyB"}
          onClick={() => onCopy(side)}
        >
          <CopyIcon />
          {copied ? t("arena.copied") : side === "A" ? t("arena.copyA") : t("arena.copyB")}
        </Button>
      </footer>
    </section>
  );
}
