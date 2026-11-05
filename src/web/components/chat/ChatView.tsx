import { useAuiState } from "@assistant-ui/react";
import { useEffect, useMemo, useRef } from "react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { CompactionMarker, ContextMeter, MessageMeta } from "./ContextMeter";
import { MobileComposerMenu, PromptsButton, ResearchToggle, SearchToggle } from "./ComposerControls";
import { KnowledgeCitationHost } from "@/components/knowledge/KnowledgeCitation";
import { EffortPicker, ModelPicker } from "./ModelPicker";
import { BranchedFromBanner, BranchMenu, PendingBranchRun } from "./branch";
import { pickWelcomeLine } from "./welcome-lines";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { useChatPrivacy, isTemporaryChat } from "@/state/chat-privacy";
import { useKnowledgeCitationStore } from "@/state/chat-knowledge";
import { ThreadMetaSync, useCurrentThreadId } from "@/state/thread-meta";
import { closeReplyEditor } from "@/state/message-edits";
import { CallView } from "@/speech/call/CallView";
import { BookmarkDialog } from "./BookmarkDialog";
import { FeedbackDialog } from "./FeedbackDialog";
import { SavedPromptsDialog } from "./SavedPromptsDialog";
import { ThreadAnnotationsSync } from "./ThreadAnnotationsSync";
import { useCommand } from "@/keyboard/registry";
import { closeBookmarks, openBookmarks } from "@/state/bookmark-dialog";
import { closeFeedback } from "@/state/feedback-dialog";
import { closePromptPicker, openPromptPicker, usePromptPicker } from "@/state/prompt-picker";

function Welcome() {
  const privacy = useChatPrivacy();
  const name = useData((s) => s.me?.name);
  // Re-picks only when the name arrives, so the line does not change on every render.
  const line = useMemo(() => pickWelcomeLine(name), [name]);
  const text = privacy.temporary ? t("composer.temporaryChat") : line;
  return (
    <div className="mb-6 flex flex-col items-center px-2 text-center max-md:my-auto">
      {/* Keyed by the text, so switching to a temporary chat writes the new line in. */}
      <p key={text} className="text-2xl font-medium tracking-tight text-balance">
        <span className="sr-only">{text}</span>
        {text.split(" ").map((word, index) => (
          <span key={index} aria-hidden>
            {index > 0 && " "}
            <span className="chat-word-in inline-block" style={{ "--i": index } as React.CSSProperties}>
              {word}
            </span>
          </span>
        ))}
      </p>
      {/* Always mounted: the row opens from zero height, so the composer below glides
          down (and back up) instead of jumping when temporary mode toggles. */}
      <div
        inert={!privacy.temporary}
        aria-hidden={!privacy.temporary}
        className={cn(
          "grid w-full justify-items-center transition-[grid-template-rows,opacity] duration-(--motion-slow) ease-in-out-quart",
          privacy.temporary ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <p className="text-muted-foreground mt-2 max-w-sm text-sm">{t(privacy.personalized ? "composer.temporaryNoticePersonalized" : "composer.temporaryNoticePlain")}</p>
        </div>
      </div>
    </div>
  );
}

function ComposerToolbar() {
  return (
    <>
      <MobileComposerMenu />
      <ModelPicker />
      <div className="flex shrink-0 max-sm:hidden pointer-coarse:hidden">
        <EffortPicker />
      </div>
      <SearchToggle />
      <ResearchToggle />
      <PromptsButton />
      <ContextMeter />
    </>
  );
}

function AfterMessage() {
  return <CompactionMarker />;
}

function BeforeMessages() {
  return (
    <>
      <PendingBranchRun />
      <BranchedFromBanner />
    </>
  );
}

/** The command handlers live with the feature stores, not inside a menu that may be closed. */
function ChatCommands() {
  const threadId = useCurrentThreadId();
  const temporary = isTemporaryChat(threadId);
  const openManager = usePromptPicker((s) => s.openManager);
  useCommand("composer.prompts", () => {
    openPromptPicker();
    return true;
  });
  useCommand("composer.managePrompts", () => {
    openManager();
    return true;
  });
  useCommand(
    "chat.bookmarks",
    () => {
      if (!threadId || temporary) return false;
      openBookmarks();
      return true;
    },
    !!threadId && !temporary,
  );
  return null;
}

/** A pending prompt insertion belongs to the chat where it was chosen, stored or not. */
function PromptPickerSync() {
  const localId = useAuiState((s) => s.threadListItem.id);
  const seen = useRef(localId);
  useEffect(() => {
    if (seen.current === localId) return;
    seen.current = localId;
    closePromptPicker();
  }, [localId]);
  return null;
}

/** An editor belongs to one chat: switching chats closes it instead of leaving a draft aimed at the old reply. */
function ReplyEditorSync() {
  const threadId = useCurrentThreadId();
  const seen = useRef(threadId);
  useEffect(() => {
    if (seen.current === threadId) return;
    seen.current = threadId;
    closeReplyEditor();
  }, [threadId]);
  return null;
}

export function ChatView() {
  useEffect(
    () => () => {
      useKnowledgeCitationStore.getState().close();
      // Leaving the chat route must not leave a private dialog waiting behind it.
      closePromptPicker();
      closeBookmarks();
      closeFeedback();
    },
    [],
  );
  return (
    <>
      <ThreadMetaSync />
      <ReplyEditorSync />
      <PromptPickerSync />
      <ThreadAnnotationsSync />
      <ChatCommands />
      <Thread components={{ Welcome, ComposerToolbar, MessageMeta, AfterMessage, BeforeMessages, BranchAction: BranchMenu }} />
      <SavedPromptsDialog />
      <BookmarkDialog />
      <FeedbackDialog />
      <KnowledgeCitationHost />
      <CallView />
    </>
  );
}
