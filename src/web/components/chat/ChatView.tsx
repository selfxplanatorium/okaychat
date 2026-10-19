import { useMemo } from "react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { CompactionMarker, ContextMeter, MessageMeta } from "./ContextMeter";
import { EffortPicker, ModelPicker } from "./ModelPicker";
import { pickWelcomeLine } from "./welcome-lines";
import { useData } from "@/state/data";

function Welcome() {
  const name = useData((s) => s.me?.name);
  // Re-picks only when the name arrives, so the line does not change on every render.
  const line = useMemo(() => pickWelcomeLine(name), [name]);
  return (
    <div className="mb-6 flex flex-col items-center px-2 text-center">
      <p className="animate-rise-in text-2xl font-medium tracking-tight">{line}</p>
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
