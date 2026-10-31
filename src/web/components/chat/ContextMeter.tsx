import { useAui, useAuiState } from "@assistant-ui/react";
import { ChevronDownIcon, Loader2Icon, ScissorsIcon, ShrinkIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import type { CompactionState } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { t } from "@/i18n";
import { formatCost, formatDateTime, formatNumber, formatPercent, formatTokens } from "@/i18n/format";
import { settingsHref } from "@/lib/settings-link";
import { cn } from "@/lib/utils";
import { useCommand } from "@/keyboard/registry";
import { useData } from "@/state/data";
import { metadataOf, useContextUsage, useCurrentThreadId, useThreadMeta, useThreadMetaStore, useChatModel } from "@/state/thread-meta";
import { useChatPrivacy } from "@/state/chat-privacy";
import { useThreadSync, useThreadSyncStore } from "@/state/thread-sync";

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
  const meta = useThreadMeta();
  const usage = useContextUsage(meta?.compaction ?? null);
  const model = useChatModel();
  const threadId = useCurrentThreadId();
  const configuredAutoCompactAt = useData((s) => s.settings?.autoCompactAt ?? 0.8);
  const autoCompactAt = privacy.temporary ? 0 : configuredAutoCompactAt;
  const running = useAuiState((s) => s.thread.isRunning);
  const hasMessages = useAuiState((s) => s.thread.messages.length > 0);
  const sync = useThreadSync();
  const aui = useAui();
  const refresh = useThreadMetaStore((s) => s.refresh);
  const [open, setOpen] = useState(false);
  const [compacting, setCompacting] = useState<"summary" | "trim" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const window = model?.context ?? usage?.window ?? 0;
  const canCompact = !!window && !!threadId && !!model && hasMessages && !running && !compacting && !privacy.temporary && !sync;
  const canTrim = canCompact && hasMessages;

  const compactNow = async () => {
    if (!threadId || !model) return;
    if (aui.thread.getState().isRunning || useThreadSyncStore.getState().byId[threadId]) return;
    setCompacting("summary");
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
      // A command can run with the popover closed; open it so the failure is not silent.
      setOpen(true);
    } finally {
      setCompacting(null);
    }
  };

  const trimNow = async () => {
    const messageId = aui.thread.getState().messages.at(-1)?.id;
    if (!threadId || !messageId) return;
    if (aui.thread.getState().isRunning || useThreadSyncStore.getState().byId[threadId]) return;
    setCompacting("trim");
    setError(null);
    try {
      await api<CompactionState>(`/threads/${threadId}/trim`, { method: "POST", json: { messageId } });
      await refresh(threadId);
    } catch (e) {
      setError((e as Error).message);
      setOpen(true);
    } finally {
      setCompacting(null);
    }
  };

  const openContext = () => {
    setOpen(true);
    // From the command palette the popover opens while focus is still on the closing dialog; move it into the panel.
    requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-slot=context-popover]")?.focus());
  };
  useCommand("chat.openContext", openContext, !!window);
  useCommand("chat.compactNow", () => {
    if (!canCompact) return false;
    void compactNow();
  }, canCompact);
  useCommand("chat.trimContext", () => {
    if (!canTrim) return false;
    void trimNow();
  }, canTrim);

  if (!window) return null;
  const tokens = usage?.tokens ?? 0;
  const fraction = tokens / window;
  const cacheRatio = meta?.usage?.input ? meta.usage.cacheRead / meta.usage.input : 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-command="chat.openContext"
        className="hover:bg-muted text-muted-foreground hover:text-foreground aria-expanded:bg-muted flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs tabular-nums transition-colors duration-(--motion-fast) ease-out-quart"
        aria-label={t("composer.contextUsage")}
      >
        <Ring fraction={fraction} />
        <span className="hidden sm:inline">{tokens ? formatPercent(fraction) : formatTokens(window)}</span>
      </PopoverTrigger>
      <PopoverContent data-slot="context-popover" tabIndex={-1} side="top" align="end" className="w-72 p-3 outline-none">
        <span role="status" className="sr-only">
          {compacting ? t("composer.summarizing") : ""}
        </span>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-sm font-medium">{t("composer.contextWindowTitle")}</span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatTokens(tokens)} / {formatTokens(window)}
          </span>
        </div>
        <div className="bg-muted relative mb-3 h-1.5 overflow-hidden rounded-full">
          <div
            className={cn("h-full origin-left rounded-full transition-[transform,background-color] duration-(--motion-slow) ease-out-quart", fraction > 0.85 ? "bg-error" : fraction > 0.6 ? "bg-warning" : "bg-primary")}
            style={{ width: "100%", transform: `scaleX(${Math.min(1, fraction)})` }}
          />
          {autoCompactAt > 0 && <div className="bg-foreground/40 absolute top-0 h-full w-px" style={{ left: `${autoCompactAt * 100}%` }} title={t("composer.autoCompactThreshold")} />}
        </div>
        <dl className="text-muted-foreground grid grid-cols-2 gap-y-1 text-xs">
          <dt>{t("composer.threadCost")}</dt>
          <dd className="text-foreground text-right tabular-nums">{formatCost(meta?.usage?.cost ?? 0)}</dd>
          <dt>{t("composer.tokensInOut")}</dt>
          <dd className="text-foreground text-right tabular-nums">
            {formatTokens(meta?.usage?.input ?? 0)} / {formatTokens(meta?.usage?.output ?? 0)}
          </dd>
          <dt>{t("composer.cacheHits")}</dt>
          <dd className="text-foreground text-right tabular-nums">{formatPercent(cacheRatio)}</dd>
          <dt>{t("composer.autoCompact")}</dt>
          <dd className="text-foreground text-right">{autoCompactAt > 0 ? t("composer.autoCompactAt", { percent: formatPercent(autoCompactAt) }) : t("common.off")}</dd>
        </dl>
        <p className="text-muted-foreground mt-2 text-xs">{t("ux.contextCounted")}</p>
        <Link
          href={settingsHref("compaction")}
          data-command="settings.compaction"
          onClick={() => setOpen(false)}
          className="text-muted-foreground hover:text-foreground mt-2 inline-block text-xs underline underline-offset-4"
        >
          {t("ux.compactionSettings")}
        </Link>
        {meta?.compaction?.summary && (
          <p className="text-muted-foreground animate-fade-in mt-2 text-xs">
            {t("composer.compactedFrom", { tokens: formatTokens(meta.compaction.tokensBefore ?? 0), date: formatDateTime(meta.compaction.createdAt ?? 0) })}
          </p>
        )}
        {meta?.compaction?.trim && (
          <p className="text-muted-foreground animate-fade-in mt-2 text-xs">
            {t("composer.trimmedFrom", { before: formatTokens(meta.compaction.trim.tokensBefore), after: formatTokens(meta.compaction.trim.tokensAfter), date: formatDateTime(meta.compaction.trim.createdAt) })}
          </p>
        )}
        {error && <p className="text-error animate-fade-in mt-2 text-xs">{error}</p>}
        {!privacy.temporary && (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button size="sm" variant="outline" disabled={!canTrim} onClick={trimNow} title={t("composer.trimHint")} data-command="chat.trimContext">
                {/* The scissors stay mounted so the click's snip plays; they keep snipping while the trim runs. */}
                <ScissorsIcon className={cn(compacting === "trim" && "icon-snipping")} />
                {t("composer.trim")}
              </Button>
              <Button size="sm" variant="outline" disabled={!canCompact} onClick={compactNow} title={t("composer.summarizeHint")} data-command="chat.compactNow">
                {compacting === "summary" ? <Loader2Icon className="animate-spin" /> : <ShrinkIcon />}
                {compacting === "summary" ? t("composer.summarizing") : t("composer.summarize")}
              </Button>
            </div>
            <p className="text-muted-foreground mt-2 text-xs">{t("composer.compactWarning")}</p>
          </>
        )}
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
  const cache = u?.input ? u.cacheRead / u.input : 0;
  return (
    <div className="text-muted-foreground/80 ms-auto flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap pe-2 text-[11px] tabular-nums opacity-0 transition-opacity duration-(--motion-fast) delay-75 ease-out-quart [[data-role=assistant]:hover_&]:opacity-100">
      <span>{name}</span>
      {u && (
        <span title={t("composer.usageDetail", { input: formatNumber(u.input), cached: formatNumber(u.cacheRead), written: formatNumber(u.cacheWrite), output: formatNumber(u.output), reasoning: formatNumber(u.reasoning) })}>
          {cache ? t("composer.usageCached", { input: formatTokens(u.input), percent: formatPercent(cache), output: formatTokens(u.output) }) : t("composer.usage", { input: formatTokens(u.input), output: formatTokens(u.output) })}
        </span>
      )}
      {meta.cost !== undefined && meta.cost > 0 && <span>{formatCost(meta.cost)}</span>}
      {meta.durationMs !== undefined && <span>{t("composer.seconds", { n: formatNumber(meta.durationMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</span>}
    </div>
  );
}

/** Divider after the message where the conversation was compacted or trimmed. */
export function CompactionMarker() {
  const messageId = useAuiState((s) => s.message.id);
  const threadId = useCurrentThreadId();
  // A primitive, so a metadata update re-renders only the marker it concerns, not one per message.
  const kind = useThreadMetaStore((s) => {
    const compaction = threadId ? s.byId[threadId]?.compaction : undefined;
    if (compaction?.trim?.throughMessageId === messageId) return "trim";
    return compaction?.summary && compaction.boundaryMessageId === messageId ? "summary" : null;
  });
  return kind ? <CompactionDivider kind={kind} /> : null;
}

function CompactionDivider({ kind }: { kind: "trim" | "summary" }) {
  const meta = useThreadMeta();
  const [open, setOpen] = useState(false);
  const trim = meta?.compaction?.trim;
  if (kind === "trim" && trim) {
    return (
      <div className="text-muted-foreground animate-fade-in my-2 flex items-center gap-3 px-2 text-xs">
        <span className="bg-border h-px flex-1" />
        <ScissorsIcon className="size-3.5" />
        {t("composer.trimMarker", { before: formatTokens(trim.tokensBefore), after: formatTokens(trim.tokensAfter) })}
        <span className="bg-border h-px flex-1" />
      </div>
    );
  }
  if (!meta?.compaction?.summary) return null;
  return (
    <div className="text-muted-foreground animate-fade-in my-2 px-2 text-xs">
      <button type="button" onClick={() => setOpen(!open)} className="hover:text-foreground flex w-full items-center gap-3 transition-colors duration-(--motion-fast) ease-out-quart">
        <span className="bg-border h-px flex-1" />
        <ShrinkIcon className="size-3.5" />
        {t("composer.summaryMarker", { tokens: formatTokens(meta.compaction.tokensBefore ?? 0) })}
        <ChevronDownIcon className={cn("size-3.5 transition-transform duration-(--motion-base) ease-out-expo", open && "rotate-180")} />
        <span className="bg-border h-px flex-1" />
      </button>
      {open && <pre className="bg-muted/50 animate-rise-in mt-2 max-h-80 overflow-auto rounded-lg p-3 font-sans whitespace-pre-wrap">{meta.compaction.summary}</pre>}
    </div>
  );
}
