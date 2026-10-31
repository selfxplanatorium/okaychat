import { PhoneIcon } from "lucide-react";
import { useEffect } from "react";
import { t } from "@/i18n";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useCall } from "./store";

/** Composer entry point. Visible only when the server or the account can actually run a call. */
export function CallButton() {
  const availability = useCall((s) => s.availability);
  const availabilityError = useCall((s) => s.availabilityError);
  const open = useCall((s) => s.open);
  useEffect(() => {
    if (useCall.getState().availability === null) void useCall.getState().loadAvailability();
  }, []);
  // An availability failure still offers the button: the call view explains it and can retry.
  if (!availabilityError && (!availability || (!availability.local && !availability.realtime))) return null;
  return (
    <TooltipIconButton
      tooltip={t("voice.callTitle")}
      command="chat.voiceCall"
      side="bottom"
      type="button"
      variant="ghost"
      size="icon"
      aria-pressed={open}
      className="aui-composer-call text-muted-foreground hover:text-foreground size-7 pointer-coarse:size-11 rounded-full"
      aria-label={t("voice.callTitle")}
      onClick={() => useCall.getState().openCall()}
    >
      <PhoneIcon className="aui-composer-call-icon size-4" />
    </TooltipIconButton>
  );
}
