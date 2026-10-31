import { ActionBarMorePrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { Repeat2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { t } from "@/i18n";
import { metadataOf } from "@/state/context-usage";
import { useData } from "@/state/data";
import { useThreadSync, useThreadSyncStore } from "@/state/thread-sync";
import { ModelList } from "./ModelPicker";
import { retryRun } from "./retry-run";

/**
 * Re-answers the assistant message in this chat with a chosen model. This is deliberately not the
 * branch menu: no `/threads/:id/branch` call and no thread switch, so the answer replaces the old one
 * as a sibling branch of the same user message. `message.parentId` is that user message.
 */
export function RetryWithModel({ inline = false }: { inline?: boolean }) {
  const aui = useAui();
  const role = useAuiState((s) => s.message.role);
  const parentId = useAuiState((s) => s.message.parentId);
  const messageMetadata = useAuiState((s) => s.message.metadata);
  const running = useAuiState((s) => s.thread.isRunning);
  const loading = useAuiState((s) => s.thread.isLoading);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const models = useData((s) => s.models);
  const selectModel = useData((s) => s.selectModel);
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

  // Retry with a model is an assistant action, and a cached or running chat must not start it.
  const blocked = !parentId || !!sync || running || loading || models.length === 0;
  const current = metadataOf(messageMetadata).modelRef;
  if (role !== "assistant") return null;

  const retry = (modelRef: string) => {
    // Re-read the live gates: a run can start while the picker is open.
    const blockedNow = blocked || aui.thread.getState().isRunning || !!useThreadSyncStore.getState().byId[remoteId ?? ""];
    const target = retryRun({ role, parentId }, modelRef, blockedNow);
    if (!target) return;
    setError(null);
    setOpen(false);
    // The model bridge resolves `config.modelName` from the live store when the request is built, so
    // selecting first makes the in-place run use the picked model rather than the previous one.
    selectModel(target.modelRef, remoteId);
    try {
      aui.thread.startRun({ parentId: target.parentId });
      setStatus(t("ux.retryingWith", { model: models.find((m) => m.ref === target.modelRef)?.name ?? target.modelRef }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("ux.retryModelFailed"));
    }
  };

  const trigger = inline ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-command="message.retryWithModel"
      aria-label={t("ux.retryWithModel")}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-disabled={blocked || undefined}
      disabled={blocked}
      onClick={() => !blocked && setOpen((value) => !value)}
      className="aria-expanded:bg-accent"
    >
      <Repeat2Icon aria-hidden />
      {t("errors.switchModel")}
    </Button>
  ) : (
    <TooltipIconButton
      tooltip={t("ux.retryWithModel")}
      command="message.retryWithModel"
      aria-label={t("ux.retryWithModel")}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-disabled={blocked || undefined}
      disabled={blocked}
      onClick={() => !blocked && setOpen((value) => !value)}
      className="aria-expanded:bg-accent"
    >
      <Repeat2Icon />
    </TooltipIconButton>
  );

  return (
    <span ref={anchor} className="relative inline-flex">
      {/* Only for its interaction lock: an older message's hover action bar stays mounted while this is open. */}
      {inline ? trigger : (
        <ActionBarMorePrimitive.Root open={open || !!error} onOpenChange={setOpen}>
          {trigger}
        </ActionBarMorePrimitive.Root>
      )}
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
