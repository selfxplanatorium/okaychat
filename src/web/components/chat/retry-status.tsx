import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { t } from "@/i18n";
import { retrySecondsLeft, useRetryStatus } from "@/state/retry-status";

/**
 * The provider wait is real time, so the UI says how long is left. The visible number updates every
 * second; the live region text is static, so a screen reader is not interrupted once per second.
 */
export function RetryStatus() {
  const threadId = useAuiState((s) => s.threadListItem.remoteId);
  const state = useRetryStatus(threadId ?? undefined);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!state) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [state]);

  if (!state) return null;
  const seconds = retrySecondsLeft(state, now);
  return (
    <div
      data-slot="chat-retry-status"
      className="text-muted-foreground bg-muted/40 mx-auto flex max-w-full items-center gap-2 rounded-full px-3 py-1 text-xs"
    >
      <RefreshCwIcon aria-hidden className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
      <span aria-hidden className="truncate">{t("errors.retryingIn", { seconds })}</span>
      <span role="status" aria-live="polite" className="sr-only">{t("errors.retrying")}</span>
    </div>
  );
}
