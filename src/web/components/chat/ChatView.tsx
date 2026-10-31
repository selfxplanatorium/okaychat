import { useEffect, useMemo } from "react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { CompactionMarker, ContextMeter, MessageMeta } from "./ContextMeter";
import { McpPromptsButton, MobileComposerMenu, ResearchToggle, SearchToggle } from "./ComposerControls";
import { KnowledgeControl } from "@/components/knowledge/KnowledgeSelector";
import { KnowledgeCitationHost } from "@/components/knowledge/KnowledgeCitation";
import { EffortPicker, ModelPicker } from "./ModelPicker";
import { BranchedFromBanner, BranchMenu, PendingBranchRun } from "./branch";
import { pickWelcomeLine } from "./welcome-lines";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { useChatPrivacy } from "@/state/chat-privacy";
import { useKnowledgeCitationStore } from "@/state/chat-knowledge";
import { ThreadMetaSync } from "@/state/thread-meta";
import { CallView } from "@/speech/call/CallView";

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
      <div className="flex max-sm:hidden pointer-coarse:hidden">
        <EffortPicker />
      </div>
      <SearchToggle />
      <ResearchToggle />
      <KnowledgeControl />
      <McpPromptsButton />
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

export function ChatView() {
  useEffect(() => () => useKnowledgeCitationStore.getState().close(), []);
  return (
    <>
      <ThreadMetaSync />
      <Thread components={{ Welcome, ComposerToolbar, MessageMeta, AfterMessage, BeforeMessages, BranchAction: BranchMenu }} />
      <KnowledgeCitationHost />
      <CallView />
    </>
  );
}
