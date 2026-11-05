import { useEffect, useRef, useState } from "react";
import { Loader2Icon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { closeFeedback, useFeedbackDialog } from "@/state/feedback-dialog";
import { feedbackRevision, loadThreadAnnotations, saveFeedback, useAnnotations, useThreadAnnotations } from "@/state/message-annotations";
import { editKey, useMessageEdits } from "@/state/message-edits";
import { MAX_FEEDBACK_COMMENT, type FeedbackRating } from "@shared/message-annotations";

// The shared feedback form. Nothing is saved by choosing a thumb: Save sends one atomic rating/comment write, and
// Cancel leaves the stored feedback untouched. See docs/implementation/message-annotations.md.

const codePoints = (text: string) => {
  let n = 0;
  for (const _ of text) n++;
  return n;
};

export function FeedbackDialog() {
  const target = useFeedbackDialog((s) => s.target);
  const threadId = target?.threadId;
  const messageId = target?.messageId;
  const annotations = useThreadAnnotations(threadId);
  const feedback = messageId ? annotations.feedback[messageId] : undefined;
  const editedAt = useMessageEdits((s) => (threadId && messageId ? s.editedAt[editKey(threadId, messageId)] : undefined));

  const [rating, setRating] = useState<FeedbackRating | null>(null);
  const [comment, setComment] = useState("");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const openedFor = useRef<string | null>(null);

  // A newly opened reply starts from the stored value. A focus refresh may fill it in after opening, but never
  // overwrite text the user has already edited. Closing resets the draft so the next reply cannot inherit it.
  useEffect(() => {
    if (!target) {
      openedFor.current = null;
      setRating(null);
      setComment("");
      setTouched(false);
      setConflict(false);
      setError(null);
      setNotice(null);
      return;
    }
    const key = `${target.threadId} ${target.messageId}`;
    if (openedFor.current !== key) {
      openedFor.current = key;
      setRating(feedback?.rating ?? null);
      setComment(feedback?.comment ?? "");
      setTouched(false);
      setConflict(false);
      setError(null);
      setNotice(null);
      return;
    }
    if (!touched) {
      setRating(feedback?.rating ?? null);
      setComment(feedback?.comment ?? "");
    }
  }, [target, feedback?.revision, feedback?.rating, feedback?.comment, touched]);

  useEffect(() => {
    if (target) void loadThreadAnnotations(target.threadId);
  }, [target]);

  if (!target || !messageId) return null;

  const remaining = MAX_FEEDBACK_COMMENT - codePoints(comment);
  const overLimit = remaining < 0;
  const dirty = rating !== (feedback?.rating ?? null) || comment !== (feedback?.comment ?? "");
  const changed = !!feedback && feedback.messageEditedAt !== (editedAt ?? null);

  const onFailure = async (cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 409) {
      // The server uses 409 for a run in progress as well as a stale revision; only the latter can be reloaded.
      if (!cause.message.includes("another tab")) {
        setError(t("annotations.busy"));
        return;
      }
      setConflict(true);
      setRefreshing(true);
      try {
        await loadThreadAnnotations(target.threadId, true);
      } finally {
        setRefreshing(false);
      }
      return;
    }
    setError(cause instanceof ApiError ? cause.message : t("annotations.saveError"));
  };

  const save = async (nextRating: FeedbackRating) => {
    setSaving(true);
    setError(null);
    setConflict(false);
    setNotice(null);
    try {
      await saveFeedback(target.threadId, target.messageId, {
        rating: nextRating,
        comment: comment.trim() ? comment : null,
        expectedRevision: feedbackRevision(target.threadId, target.messageId),
      });
      setNotice(t("annotations.feedbackSaved"));
      setTouched(false);
    } catch (cause) {
      await onFailure(cause);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setError(null);
    setConflict(false);
    setNotice(null);
    try {
      await saveFeedback(target.threadId, target.messageId, { rating: null, comment: null, expectedRevision: feedbackRevision(target.threadId, target.messageId) });
      setNotice(t("annotations.feedbackRemoved"));
      setRating(null);
      setComment("");
      setTouched(false);
    } catch (cause) {
      await onFailure(cause);
    } finally {
      setSaving(false);
    }
  };

  const reloadStored = async () => {
    setRefreshing(true);
    try {
      await loadThreadAnnotations(target.threadId, true);
      const stored = useAnnotations.getState().threads[target.threadId]?.feedback[target.messageId];
      setRating(stored?.rating ?? null);
      setComment(stored?.comment ?? "");
      setTouched(false);
      setConflict(false);
      setError(null);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && closeFeedback()}>
      <DialogContent className="max-h-[85dvh] gap-3 overflow-y-auto sm:max-w-md">
        <DialogTitle className="pe-6 text-base">{t("annotations.feedbackTitle")}</DialogTitle>
        <DialogDescription>{t("annotations.privateFeedback")}</DialogDescription>
        {changed && <p role="status" className="text-warning text-xs">{t("annotations.replyChanged")}</p>}

        <div role="group" aria-label={t("annotations.feedbackTitle")} className="flex gap-2">
          {(["positive", "negative"] as const).map((value) => {
            const active = rating === value;
            return (
              <Button
                key={value}
                type="button"
                variant={active ? "default" : "outline"}
                aria-pressed={active}
                className="flex-1 pointer-coarse:min-h-11"
                onClick={() => {
                  setRating(value);
                  setTouched(true);
                  setNotice(null);
                }}
              >
                {value === "positive" ? <ThumbsUpIcon /> : <ThumbsDownIcon />}
                {value === "positive" ? t("annotations.helpful") : t("annotations.notHelpful")}
              </Button>
            );
          })}
        </div>

        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">{t("annotations.comment")}</span>
          <Textarea
            value={comment}
            rows={3}
            aria-invalid={overLimit || undefined}
            onChange={(event) => {
              setComment(event.target.value);
              setTouched(true);
              setNotice(null);
            }}
          />
        </label>
        {remaining <= 200 && (
          <p className={cn("text-xs", overLimit ? "text-error" : "text-muted-foreground")} aria-live="polite">
            {t("annotations.commentRemaining", { count: Math.max(0, remaining) })}
          </p>
        )}
        {error && <p role="alert" className="text-error text-xs">{error}</p>}
        {notice && <p role="status" className="text-muted-foreground text-xs">{notice}</p>}

        {conflict && (
          <div role="alert" className="border-warning/40 bg-warning/5 flex flex-col gap-2 rounded-lg border p-2 text-xs">
            <span>{t("annotations.feedbackConflict")}</span>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" disabled={refreshing} onClick={() => setConflict(false)}>
                {t("annotations.keepEditing")}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={refreshing} onClick={() => void reloadStored()}>
                {refreshing && <Loader2Icon className="animate-spin" />}
                {t("annotations.reloadStored")}
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          {feedback?.rating && (
            <Button type="button" variant="ghost" disabled={saving} onClick={() => void remove()}>
              {t("annotations.removeFeedback")}
            </Button>
          )}
          <Button type="button" variant="outline" disabled={saving} onClick={closeFeedback}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={saving || !rating || overLimit || (conflict && refreshing) || (!dirty && !conflict && !changed)}
            onClick={() => rating && void save(rating)}
          >
            {saving && <Loader2Icon className="animate-spin" />}
            {t("annotations.saveFeedback")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
