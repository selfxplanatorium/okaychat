import { useAuiState } from "@assistant-ui/react";
import { RotateCcwIcon, TriangleAlertIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { isAgentTarget } from "@shared/n8n-agents";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { t } from "@/i18n";
import { useCommand, runCommand } from "@/keyboard/registry";
import { cn } from "@/lib/utils";
import { isTemporaryChat } from "@/state/chat-privacy";
import { useUnavailableTargetRef } from "@/state/data";
import { metadataOf, useChatModel, useCurrentThreadId, useThreadMetaStore } from "@/state/thread-meta";
import { useThreadSync } from "@/state/thread-sync";
import { agentErrorText } from "@/components/agents/agent-error";

/**
 * The persistent line above the composer for an agent chat: what leaves okaychat, which memory mode is in
 * effect, and whether the remote session can be reset. Also the explicit unavailable state, which blocks
 * sending instead of quietly falling back to a language model.
 */
export function AgentNotice() {
  const threadId = useCurrentThreadId();
  const target = useChatModel();
  const unavailable = useUnavailableTargetRef(threadId);
  const running = useAuiState((s) => s.thread.isRunning);
  const sync = useThreadSync();
  const lastMetadata = useAuiState((s) => {
    for (let i = s.thread.messages.length - 1; i >= 0; i--) {
      const message = s.thread.messages[i]!;
      if (message.role === "assistant") return message.metadata;
    }
    return undefined;
  });
  const meta = metadataOf(lastMetadata).agent;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const agent = target && isAgentTarget(target) ? target : undefined;
  const temporary = !!threadId && isTemporaryChat(threadId);
  const canReset = !!agent && agent.memoryMode === "remote" && !!threadId && !temporary && !running && !sync;

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 6000);
    return () => clearTimeout(timer);
  }, [done]);

  const openReset = () => {
    if (!canReset) return;
    setError(null);
    setOpen(true);
  };
  useCommand("chat.resetAgentSession", openReset, canReset);

  const reset = async () => {
    if (!canReset || !agent || !threadId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/threads/${encodeURIComponent(threadId)}/agents/n8n/${encodeURIComponent(agent.id)}/session`, { method: "DELETE" });
      setDone(true);
      setOpen(false);
      void useThreadMetaStore.getState().refresh(threadId);
    } catch (failure) {
      setError(agentErrorText(failure).message);
    } finally {
      setBusy(false);
    }
  };

  if (unavailable) {
    return (
      <div role="note" className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-2.5 text-[11px]">
        <TriangleAlertIcon aria-hidden className="text-warning size-3.5 shrink-0" />
        <span className="font-medium text-foreground">{t("composer.agentUnavailable")}</span>
        <span className="min-w-0 wrap-break-word">{t("agents.unavailableHint")}</span>
        <button
          type="button"
          onClick={() => runCommand("composer.model")}
          className="text-primary focus-visible:ring-ring/50 rounded underline underline-offset-4 outline-none focus-visible:ring-2 pointer-coarse:min-h-11"
        >
          {t("agents.unavailable")}
        </button>
      </div>
    );
  }
  if (!agent) return null;

  const memory = temporary
    ? t("agents.temporaryRetention")
    : agent.memoryMode === "remote"
      ? t("agents.remoteRetention")
      : agent.memoryMode === "history"
        ? t("agents.historyRequiresWorkflow")
        : t("agents.memoryNoneHint");

  return (
    <>
      <div role="note" aria-live="polite" className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-2.5 text-[11px]">
        <WorkflowIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 wrap-break-word">{t("agents.capabilitiesNotice")}</span>
        <span aria-hidden className="text-border">·</span>
        <span className="min-w-0 wrap-break-word">{memory}</span>
        <span className="min-w-0 wrap-break-word">{t("agents.textOnlyHistory")}</span>
        {meta?.historyTruncated && <span className="text-warning min-w-0 wrap-break-word">{t("agents.historyTruncated")}</span>}
        {meta?.memoryReset && <span className="text-warning min-w-0 wrap-break-word">{t("agents.memoryResetNotice")}</span>}
        {done && <span className="text-success min-w-0 wrap-break-word">{t("agents.resetDone")}</span>}
        {canReset && (
          <button
            type="button"
            onClick={openReset}
            data-command="chat.resetAgentSession"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded underline underline-offset-4 outline-none transition-colors duration-(--motion-fast) focus-visible:ring-2 pointer-coarse:min-h-11"
          >
            <RotateCcwIcon aria-hidden className="size-3" /> {t("agents.remoteReset")}
          </button>
        )}
      </div>
      <Dialog open={open} onOpenChange={(next) => !next && !busy && setOpen(false)}>
        <DialogContent showCloseButton={!busy} className={cn("sm:max-w-md")}>
          <DialogHeader>
            <DialogTitle className="text-base">{t("agents.remoteResetTitle")}</DialogTitle>
            <DialogDescription>{t("agents.remoteResetBody")}</DialogDescription>
          </DialogHeader>
          {error && <p role="alert" className="text-destructive text-xs wrap-break-word">{error}</p>}
          <DialogFooter>
            <DialogClose type="button" disabled={busy} render={<Button variant="outline" className="min-h-10 pointer-coarse:min-h-11" />}>
              {t("agents.cancel")}
            </DialogClose>
            <Button type="button" disabled={busy} onClick={() => void reset()} data-command="chat.resetAgentSession" className="min-h-10 pointer-coarse:min-h-11">
              {t("agents.remoteReset")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
