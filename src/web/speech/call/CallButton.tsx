import { useAui, useAuiState } from "@assistant-ui/react";
import { PhoneIcon } from "lucide-react";
import { useEffect } from "react";
import { t } from "@/i18n";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useThreadSync } from "@/state/thread-sync";
import { callBlock } from "./guard";
import { FAILURE_TEXT } from "./messages";
import { useCall } from "./store";

/** Composer entry point. Visible when an engine is configured, even if it is temporarily down: the call view
 * explains the failure and offers Retry, which re-probes the worker. */
export function CallButton() {
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
  const recoverableWorker = availability?.localReason?.code === "worker";
  const configured = !!availability && (availability.local || availability.realtime || recoverableWorker);
  // An availability failure still offers the button: the call view explains it and can retry.
  if (!availabilityError && !configured) return null;
  const tooltip = blocked ? t(FAILURE_TEXT[blocked].title) : t("voice.callTitle");
  return (
    <TooltipIconButton
      tooltip={tooltip}
      command="chat.voiceCall"
      side="bottom"
      type="button"
      variant="ghost"
      size="icon"
      disabled={!!blocked}
      aria-pressed={open}
      aria-label={tooltip}
      title={tooltip}
      className="aui-composer-call text-muted-foreground hover:text-foreground size-7 pointer-coarse:size-11 rounded-full"
      onClick={() => useCall.getState().openCall()}
    >
      <PhoneIcon className="aui-composer-call-icon size-4" />
    </TooltipIconButton>
  );
}
