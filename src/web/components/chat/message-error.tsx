import { useAui, useAuiState } from "@assistant-ui/react";
import { CheckIcon, CircleAlertIcon, CopyIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { t } from "@/i18n";
import { parseChatError } from "@/lib/api";
import { errorDetails, presentError } from "@/lib/error-presentation";
import { settingsHref, type SettingsDestinationId } from "@/lib/settings-link";
import { useThreadSync, useThreadSyncStore } from "@/state/thread-sync";
import { RetryWithModel } from "./retry-model";

const SETTINGS_COMMAND: Partial<Record<SettingsDestinationId, string>> = {
  providers: "settings.providers",
  account: "settings.account",
  compaction: "settings.compaction",
};

/**
 * The assistant-visible failure block. It is never the raw provider text: the stream carried the
 * taxonomy wire shape, and every action here has a keyboard command.
 */
export function ChatErrorMessage() {
  const aui = useAui();
  const role = useAuiState((s) => s.message.role);
  const parentId = useAuiState((s) => s.message.parentId);
  const statusType = useAuiState((s) => s.message.status?.type);
  const reason = useAuiState((s) => (s.message.status?.type === "incomplete" ? s.message.status.reason : undefined));
  const error = useAuiState((s) => (s.message.status?.type === "incomplete" ? s.message.status.error : undefined));
  const running = useAuiState((s) => s.thread.isRunning);
  const loading = useAuiState((s) => s.thread.isLoading);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const sync = useThreadSync();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const [actionError, setActionError] = useState<string | null>(null);

  if (role !== "assistant" || statusType !== "incomplete" || reason !== "error") return null;
  const wire = parseChatError(error);
  const presentation = presentError(wire, "chat");
  const blocked = !parentId || running || loading || !!sync;
  const settings = presentation.actions.settings;

  const retry = () => {
    if (blocked || !parentId) return;
    const blockedNow = aui.thread.getState().isRunning || !!useThreadSyncStore.getState().byId[remoteId ?? ""];
    if (blockedNow) return;
    setActionError(null);
    try {
      aui.thread.startRun({ parentId });
    } catch (cause) {
      setActionError(parseChatError(cause).message);
    }
  };

  return (
    <div
      data-slot="aui_chat-error"
      className="border-destructive/40 bg-destructive/10 mt-2 flex flex-col gap-2 rounded-xl border p-3 text-sm"
    >
      <div className="flex min-w-0 items-start gap-2">
        <CircleAlertIcon aria-hidden className="text-destructive mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p role="alert" className="text-foreground font-medium wrap-break-word">{t(presentation.messageKey)}</p>
          <p className="text-muted-foreground text-xs wrap-break-word">{t(presentation.hintKey)}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {presentation.actions.retry && (
          <Button
            type="button"
            size="sm"
            data-command="message.retry"
            aria-disabled={blocked || undefined}
            disabled={blocked}
            onClick={retry}
            className="pointer-coarse:h-9"
          >
            {t("errors.retry")}
          </Button>
        )}
        {presentation.actions.switchModel && <RetryWithModel inline />}
        {settings && (
          <Link
            href={settingsHref(settings)}
            data-command={SETTINGS_COMMAND[settings]}
            className="focus-visible:border-ring focus-visible:ring-ring/50 border-border bg-muted/70 text-foreground hover:bg-muted inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[0.8rem] font-medium whitespace-nowrap outline-none focus-visible:ring-1 pointer-coarse:h-9"
          >
            <SettingsIcon aria-hidden className="size-3.5" />
            {t("errors.openSetting")}
          </Link>
        )}
        {presentation.actions.copyDetails && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-command="error.copyDetails"
            onClick={() => copyToClipboard(errorDetails(wire))}
            className="pointer-coarse:h-9"
          >
            {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            {isCopied ? t("errors.detailsCopied") : t("errors.copyDetails")}
          </Button>
        )}
      </div>
      {wire.ref && <p className="text-muted-foreground font-mono text-xs break-all">{t("errors.reference", { ref: wire.ref })}</p>}
      {actionError && <p role="alert" className="text-destructive text-xs">{actionError}</p>}
    </div>
  );
}
