import { ActionBarMorePrimitive, useAui, useAuiState } from "@assistant-ui/react";
import type { ThreadSummary } from "@shared/types";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { isTemporaryChat } from "@/state/chat-privacy";
import { useThreadMeta } from "@/state/thread-meta";
import { ModelList } from "./ModelPicker";

export function BranchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M6 3v18" />
      <path d="M6 7a8 8 0 0 0 8 8h1v6" />
      <path d="m12 18 3 3 3-3" />
    </svg>
  );
}

/** Forks waiting for their first answer, keyed by the new thread: the run starts once its history has loaded. */
const pendingRuns = new Map<string, string>();

/**
 * Forks the open chat into a new thread and switches to it. The source chat is never changed.
 * `upTo` is the last copied message; `run` answers it in the fork (it must then be a user message).
 */
async function branchChat(aui: ReturnType<typeof useAui>, upTo: string, run: boolean, modelRef?: string) {
  const { remoteId } = aui.threadListItem.getState();
  if (!remoteId) throw new Error("This chat is not saved yet.");
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
 * "Branch off" copies the conversation up to this message into a new chat. Choosing a model also forks,
 * then answers again with that model: from a user message it answers that message, from an assistant
 * message it replaces that answer.
 */
export function BranchMenu() {
  const aui = useAui();
  const role = useAuiState((s) => s.message.role);
  const temporary = useAuiState((s) => isTemporaryChat(s.threadListItem.remoteId ?? s.threadListItem.id));
  const hasModels = useData((s) => s.models.length > 0);
  const [open, setOpen] = useState(false);
  // The searchable model list opens in its own popover once the menu closes, anchored to the same button.
  const [picking, setPicking] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
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
    const user = role === "user";
    // A new answer from an assistant message starts at the user message it answered.
    const upTo = modelRef && !user ? message.parentId : message.id;
    if (!upTo) return;
    setError(null);
    void branchChat(aui, upTo, user || !!modelRef, modelRef).catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Could not branch. Try again."),
    );
  };

  return (
    <span ref={anchor} className="relative inline-flex">
      {/* Only for its interaction lock: a hover-revealed action bar stays mounted while the menu or an error shows. */}
      <ActionBarMorePrimitive.Root open={open || picking || !!error} onOpenChange={setOpen}>
        <Menu open={open} onOpenChange={(next) => setOpen(next)}>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Branch off"
                      data-command="message.branch"
                      className="aui-button-icon data-popup-open:bg-accent size-6 p-1 pointer-coarse:size-9 pointer-coarse:p-2"
                    />
                  }
                />
              }
            >
              <BranchIcon />
            </TooltipTrigger>
            <TooltipContent side="bottom">Branch off</TooltipContent>
          </Tooltip>
          <MenuContent align={role === "user" ? "end" : "start"} className="max-h-[min(32rem,var(--available-height))] w-56">
            <MenuItem onClick={() => branch()}>
              <BranchIcon />
              Branch off
            </MenuItem>
            {hasModels && (
              <MenuItem onClick={() => setPicking(true)}>
                <span className="min-w-0 flex-1 truncate">Switch model…</span>
                <ChevronRightIcon className="text-muted-foreground ms-auto" />
              </MenuItem>
            )}
          </MenuContent>
        </Menu>
      </ActionBarMorePrimitive.Root>
      <Popover open={picking} onOpenChange={setPicking}>
        <PopoverContent
          anchor={anchor}
          align={role === "user" ? "end" : "start"}
          className="flex max-h-[min(22rem,60dvh)] w-[min(20rem,calc(100vw-1rem))] flex-col p-0"
        >
          <ModelList
            compact
            value={null}
            onSelect={(ref) => {
              setPicking(false);
              branch(ref);
            }}
          />
        </PopoverContent>
      </Popover>
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
      <span className="text-muted-foreground text-xs">Branched from:</span>
      <button
        type="button"
        onClick={() => aui.threads.switchToThread(source.id)}
        className="text-muted-foreground hover:text-foreground hover:bg-muted -ms-2 flex max-w-full items-center gap-2 rounded-lg px-2 py-1 text-sm transition-colors duration-(--motion-fast) ease-out-quart"
      >
        <BranchIcon className="size-4 shrink-0" />
        <span className="truncate">{source.title ?? "Untitled chat"}</span>
      </button>
    </div>
  );
}
