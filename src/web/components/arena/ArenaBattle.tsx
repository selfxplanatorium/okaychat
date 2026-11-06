import { useCallback } from "react";
import { ArrowRightIcon, Loader2Icon, RefreshCwIcon, SquareIcon, Trash2Icon } from "lucide-react";
import type { ArenaChoice, ArenaSide, BattleView, BlindBattle } from "@shared/arena";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { useShortcutProps } from "@/keyboard/registry";
import { ArenaPane } from "./ArenaPane";
import { ArenaReveal } from "./ArenaReveal";
import { ArenaVoteBar } from "./ArenaVoteBar";

export function ArenaBattle({
  battle,
  stopping,
  stopError,
  streamError,
  pendingVote,
  voteError,
  copiedSide,
  justVoted,
  discardOpen,
  discardBusy,
  discardError,
  onStop,
  onNext,
  onVote,
  onRetryVote,
  onCopy,
  onRetryStream,
  onDiscardOpenChange,
  onDiscard,
}: {
  battle: BattleView;
  stopping: boolean;
  stopError: string | null;
  streamError: string | null;
  pendingVote: ArenaChoice | null;
  voteError: string | null;
  copiedSide: ArenaSide | null;
  justVoted: boolean;
  discardOpen: boolean;
  discardBusy: boolean;
  discardError: string | null;
  onStop: () => void;
  onNext: () => void;
  onVote: (choice: ArenaChoice) => void;
  onRetryVote: () => void;
  onCopy: (side: ArenaSide) => void;
  onRetryStream: () => void;
  onDiscardOpenChange: (open: boolean) => void;
  onDiscard: () => void;
}) {
  const running = battle.state === "running";
  const canDiscard = !running && pendingVote === null && (Boolean(battle.prompt) || battle.panes.some((pane) => pane.text.length > 0));
  const stopHint = useShortcutProps("arena.stop", t("arena.stopBoth"));
  const nextHint = useShortcutProps("arena.next", t("arena.nextBattle"));
  const discardHint = useShortcutProps("arena.discard", t("arena.discardContent"));
  const onDiscardOpen = useCallback(() => onDiscardOpenChange(true), [onDiscardOpenChange]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto lg:flex lg:flex-col lg:overflow-hidden">
      <div className="border-border flex shrink-0 flex-col gap-2 border-b px-3 py-2.5">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-muted-foreground text-[11px] font-medium">{t("arena.promptHeading")}</h2>
            <p className="max-h-28 overflow-y-auto text-sm whitespace-pre-wrap">
              {battle.prompt ?? (battle.state !== "running" ? <span className="text-muted-foreground">{t("arena.answerExpired")}</span> : null)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {running && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="pointer-coarse:min-h-11"
                disabled={stopping}
                {...stopHint}
                data-command="arena.stop"
                onClick={onStop}
              >
                {stopping ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <SquareIcon />}
                {stopping ? t("arena.stopping") : t("arena.stopBoth")}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="pointer-coarse:min-h-11"
              disabled={running || pendingVote !== null}
              {...nextHint}
              data-command="arena.next"
              onClick={onNext}
            >
              <ArrowRightIcon /> {t("arena.nextBattle")}
            </Button>
            {canDiscard && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-muted-foreground pointer-coarse:min-h-11"
                {...discardHint}
                data-command="arena.discard"
                onClick={onDiscardOpen}
              >
                <Trash2Icon /> {t("arena.discardContent")}
              </Button>
            )}
          </div>
        </div>
        {running && <p className="text-muted-foreground text-[11px]">{t("arena.nextHint")}</p>}
        {stopError && <p role="alert" className="text-destructive text-xs">{stopError}</p>}
        {streamError && (
          <p role="status" className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            {t("arena.streamLost")} {streamError}
            <Button type="button" size="sm" variant="outline" className="pointer-coarse:min-h-11" onClick={onRetryStream}>
              <RefreshCwIcon /> {t("arena.streamRetry")}
            </Button>
          </p>
        )}
      </div>

      {battle.visibility === "revealed" && <ArenaReveal battle={battle} focus={justVoted} />}

      <div className="lg:min-h-0 lg:flex-1 lg:overflow-hidden">
        <div className="grid gap-3 p-3 lg:h-full lg:min-h-0 lg:grid-cols-2">
          {battle.panes.map((pane, index) => (
            <ArenaPane
              key={pane.side}
              pane={pane}
              side={pane.side}
              {...(battle.visibility === "revealed" ? { model: battle.panes[index]!.model } : {})}
              expired={battle.state === "expired" || (battle.state !== "running" && !battle.prompt && !pane.text)}
              copied={copiedSide === pane.side}
              onCopy={onCopy}
            />
          ))}
        </div>
      </div>

      {battle.visibility === "blind" && (
        <ArenaVoteBar battle={battle as BlindBattle} pending={pendingVote} error={voteError} onVote={onVote} onRetry={onRetryVote} />
      )}

      <Dialog open={discardOpen} onOpenChange={onDiscardOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("arena.discardTitle")}</DialogTitle>
            <DialogDescription>{t("arena.discardBody")}</DialogDescription>
          </DialogHeader>
          {discardError && <p role="alert" className="text-destructive text-sm">{discardError}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={discardBusy} onClick={() => onDiscardOpenChange(false)}>
              {t("arena.discardCancel")}
            </Button>
            <Button variant="destructive" disabled={discardBusy} onClick={onDiscard}>
              {discardBusy ? t("arena.discardBusy") : t("arena.discardConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
