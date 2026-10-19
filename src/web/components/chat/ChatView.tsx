import { ThreadPrimitive } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { CompactionMarker, ContextMeter, MessageMeta } from "./ContextMeter";
import { EffortPicker, ModelPicker } from "./ModelPicker";
import { useData } from "@/state/data";

const SUGGESTIONS = [
  { title: "Explain", label: "a concept like I'm new to it", prompt: "Explain how prompt caching works in LLM APIs, like I'm new to it." },
  { title: "Draft", label: "an email that gets to the point", prompt: "Draft a short, direct email asking my team for status updates by Friday." },
  { title: "Debug", label: "code I paste in", prompt: "I'll paste some code. Find the bug and explain the fix." },
  { title: "Plan", label: "a project step by step", prompt: "Help me plan a weekend project to self-host a small web app." },
];

function Welcome() {
  const name = useData((s) => s.me?.name);
  return (
    <div className="mb-6 flex flex-col gap-4 px-2">
      <p className="fade-in slide-in-from-bottom-1 animate-in text-2xl font-medium tracking-tight duration-200">
        {name ? `What's next, ${name}?` : "How can I help?"}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <ThreadPrimitive.Suggestion key={s.title} prompt={s.prompt} send asChild>
            <button
              type="button"
              className="hover:bg-muted/70 fade-in slide-in-from-bottom-2 animate-in rounded-xl border px-3 py-2.5 text-left text-sm transition-colors duration-200"
            >
              <span className="font-medium">{s.title}</span> <span className="text-muted-foreground">{s.label}</span>
            </button>
          </ThreadPrimitive.Suggestion>
        ))}
      </div>
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

export function ChatView() {
  return <Thread components={{ Welcome, ComposerToolbar, MessageMeta, AfterMessage: CompactionMarker }} />;
}
