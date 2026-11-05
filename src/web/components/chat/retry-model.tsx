import { ActionBarMorePrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { RefreshCwIcon, Repeat2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { t } from "@/i18n";
import { isAgentTarget } from "@shared/n8n-agents";
import { metadataOf } from "@/state/context-usage";
import { useData } from "@/state/data";
import { useChatModel } from "@/state/thread-meta";
import { useThreadSync, useThreadSyncStore } from "@/state/thread-sync";
import { ModelList } from "./ModelPicker";
import { retryParentId, retryRun } from "./retry-run";
import { ModelMenuItems } from "./ModelMenuItems";

/**
 * Re-answers a user message in this chat, directly or through its assistant reply. Model choices
 * update the current chat; the previous answer remains available as a sibling branch.
 */
export function RetryWithModel({ inline = false }: { inline?: boolean }) {
  const aui = useAui();
  const id = useAuiState((s) => s.message.id);
  const role = useAuiState((s) => s.message.role);
  const parentId = useAuiState((s) => s.message.parentId);
  const messageMetadata = useAuiState((s) => s.message.metadata);
  const running = useAuiState((s) => s.thread.isRunning);
  const loading = useAuiState((s) => s.thread.isLoading);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const models = useData((s) => s.models);
  const selectModel = useData((s) => s.selectModel);
  const activeTarget = useChatModel();
  const agentTarget = !!activeTarget && isAgentTarget(activeTarget);
  const sync = useThreadSync();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(timer);
  }, [error]);
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 6000);
    return () => clearTimeout(timer);
  }, [status]);

  const retryParent = retryParentId({ id, role, parentId });
  const blocked = !retryParent || !!sync || running || loading;
  const current = metadataOf(messageMetadata).modelRef;
  if (role !== "assistant" && (inline || role !== "user")) return null;

  const retry = (modelRef?: string) => {
    // Re-read the live gates: a run can start while the picker is open.
    const thread = aui.thread.getState();
    const blockedNow = blocked || thread.isRunning || thread.isLoading || !!useThreadSyncStore.getState().byId[remoteId ?? ""];
    const message = aui.message.getState();
    const target = modelRef ? retryRun(message, modelRef, blockedNow) : null;
    const runParent = modelRef ? target?.parentId : retryParentId(message);
    if (blockedNow || !runParent || (modelRef && !target)) return;
    setError(null);
    setOpen(false);
    // The model bridge resolves `config.modelName` from the live store when the request is built, so
    // selecting first makes the in-place run use the picked model rather than the previous one.
    if (target) selectModel(target.modelRef, remoteId);
    try {
      aui.thread.startRun({ parentId: runParent });
      setStatus(target ? t("ux.retryingWith", { model: models.find((m) => m.ref === target.modelRef)?.name ?? target.modelRef }) : t("common.retry"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("ux.retryModelFailed"));
    }
  };

  const trigger = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-command="message.retryWithModel"
      aria-label={t("ux.retryWithModel")}
      aria-haspopup="dialog"
      aria-expanded={open}
      disabled={blocked || models.length === 0}
      onClick={() => setOpen((value) => !value)}
      className="aria-expanded:bg-accent pointer-coarse:h-9"
    >
      <Repeat2Icon aria-hidden />
      {t("errors.switchModel")}
    </Button>
  );

  return (
    <span ref={anchor} className="relative inline-flex">
      {/* Only for its interaction lock: an older message's hover action bar stays mounted while this is open. */}
      {inline ? (
        <>
          {trigger}
          <Popover open={open} onOpenChange={(next) => (!next || !blocked) && setOpen(next)}>
            <PopoverContent
              anchor={anchor}
              side="bottom"
              align="start"
              className="flex max-h-[min(22rem,60dvh)] w-[min(20rem,calc(100vw-1rem))] flex-col p-0"
            >
              <p className="text-muted-foreground border-border border-b px-3 py-2 text-xs">{t("ux.retryWithModelHint")}</p>
              <ModelList compact value={current} onSelect={retry} />
            </PopoverContent>
          </Popover>
        </>
      ) : (
        <ActionBarMorePrimitive.Root open={open || !!error} onOpenChange={setOpen}>
          <Menu open={open} onOpenChange={setOpen}>
            <MenuTrigger render={
              <TooltipIconButton tooltip={t("common.retry")} command="message.retry" disabled={blocked} className="data-popup-open:bg-accent" />
            }>
              <RefreshCwIcon />
            </MenuTrigger>
            <MenuContent align={role === "user" ? "end" : "start"} className="max-h-[min(32rem,var(--available-height))] w-56">
              {agentTarget && <p className="text-muted-foreground border-b px-2.5 py-2 text-xs text-pretty">{t("agents.retryWarning")}</p>}
              <MenuItem disabled={blocked} onClick={() => retry()}>
                <RefreshCwIcon />
                {t("common.retry")}
              </MenuItem>
              <ModelMenuItems onSelect={retry} />
            </MenuContent>
          </Menu>
        </ActionBarMorePrimitive.Root>
      )}
      <span role="status" className="sr-only">
        {status}
      </span>
      {error && (
        <span role="alert" className={inline ? "text-destructive mt-1 block w-full text-xs" : "text-destructive absolute start-0 top-full mt-1 w-max max-w-64 text-xs"}>
          {error}
        </span>
      )}
    </span>
  );
}

/** The toolbar has one retry trigger; its menu includes the current model and provider choices. */
export function RetryMenu() {
  return <RetryWithModel />;
}
