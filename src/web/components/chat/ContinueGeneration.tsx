import { useAui, useAuiState } from "@assistant-ui/react";
import { ArrowRightIcon, Loader2Icon, SquareIcon } from "lucide-react";
import { useCallback, useSyncExternalStore, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t, type PlainMessageKey } from "@/i18n";
import { api } from "@/lib/api";
import { useCommand } from "@/keyboard/registry";
import { isTemporaryChat } from "@/state/chat-privacy";
import { editedAtOf } from "@/state/message-edits";
import { useThreadSync } from "@/state/thread-sync";
import { storedMessagesEpoch, subscribeStoredMessages } from "@/runtime/message-persistence";
import { useThreadMetaStore } from "@/state/thread-meta";
import { appendContinuation, continueGate, generationInfo, hasUnresolvedTools } from "./continue-run";

/**
 * The explicit Continue row under a length-limited answer. It exists only for a server-recorded
 * `finished`/`length` receipt, never guesses from text, and never runs automatically.
 */
export function ContinueGeneration() {
  const aui = useAui();
  const remoteId = useAuiState((s) => s.threadListItem.remoteId ?? null);
  const messageId = useAuiState((s) => s.message.id);
  const metadata = useAuiState((s) => s.message.metadata);
  const parts = useAuiState((s) => s.message.parts);
  const isLatest = useAuiState((s) => s.thread.messages.at(-1)?.id === s.message.id);
  const running = useAuiState((s) => s.thread.isRunning);
  const hasDraft = useAuiState((s) => s.composer.text.trim().length > 0 || s.composer.attachments.length > 0);
  const syncing = useThreadSync() !== undefined;
  const temporary = isTemporaryChat(remoteId);
  // Re-render when the server acknowledges a stored message, so Continue waits for persistence.
  useSyncExternalStore(subscribeStoredMessages, storedMessagesEpoch, storedMessagesEpoch);
  const { generation, everEdited } = generationInfo(metadata);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gate = continueGate({
    threadId: remoteId,
    messageId,
    generation,
    unresolvedTools: hasUnresolvedTools(parts),
    isLatest,
    running,
    syncing,
    edited: !!remoteId && editedAtOf(remoteId, messageId) !== undefined,
    everEdited,
    stored: true,
    hasText: parts.some((part) => part.type === "text" && part.text.trim().length > 0),
    temporary,
  });

  const send = useCallback(() => {
    if (!gate.eligible) return;
    setError(null);
    setBusy(true);
    try {
      appendContinuation(aui, messageId);
    } catch {
      setError(t("generation.continueFailed"));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }, [aui, gate.eligible, messageId]);

  const request = () => {
    if (!gate.eligible) return;
    // A nonempty draft or attachments stays in the composer; the continuation user turn copies neither.
    if (hasDraft) setConfirming(true);
    else send();
  };

  useCommand("message.continue", request, gate.eligible);

  if (!generation) return null;
  if (generation.state === "waiting") {
    return (
      <div className="border-border/60 mt-2 flex flex-wrap items-center gap-2 border-t pt-2 text-sm">
        <span className="text-muted-foreground">{t("generation.waitingTools")}</span>
        <Button
          size="sm"
          variant="outline"
          className="pointer-coarse:min-h-11"
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api(`/threads/${remoteId}/generations/${generation.runId}/cancel`, { method: "POST", json: {} });
              if (remoteId) void useThreadMetaStore.getState().refresh(remoteId);
            } catch {
              setError(t("generation.continueFailed"));
            } finally {
              setBusy(false);
            }
          }}
        >
          <SquareIcon /> {t("generation.stopPending")}
        </Button>
        {error && <span role="alert" className="text-destructive">{error}</span>}
      </div>
    );
  }
  if (generation.state !== "finished" || generation.finishReason !== "length") return null;

  const reasonKey = gate.eligible ? null : (gate.reason as PlainMessageKey | undefined);
  return (
    <div className="border-border/60 mt-2 flex flex-col gap-1 border-t pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-sm">{t("generation.outputLimit")}</span>
        <Button
          size="sm"
          variant="outline"
          data-command="message.continue"
          aria-keyshortcuts={undefined}
          className="pointer-coarse:min-h-11 focus-visible:outline-ring"
          disabled={!gate.eligible || busy}
          aria-description={reasonKey ? t(reasonKey) : t("generation.continueHint")}
          onClick={request}
        >
          {busy ? <Loader2Icon className="animate-spin" /> : <ArrowRightIcon />} {t("generation.continue")}
        </Button>
        {reasonKey && <span className="text-muted-foreground text-xs">{t(reasonKey)}</span>}
      </div>
      <p className="text-muted-foreground text-xs">{t("generation.continueHint")}</p>
      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
      <Dialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">{t("generation.continueDraftTitle")}</DialogTitle>
            <DialogDescription>{t("generation.continueHint")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={send}>
              <ArrowRightIcon /> {t("generation.keepDraft")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
