import { useAui, useAuiState } from "@assistant-ui/react";
import { ListChecksIcon, PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { metadataOf } from "@/state/thread-meta";

/** Composer toggle. In plan mode the server offers only read-only tools and asks for a plan. */
export function PlanToggle() {
  const on = useData((s) => s.planMode);
  const setPlanMode = useData((s) => s.setPlanMode);
  return (
    <button
      type="button"
      onClick={() => setPlanMode(!on)}
      aria-pressed={on}
      title={on ? "Plan mode: the model proposes a plan and changes nothing" : "Act mode: the model may use every tool"}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs",
        on ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <ListChecksIcon className="size-3.5" />
      <span className="hidden sm:inline">Plan</span>
    </button>
  );
}

/** Under the latest plan-mode answer: switch to act mode and run the plan. */
export function ExecutePlan() {
  const aui = useAui();
  const isPlan = useAuiState((s) => s.message.role === "assistant" && metadataOf(s.message.metadata).mode === "plan");
  const isLast = useAuiState((s) => s.thread.messages.at(-1)?.id === s.message.id);
  const running = useAuiState((s) => s.thread.isRunning);
  const setPlanMode = useData((s) => s.setPlanMode);
  if (!isPlan || !isLast || running) return null;
  return (
    <div className="flex px-2 pb-2">
      <Button
        size="sm"
        onClick={() => {
          setPlanMode(false);
          aui.thread.append("Go ahead and carry out the plan.");
        }}
      >
        <PlayIcon />
        Execute plan
      </Button>
    </div>
  );
}
