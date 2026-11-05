import { ActionBarMorePrimitive, useAuiState } from "@assistant-ui/react";
import { MessageSquareTextIcon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { t } from "@/i18n";
import { useCommand } from "@/keyboard/registry";
import { openFeedback } from "@/state/feedback-dialog";
import { useFeedback } from "@/state/message-annotations";
import { focusedMessageId, useAnnotationGate } from "./annotation-gates";

// Private answer feedback. One entry in More opens the shared form; a saved rating leaves a small thumb in the
// footer. Nothing here talks to a provider or a feedback pipeline.

function useFeedbackEntry(threadId: string | null | undefined, messageId: string) {
  const gate = useAnnotationGate(threadId, messageId);
  const feedback = useFeedback(threadId ?? undefined, messageId);
  // A reply can only be rated after it is complete, not while it streams.
  const complete = useAuiState((s) => s.message.status?.type === "complete");
  const available = gate.available && complete;
  return { gate, feedback, available };
}

export function FeedbackMenuItem({ threadId, messageId }: { threadId: string | null | undefined; messageId: string }) {
  const { gate, available } = useFeedbackEntry(threadId, messageId);
  return (
    <ActionBarMorePrimitive.Item
      disabled={!available}
      onClick={() => threadId && openFeedback(threadId, messageId)}
      className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors duration-(--motion-fast) ease-out-quart select-none disabled:opacity-50"
    >
      <MessageSquareTextIcon className="size-4" />
      {available ? t("annotations.feedback") : t(gate.reason ?? "annotations.busy")}
    </ActionBarMorePrimitive.Item>
  );
}

/** The footer mark for an existing rating; its accessible name says which rating it edits. */
export function FeedbackMarker({ threadId, messageId }: { threadId: string | null | undefined; messageId: string }) {
  const { available, feedback } = useFeedbackEntry(threadId, messageId);
  if (!feedback?.rating) return null;
  const label = feedback.rating === "positive" ? t("annotations.editPositive") : t("annotations.editNegative");
  return (
    <TooltipIconButton
      tooltip={label}
      aria-label={label}
      disabled={!available}
      onClick={() => threadId && openFeedback(threadId, messageId)}
      className="text-primary size-7 pointer-coarse:size-9 shrink-0 opacity-80 hover:opacity-100"
    >
      {feedback.rating === "positive" ? <ThumbsUpIcon className="size-3.5" /> : <ThumbsDownIcon className="size-3.5" />}
    </TooltipIconButton>
  );
}

/** Opens feedback for the focused reply only. */
export function FeedbackCommand({ threadId, messageId }: { threadId: string | null | undefined; messageId: string }) {
  const { available } = useFeedbackEntry(threadId, messageId);
  useCommand(
    "message.feedback",
    () => {
      if (focusedMessageId() !== messageId || !available || !threadId) return false;
      openFeedback(threadId, messageId);
      return true;
    },
    available,
  );
  return null;
}
