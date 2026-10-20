import { useMemo } from "react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { CompactionMarker, ContextMeter, MessageMeta } from "./ContextMeter";
import { EffortPicker, ModelPicker } from "./ModelPicker";
import { pickWelcomeLine } from "./welcome-lines";
import { useData } from "@/state/data";
import { useChatPrivacy } from "@/state/chat-privacy";

function Welcome() {
  const privacy = useChatPrivacy();
  const name = useData((s) => s.me?.name);
  // Re-picks only when the name arrives, so the line does not change on every render.
  const line = useMemo(() => pickWelcomeLine(name), [name]);
  return (
    <div className="mb-6 flex flex-col items-center px-2 text-center">
      <p className="animate-rise-in text-2xl font-medium tracking-tight">{privacy.temporary ? "Anonymous chat" : line}</p>
      {privacy.temporary && <p className="text-muted-foreground mt-2 max-w-sm text-sm">This chat isn’t saved and won’t create memories.{privacy.personalized ? " Saved preferences are used for this chat." : " Personalization is off."}</p>}
    </div>
  );
}

function ComposerToolbar() {
  return (
    <>
      <ModelPicker />
      <EffortPicker />
      <ContextMeter />
    </>
  );
}

function AfterMessage() {
  return <CompactionMarker />;
}

export function ChatView() {
  return <Thread components={{ Welcome, ComposerToolbar, MessageMeta, AfterMessage }} />;
}
