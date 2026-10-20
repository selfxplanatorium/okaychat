import { useAui, useAuiState } from "@assistant-ui/react";
import { ChevronDownIcon, Loader2Icon, ShrinkIcon } from "lucide-react";
import { useState } from "react";
import type { CompactionState } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, formatCost, formatTokens } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useActiveModel, useData } from "@/state/data";
import { metadataOf, useContextUsage, useCurrentThreadId, useThreadMeta, useThreadMetaStore } from "@/state/thread-meta";
import { useChatPrivacy } from "@/state/chat-privacy";

function Ring({ fraction }: { fraction: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const fill = Math.max(0.02, Math.min(1, fraction));
  const tone = fraction > 0.85 ? "text-error" : fraction > 0.6 ? "text-warning" : "text-primary";
  return (
    <svg viewBox="0 0 18 18" className="size-4 -rotate-90" aria-hidden>
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" className="stroke-muted-foreground/20" stroke="currentColor" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        stroke="currentColor"
        // Dash offset instead of dash length: the ring fills without relayout.
        className={cn(tone, "transition-[color,stroke-dashoffset] duration-(--motion-slow) ease-out-quart")}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - fill)}
      />
    </svg>
  );
}

/** Context window fill, thread cost, cache hits, and manual compaction. */
export function ContextMeter() {
  const privacy = useChatPrivacy();
  const usage = useContextUsage();
  const meta = useThreadMeta();
  const model = useActiveModel();
  const threadId = useCurrentThreadId();
  const configuredAutoCompactAt = useData((s) => s.settings?.autoCompactAt ?? 0.8);
  const autoCompactAt = privacy.temporary ? 0 : configuredAutoCompactAt;
  const running = useAuiState((s) => s.thread.isRunning);
  const aui = useAui();
  const refresh = useThreadMetaStore((s) => s.refresh);
  const [compacting, setCompacting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const window = model?.context ?? usage?.window ?? 0;
  if (!window) return null;
  const tokens = usage?.tokens ?? 0;
  const fraction = tokens / window;
  const cacheRatio = meta?.usage?.input ? meta.usage.cacheRead / meta.usage.input : 0;

  const compactNow = async () => {
    if (!threadId || !model) return;
    setCompacting(true);
    setError(null);
    try {
      const messages = aui.thread.getState().messages.map((m) => ({
        id: m.id,
        role: m.role,
        parts: m.content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "text", text: `[${p.type}]` })),
        metadata: m.metadata,
      }));
      await api<CompactionState>(`/threads/${threadId}/compact`, { method: "POST", json: { messages, modelRef: model.ref } });
      await refresh(threadId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCompacting(false);
    }
  };

  return (
    <Popover>
      <PopoverTrigger
        className="hover:bg-muted text-muted-foreground hover:text-foreground aria-expanded:bg-muted flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs tabular-nums transition-colors duration-(--motion-fast) ease-out-quart"
        aria-label="Context usage"
      >
        <Ring fraction={fraction} />
        <span className="hidden sm:inline">{tokens ? `${Math.round(fraction * 100)}%` : formatTokens(window)}</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-72 p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-sm font-medium">Context window</span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatTokens(tokens)} / {formatTokens(window)}
          </span>
        </div>
        <div className="bg-muted relative mb-3 h-1.5 overflow-hidden rounded-full">
          <div
            className={cn("h-full origin-left rounded-full transition-[transform,background-color] duration-(--motion-slow) ease-out-quart", fraction > 0.85 ? "bg-error" : fraction > 0.6 ? "bg-warning" : "bg-primary")}
            style={{ width: "100%", transform: `scaleX(${Math.min(1, fraction)})` }}
          />
          {autoCompactAt > 0 && <div className="bg-foreground/40 absolute top-0 h-full w-px" style={{ left: `${autoCompactAt * 100}%` }} title="Auto-compact threshold" />}
        </div>
        <dl className="text-muted-foreground grid grid-cols-2 gap-y-1 text-xs">
          <dt>Thread cost</dt>
          <dd className="text-foreground text-right tabular-nums">{formatCost(meta?.usage?.cost ?? 0)}</dd>
          <dt>Tokens in / out</dt>
          <dd className="text-foreground text-right tabular-nums">
            {formatTokens(meta?.usage?.input ?? 0)} / {formatTokens(meta?.usage?.output ?? 0)}
          </dd>
          <dt>Cache hits</dt>
          <dd className="text-foreground text-right tabular-nums">{Math.round(cacheRatio * 100)}%</dd>
          <dt>Auto-compact</dt>
          <dd className="text-foreground text-right">{autoCompactAt > 0 ? `at ${Math.round(autoCompactAt * 100)}%` : "Off"}</dd>
        </dl>
        {meta?.compaction && (
          <p className="text-muted-foreground mt-2 text-xs">
            Compacted from {formatTokens(meta.compaction.tokensBefore)} tokens on {new Date(meta.compaction.createdAt).toLocaleString()}.
          </p>
        )}
        {error && <p className="text-error mt-2 text-xs">{error}</p>}
        {!privacy.temporary && <Button size="sm" variant="outline" className="mt-3 w-full" disabled={!threadId || running || compacting} onClick={compactNow}>
          {compacting ? <Loader2Icon className="animate-spin" /> : <ShrinkIcon />}
          {compacting ? "Summarizing…" : "Compact now"}
        </Button>}
      </PopoverContent>
    </Popover>
  );
}

/** Model, tokens, and cost under each assistant message. */
export function MessageMeta() {
  const raw = useAuiState((s) => s.message.metadata);
  const running = useAuiState((s) => s.message.status?.type === "running");
  const models = useData((s) => s.models);
  const meta = metadataOf(raw);
  if (running || !meta.modelRef) return null;
  const name = models.find((m) => m.ref === meta.modelRef)?.name ?? meta.modelRef.split("/").pop();
  const u = meta.usage;
  const cache = u?.input ? Math.round((u.cacheRead / u.input) * 100) : 0;
  return (
    <div className="text-muted-foreground/80 ms-auto flex items-center gap-2 pe-2 text-[11px] tabular-nums opacity-0 transition-opacity duration-(--motion-fast) delay-75 ease-out-quart [[data-role=assistant]:hover_&]:opacity-100">
      <span>{name}</span>
      {u && (
        <span title={`Input ${u.input} (cached ${u.cacheRead}, written ${u.cacheWrite}) · Output ${u.output} (reasoning ${u.reasoning})`}>
          {formatTokens(u.input)} in{cache ? ` (${cache}% cached)` : ""} · {formatTokens(u.output)} out
        </span>
      )}
      {meta.cost !== undefined && meta.cost > 0 && <span>{formatCost(meta.cost)}</span>}
      {meta.durationMs !== undefined && <span>{(meta.durationMs / 1000).toFixed(1)}s</span>}
    </div>
  );
}

/** Divider after the message where the conversation was compacted. */
export function CompactionMarker() {
  const messageId = useAuiState((s) => s.message.id);
  const meta = useThreadMeta();
  const [open, setOpen] = useState(false);
  if (!meta?.compaction || meta.compaction.boundaryMessageId !== messageId) return null;
  return (
    <div className="text-muted-foreground animate-fade-in my-2 px-2 text-xs">
      <button type="button" onClick={() => setOpen(!open)} className="hover:text-foreground flex w-full items-center gap-3 transition-colors duration-(--motion-fast) ease-out-quart">
        <span className="bg-border h-px flex-1" />
        <ShrinkIcon className="size-3.5" />
        Earlier messages summarized ({formatTokens(meta.compaction.tokensBefore)} tokens)
        <ChevronDownIcon className={cn("size-3.5 transition-transform duration-(--motion-base) ease-out-expo", open && "rotate-180")} />
        <span className="bg-border h-px flex-1" />
      </button>
      {open && <pre className="bg-muted/50 animate-rise-in mt-2 max-h-80 overflow-auto rounded-lg p-3 font-sans whitespace-pre-wrap">{meta.compaction.summary}</pre>}
    </div>
  );
}
