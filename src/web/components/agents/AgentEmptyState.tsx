import { PlusIcon, WorkflowIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/** First run: one sentence about what an agent is, and the primary action. */
export function AgentEmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="animate-fade-in flex flex-col items-center gap-3 px-4 py-10 text-center">
      <span aria-hidden className="bg-muted text-primary flex size-12 items-center justify-center rounded-2xl border shadow-[var(--depth-highlight)]">
        <WorkflowIcon className="size-6" />
      </span>
      <h2 className="text-base font-medium">{t("agents.emptyTitle")}</h2>
      <p className="text-muted-foreground max-w-sm text-sm text-pretty">{t("agents.emptyBody")}</p>
      <Button type="button" onClick={onAdd} data-command="agents.create" className="min-h-10 pointer-coarse:min-h-11">
        <PlusIcon /> {t("agents.add")}
      </Button>
    </div>
  );
}
