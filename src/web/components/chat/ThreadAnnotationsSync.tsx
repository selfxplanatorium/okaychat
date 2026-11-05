import { useEffect, useRef } from "react";
import { closeBookmarks } from "@/state/bookmark-dialog";
import { closeFeedback } from "@/state/feedback-dialog";
import { loadThreadAnnotations, threadAnnotationsBusy } from "@/state/message-annotations";
import { useMessageJump } from "@/state/message-jump";
import { useCurrentThreadId } from "@/state/thread-meta";
import { isTemporaryChat } from "@/state/chat-privacy";
import { useData } from "@/state/data";

// One owner for a chat's private annotation state. Opening the chat fetches once; a focus refresh only runs while
// this chat is mounted and nothing is being written, so it cannot wipe a pending change.

export function ThreadAnnotationsSync() {
  const threadId = useCurrentThreadId();
  const userId = useData((s) => s.me?.id);
  const seen = useRef<string | null>(null);

  useEffect(() => {
    if (seen.current !== threadId) {
      seen.current = threadId;
      closeBookmarks();
      closeFeedback();
      useMessageJump.getState().clear();
    }
    if (!threadId || isTemporaryChat(threadId)) return;
    void loadThreadAnnotations(threadId);
    const onFocus = () => {
      if (!threadAnnotationsBusy(threadId)) void loadThreadAnnotations(threadId, true);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [threadId, userId]);

  return null;
}
