import { ActionBarMorePrimitive, useAui, useAuiState } from "@assistant-ui/react";
import type { ThreadSummary } from "@shared/types";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { isTemporaryChat } from "@/state/chat-privacy";
import { useThreadMeta } from "@/state/thread-meta";
import { ModelMenuItems } from "./ModelMenuItems";
import { BranchIcon } from "./branch-icon";
import { branchPoint } from "./branch-point";

/** Forks waiting for their first answer, keyed by the new thread: the run starts once its history has loaded. */
const pendingRuns = new Map<string, string>();

/**
 * Forks the open chat into a new thread and switches to it. The source chat is never changed.
 * `upTo` is the last copied message; `run` answers it in the fork (it must then be a user message).
 */
async function branchChat(aui: ReturnType<typeof useAui>, upTo: string, run: boolean, modelRef?: string) {
  const { remoteId } = aui.threadListItem.getState();
  if (!remoteId) throw new Error(t("composer.chatNotSaved"));
  const thread = await api<ThreadSummary>(`/threads/${remoteId}/branch`, { method: "POST", json: { messageId: upTo, modelRef } });
  if (thread.modelRef) useData.setState((s) => ({ threadModels: { ...s.threadModels, [thread.id]: thread.modelRef! } }));
  if (run) pendingRuns.set(thread.id, upTo);
  await aui.threads.reload();
  aui.threads.switchToThread(thread.id);
}

/** Starts a fork's pending answer once the fork's history ends at the message it answers. */
export function PendingBranchRun() {
  const aui = useAui();
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const loading = useAuiState((s) => s.thread.isLoading);
  const lastId = useAuiState((s) => s.thread.messages.at(-1)?.id);
  useEffect(() => {
    const parentId = remoteId ? pendingRuns.get(remoteId) : undefined;
    if (!remoteId || !parentId || loading || lastId !== parentId) return;
    pendingRuns.delete(remoteId);
    aui.thread.startRun({ parentId });
  }, [aui, remoteId, loading, lastId]);
  return null;
}

/**
 * Copies through this message with the chosen model. Only a user-message fork starts an answer;
 * an assistant-message fork keeps the reply and leaves the new model ready for the next message.
 */
export function BranchMenu() {
  const aui = useAui();
  const role = useAuiState((s) => s.message.role);
  const temporary = useAuiState((s) => isTemporaryChat(s.threadListItem.remoteId ?? s.threadListItem.id));
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(timer);
  }, [error]);

  // Temporary chats have no stored history to fork.
  if (temporary) return null;

  const branch = (modelRef?: string) => {
    const message = aui.message.getState();
    const point = branchPoint(message);
    if (!point) return;
    setError(null);
    void branchChat(aui, point.messageId, point.run, modelRef).catch((cause) =>
      setError(cause instanceof Error ? cause.message : t("composer.branchFailed")),
    );
  };

  return (
    <span className="relative inline-flex">
      {/* Only for its interaction lock: a hover-revealed action bar stays mounted while the menu or an error shows. */}
      <ActionBarMorePrimitive.Root open={open || !!error} onOpenChange={setOpen}>
        <Menu open={open} onOpenChange={(next) => setOpen(next)}>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("composer.branchOff")}
                      data-command="message.branch"
                      className="aui-button-icon data-popup-open:bg-accent size-6 p-1 pointer-coarse:size-9 pointer-coarse:p-2"
                    />
                  }
                />
              }
            >
              <BranchIcon />
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("composer.branchOff")}</TooltipContent>
          </Tooltip>
          <MenuContent align={role === "user" ? "end" : "start"} className="max-h-[min(32rem,var(--available-height))] w-56">
            <MenuItem onClick={() => branch()}>
              <BranchIcon />
              {t("composer.branchOff")}
            </MenuItem>
            <ModelMenuItems onSelect={branch} />
          </MenuContent>
        </Menu>
      </ActionBarMorePrimitive.Root>
      {error && (
        <span role="alert" className={cn("text-destructive absolute top-full mt-1 w-max max-w-64 text-xs", role === "user" ? "end-0" : "start-0")}>
          {error}
        </span>
      )}
    </span>
  );
}

/** Links a fork back to the chat it came from. */
export function BranchedFromBanner() {
  const aui = useAui();
  const source = useThreadMeta()?.branchedFrom;
  if (!source) return null;
  return (
    <div data-slot="aui_branched-from" className="mb-6 flex flex-col items-start gap-1 px-2">
      <span className="text-muted-foreground text-xs">{t("composer.branchedFrom")}</span>
      <button
        type="button"
        onClick={() => aui.threads.switchToThread(source.id)}
        className="text-muted-foreground hover:text-foreground hover:bg-muted -ms-2 flex max-w-full items-center gap-2 rounded-lg px-2 py-1 text-sm transition-colors duration-(--motion-fast) ease-out-quart"
      >
        <BranchIcon className="size-4 shrink-0" />
        <span className="truncate">{source.title ?? t("composer.untitledChat")}</span>
      </button>
    </div>
  );
}
