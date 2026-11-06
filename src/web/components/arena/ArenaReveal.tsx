import { useEffect, useRef } from "react";
import type { ArenaChoice, RevealedBattle, RevealedPane } from "@shared/arena";
import { t, type PlainMessageKey } from "@/i18n";
import { formatCost, formatNumber, formatTokens } from "@/i18n/format";

const CHOICE: Record<ArenaChoice, PlainMessageKey> = {
  A: "arena.revealChoiceA",
  B: "arena.revealChoiceB",
  tie: "arena.revealChoiceTie",
  both_bad: "arena.revealChoiceBothBad",
};

const ANSWER: Record<"A" | "B", PlainMessageKey> = {
  A: "arena.answerA",
  B: "arena.answerB",
};

const FINISH: Record<"stop" | "length" | "other", PlainMessageKey> = {
  stop: "arena.revealFinishStop",
  length: "arena.revealFinishLength",
  other: "arena.revealFinishOther",
};

function finishKey(pane: RevealedPane): PlainMessageKey {
  if (pane.finishReason === "stop" || pane.finish === "stop") return FINISH.stop;
  if (pane.finishReason === "length" || pane.finish === "length") return FINISH.length;
  return FINISH.other;
}

const EFFORT: Record<string, PlainMessageKey> = { none: "composer.effortNone", minimal: "composer.effortMinimal", low: "composer.effortLow", medium: "composer.effortMedium", high: "composer.effortHigh", xhigh: "composer.effortXhigh", max: "composer.effortMax" };

function ModelFacts({ pane, side }: { pane: RevealedPane; side: "A" | "B" }) {
  const unknownCost = pane.cost === null || pane.costState === "unknown";
  return (
    <div className="border-border min-w-0 rounded-lg border px-3 py-2.5">
      <h3 className="flex min-w-0 flex-wrap items-baseline gap-1.5 text-sm font-semibold">
        <span className="shrink-0">{t(ANSWER[side])}</span>
        <span className="text-muted-foreground min-w-0 truncate font-normal">{pane.model.label}</span>
        {!pane.model.available && (
          <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-normal">{t("arena.revealUnavailable")}</span>
        )}
      </h3>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("arena.revealModel")}</dt>
        <dd className="truncate" title={pane.model.ref}>
          {pane.model.label} <span className="text-muted-foreground">({pane.model.ref})</span>
        </dd>
        <dt className="text-muted-foreground">{t("arena.revealEffort")}</dt>
        <dd className="truncate">{EFFORT[pane.effort] ? t(EFFORT[pane.effort]!) : pane.effort}</dd>
        <dt className="text-muted-foreground">{t("arena.revealFinish")}</dt>
        <dd>{t(finishKey(pane))}</dd>
      </dl>
      <h4 className="text-muted-foreground mt-2 text-xs font-medium">{t("arena.revealTokens")}</h4>
      {pane.usage ? (
        <>
          <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs tabular-nums">
            <dt className="text-muted-foreground">{t("arena.revealInput")}</dt>
            <dd className="text-end">{formatTokens(pane.usage.input)}</dd>
            <dt className="text-muted-foreground">{t("arena.revealOutput")}</dt>
            <dd className="text-end">{formatTokens(pane.usage.output)}</dd>
            <dt className="text-muted-foreground">{t("arena.revealReasoning")}</dt>
            <dd className="text-end">{formatTokens(pane.usage.reasoning)}</dd>
            <dt className="text-muted-foreground">{t("arena.revealCacheRead")}</dt>
            <dd className="text-end">{formatTokens(pane.usage.cacheRead)}</dd>
            <dt className="text-muted-foreground">{t("arena.revealCacheWrite")}</dt>
            <dd className="text-end">{formatTokens(pane.usage.cacheWrite)}</dd>
          </dl>
          <p className="text-muted-foreground mt-1 text-[11px] tabular-nums">
            {t("arena.revealTotal", { count: formatNumber(pane.usage.input + pane.usage.output) })}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground mt-1 text-xs">{t("arena.revealUsageUnknown")}</p>
      )}
      <p className="text-muted-foreground mt-2 flex items-baseline justify-between gap-2 text-xs">
        <span>{t("arena.revealCost")}</span>
        <span className="text-foreground tabular-nums">
          {unknownCost ? t("arena.revealCostUnknown") : formatCost(pane.cost ?? 0)}
        </span>
      </p>
    </div>
  );
}

/** The owner-only reveal. It keeps the pane order and only adds identity, configuration, usage, and cost. */
export function ArenaReveal({ battle, focus }: { battle: RevealedBattle; focus: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);

  return (
    <section aria-labelledby="arena-reveal-heading" className="border-border bg-muted/30 shrink-0 border-b px-3 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="arena-reveal-heading" ref={heading} tabIndex={-1} className="focus-visible:outline-ring text-sm font-semibold outline-none">
          {t("arena.revealHeading")}
        </h2>
        <p className="text-muted-foreground text-xs">{t("arena.revealVote", { choice: t(CHOICE[battle.vote.choice]) })}</p>
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <ModelFacts pane={battle.panes[0]} side="A" />
        <ModelFacts pane={battle.panes[1]} side="B" />
      </div>
    </section>
  );
}
