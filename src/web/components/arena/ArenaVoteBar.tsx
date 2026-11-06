import { Loader2Icon } from "lucide-react";
import type { ArenaChoice, BlindBattle } from "@shared/arena";
import { Button } from "@/components/ui/button";
import { t, type PlainMessageKey } from "@/i18n";
import { ShortcutHint } from "@/keyboard/Kbd";

const VOTE_LABEL: Record<ArenaChoice, PlainMessageKey> = {
  A: "arena.voteA",
  B: "arena.voteB",
  tie: "arena.voteTie",
  both_bad: "arena.voteBothBad",
};

const VOTE_COMMAND: Record<ArenaChoice, string> = {
  A: "arena.voteA",
  B: "arena.voteB",
  tie: "arena.voteTie",
  both_bad: "arena.voteBothBad",
};

const CHOICES: ArenaChoice[] = ["A", "B", "tie", "both_bad"];

/**
 * The final vote is server-authoritative: buttons stay disabled until `canVote`, no optimistic reveal is
 * shown, and a failed network send keeps the chosen intent so Retry sends the exact same choice.
 */
export function ArenaVoteBar({
  battle,
  pending,
  error,
  onVote,
  onRetry,
}: {
  battle: BlindBattle;
  pending: ArenaChoice | null;
  error: string | null;
  onVote: (choice: ArenaChoice) => void;
  onRetry: () => void;
}) {
  const unavailable = !battle.canVote;
  const reason = battle.state === "running" ? t("arena.voteNotReady") : t("arena.voteDisabledReason");

  return (
    <div className="border-border sticky bottom-0 lg:static bg-background/95 supports-[backdrop-filter]:bg-background/85 shrink-0 border-t px-3 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("arena.voteHeading")}</p>
          <p className="text-muted-foreground text-xs">{t("arena.voteHint")}</p>
        </div>
        <div role="group" aria-label={t("arena.voteHeading")} className="ms-auto flex flex-wrap gap-1.5">
          {CHOICES.map((choice) => (
            <Button
              key={choice}
              type="button"
              size="sm"
              variant={choice === "A" || choice === "B" ? "default" : "outline"}
              className="pointer-coarse:min-h-11"
              disabled={unavailable || pending !== null}
              data-command={VOTE_COMMAND[choice]}
              onClick={() => onVote(choice)}
            >
              {t(VOTE_LABEL[choice])}
              <ShortcutHint command={VOTE_COMMAND[choice]} className="ms-1" />
            </Button>
          ))}
        </div>
      </div>
      <p aria-live="polite" className="text-muted-foreground mt-1.5 min-h-4 text-xs">
        {pending !== null ? (
          <span className="inline-flex items-center gap-1.5">
            <Loader2Icon aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />
            {t("arena.votePending")}
          </span>
        ) : error ? (
          <span role="alert" className="text-destructive">{error}</span>
        ) : unavailable ? (
          reason
        ) : null}
      </p>
      {pending !== null && error && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <p role="alert" className="text-destructive text-xs">{error}</p>
          <Button type="button" size="sm" variant="outline" className="pointer-coarse:min-h-11" onClick={onRetry}>
            {t("arena.voteRetry")}
          </Button>
        </div>
      )}
    </div>
  );
}
