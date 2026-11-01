import { useAui, useAuiState } from "@assistant-ui/react";
import { AudioLinesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect } from "react";
import { t } from "@/i18n";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useThreadSync } from "@/state/thread-sync";
import { callBlock } from "./guard";
import { FAILURE_TEXT } from "./messages";
import { useCall } from "./store";

/** Shared entry-point state. Visible when an engine is configured, even if it is temporarily down: the call view
 * explains the failure and offers Retry, which re-probes the worker. */
export function useCallEntry() {
  const aui = useAui();
  const availability = useCall((s) => s.availability);
  const availabilityError = useCall((s) => s.availabilityError);
  const open = useCall((s) => s.open);
  // Subscribe to the states the guard reads, or a change would not re-render this button.
  useThreadSync();
  useAuiState((s) => s.thread.isRunning);
  useAuiState((s) => s.thread.isLoading);
  useAuiState((s) => s.composer.dictation != null);
  useEffect(() => {
    if (useCall.getState().availability === null) void useCall.getState().loadAvailability();
  }, []);
  const blocked = callBlock(aui);
  // Show the entry point when an engine works or when a configured worker is only temporarily down; the view's
  // Retry re-probes it. A server with voice not configured at all still hides the button.
  const workerCode = availability?.localReason?.code;
  const recoverableWorker = workerCode === "worker" || workerCode === "workerVersion";
  const configured = !!availability && (availability.local || availability.realtime || recoverableWorker);
  // An availability failure still offers the button: the call view explains it and can retry.
  return { available: availabilityError || configured, blocked, open };
}

/** The same guarded action is shared by the composer, chat options, and transcript footer. */
export function CallButton({ placement = "composer", onOpen }: {
  placement?: "composer" | "options" | "continue";
  onOpen?: () => void;
}) {
  const { available, blocked, open } = useCallEntry();
  if (!available) return null;
  const tooltip = blocked ? t(FAILURE_TEXT[blocked].title) : t("voice.callTitle");
  const openCall = () => {
    useCall.getState().openCall();
    onOpen?.();
  };
  if (placement !== "composer") return (
    <Button
      type="button"
      variant="ghost"
      disabled={!!blocked || open}
      title={blocked ? tooltip : undefined}
      data-command="chat.voiceCall"
      className={placement === "options"
        ? "my-2 -mx-2 justify-start pointer-coarse:min-h-11"
        : "text-muted-foreground hover:text-foreground mx-2 pointer-coarse:min-h-11"}
      onClick={openCall}
    >
      <AudioLinesIcon className="size-4" aria-hidden />
      {placement === "continue" ? t("voice.callContinue") : t("voice.callTitle")}
    </Button>
  );
  return (
    <TooltipIconButton
      tooltip={tooltip}
      command="chat.voiceCall"
      side="bottom"
      type="button"
      variant="default"
      size="icon"
      disabled={!!blocked || open}
      aria-pressed={open}
      aria-label={tooltip}
      title={tooltip}
      className="aui-composer-call size-7 pointer-coarse:size-9 rounded-full"
      onClick={openCall}
    >
      <AudioLinesIcon className="aui-composer-call-icon size-4" aria-hidden />
    </TooltipIconButton>
  );
}
