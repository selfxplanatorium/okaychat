import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { generateId } from "ai";
import { Loader2Icon, SwordsIcon, TrophyIcon } from "lucide-react";
import type { ArenaChoice, ArenaMode, ArenaSide, BattleView } from "@shared/arena";
import { Button } from "@/components/ui/button";
import { t, type PlainMessageKey } from "@/i18n";
import { formatNumber } from "@/i18n/format";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import {
  arenaErrorKey,
  clearPendingArenaMutation,
  discardArenaContent,
  findArenaBattleByMutation,
  getArenaBattle,
  getArenaOptions,
  isArenaNetworkError,
  readArenaMode,
  readPendingArenaMutation,
  startArenaBattle,
  stopArenaBattle,
  subscribeArenaEvents,
  voteArenaBattle,
  writeArenaMode,
  writePendingArenaMutation,
  type ArenaOptions,
} from "@/lib/arena-api";
import { ArenaBattle } from "./ArenaBattle";
import { ArenaLeaderboard } from "./ArenaLeaderboard";
import { ArenaSetup } from "./ArenaSetup";

const DISABLED_REASON: Record<string, PlainMessageKey> = {
  arena_disabled: "arena.reasonDisabled",
  token_credit_exhausted: "arena.errorCredits",
  token_credit_usage_unknown: "arena.errorCreditUnknown",
  token_credit_busy: "arena.errorCreditBusy",
  arena_concurrency: "arena.reasonConcurrency",
  arena_pool_small: "arena.reasonPoolSmall",
  arena_public_disabled: "arena.reasonPublicDisabled",
  default: "arena.disabledBody",
};

const ARENA_EVENTS = [
  "okaychat:arena:run",
  "okaychat:arena:stop",
  "okaychat:arena:next",
  "okaychat:arena:voteA",
  "okaychat:arena:voteB",
  "okaychat:arena:voteTie",
  "okaychat:arena:voteBothBad",
  "okaychat:arena:leaderboard",
  "okaychat:arena:copyA",
  "okaychat:arena:copyB",
  "okaychat:arena:discard",
] as const;

type ArenaAction = (typeof ARENA_EVENTS)[number];
type Tab = "battle" | "leaderboard";

/**
 * `/arena`: a blind, text-only battle workspace plus the session leaderboard. The page owns the one local
 * stream, the account-scoped mutation recovery, and the window commands the central keyboard catalog dispatches.
 * The prompt itself is never persisted; only the opaque mutation id and this account's device mode survive.
 */
export function ArenaPage() {
  const accountId = useData((state) => state.me?.id);
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const tab: Tab = params.get("tab") === "leaderboard" ? "leaderboard" : "battle";
  const battleParam = params.get("battle");
  const scope: "mine" | "global" = params.get("scope") === "mine" ? "mine" : "global";
  const boardWindow: "all" | "30d" = params.get("window") === "30d" ? "30d" : "all";

  const patchQuery = useCallback(
    (patch: Record<string, string | null>, replace = true) => {
      const next = new URLSearchParams(search);
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      navigate(`/arena${next.size ? `?${next.toString()}` : ""}`, { replace });
    },
    [navigate, search],
  );

  const [options, setOptions] = useState<ArenaOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsReload, setOptionsReload] = useState(0);

  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<ArenaMode>("personal");
  const [pool, setPool] = useState<string[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [startUncertain, setStartUncertain] = useState(false);
  const [checkingStart, setCheckingStart] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const focusSetup = useRef(false);
  const pendingMutation = useRef<string | null>(null);

  const [battle, setBattle] = useState<BattleView | null>(null);
  const [battleLoading, setBattleLoading] = useState(false);
  const [battleError, setBattleError] = useState<string | null>(null);
  const [battleReload, setBattleReload] = useState(0);
  const battleToken = useRef(0);
  useEffect(() => () => { battleToken.current += 1; }, []);

  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [pendingVote, setPendingVote] = useState<ArenaChoice | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [voteNeedsRefresh, setVoteNeedsRefresh] = useState(false);
  const [justVoted, setJustVoted] = useState(false);
  const [copiedSide, setCopiedSide] = useState<ArenaSide | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardBusy, setDiscardBusy] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const { copyToClipboard } = useCopyToClipboard();

  useEffect(() => {
    if (!accountId) return;
    const stored = readArenaMode(accountId);
    if (stored) setMode(stored);
  }, [accountId]);

  useEffect(() => {
    let alive = true;
    setOptionsLoading(true);
    setOptionsError(null);
    void getArenaOptions()
      .then((next) => {
        if (alive) setOptions(next);
      })
      .catch((cause: unknown) => {
        if (alive) setOptionsError(t(arenaErrorKey(cause)));
      })
      .finally(() => {
        if (alive) setOptionsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [optionsReload]);

  const loadBattle = useCallback((id: string) => {
    const request = ++battleToken.current;
    setBattle(null);
    setBattleLoading(true);
    setBattleError(null);
    setPendingVote(null);
    setVoteError(null);
    setVoteNeedsRefresh(false);
    setJustVoted(false);
    setStreamError(null);
    setStopError(null);
    setDiscardOpen(false);
    setDiscardError(null);
    void getArenaBattle(id)
      .then((next) => {
        if (request !== battleToken.current) return;
        setBattle(next.battle);
      })
      .catch((cause: unknown) => {
        if (request !== battleToken.current) return;
        setBattleError(t(arenaErrorKey(cause)));
      })
      .finally(() => {
        if (request === battleToken.current) setBattleLoading(false);
      });
  }, []);

  const previousBattleParam = useRef(battleParam);
  useEffect(() => {
    const previous = previousBattleParam.current;
    previousBattleParam.current = battleParam;
    if (!battleParam && previous) {
      // Browser Back to `/arena` leaves the battle view. Start and recovery add the parameter in the same
      // commit as the battle, so they never pass through this branch.
      battleToken.current += 1;
      setBattle(null);
      setBattleError(null);
      setBattleLoading(false);
      setPendingVote(null);
      setVoteError(null);
      setVoteNeedsRefresh(false);
      setJustVoted(false);
      setStreamError(null);
      setStopError(null);
      setDiscardOpen(false);
      setDiscardError(null);
    }
  }, [battleParam]);

  useEffect(() => {
    if (!battleParam) {
      // A response for a battle the URL no longer names must not paint over setup.
      battleToken.current += 1;
      return;
    }
    if (battle?.id === battleParam) return;
    loadBattle(battleParam);
  }, [battleParam, battle?.id, loadBattle, battleReload]);

  // Before any new mutation id, look up the one an uncertain start left behind. Only the id is stored.
  useEffect(() => {
    if (!accountId || battleParam) return;
    const pending = readPendingArenaMutation(accountId);
    if (!pending) return;
    pendingMutation.current = pending.mutationId;
    setCheckingStart(true);
    let alive = true;
    void findArenaBattleByMutation(pending.mutationId)
      .then((result) => {
        if (!alive) return;
        if (result.battle) {
          clearPendingArenaMutation(accountId);
          pendingMutation.current = null;
          setBattle(result.battle);
          patchQuery({ battle: result.battle.id, tab: null });
        } else {
          clearPendingArenaMutation(accountId);
          pendingMutation.current = null;
        }
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        if (isArenaNetworkError(cause)) setStartUncertain(true);
        else {
          clearPendingArenaMutation(accountId);
          pendingMutation.current = null;
        }
      })
      .finally(() => {
        if (alive) setCheckingStart(false);
      });
    return () => {
      alive = false;
    };
  }, [accountId, battleParam, patchQuery]);

  useEffect(() => {
    setCopiedSide(null);
  }, [battle?.id]);

  useEffect(() => {
    if (!copiedSide) return;
    const timer = setTimeout(() => setCopiedSide(null), 3000);
    return () => clearTimeout(timer);
  }, [copiedSide]);

  useEffect(() => {
    if (!battle || battle.state !== "running" || tab !== "battle") {
      setStreamError(null);
      return;
    }
    const controller = new AbortController();
    let alive = true;
    let terminal = false;
    void subscribeArenaEvents(
      battle.id,
      {
        onSnapshot: (next) => {
          if (!alive) return;
          if (next.state !== "running") terminal = true;
          setBattle(next);
          setStreamError(null);
        },
        onText: (side, delta) => {
          if (!alive) return;
          setBattle((current) => {
            if (!current) return current;
            const panes = current.panes.map((pane) => (pane.side === side ? { ...pane, text: pane.text + delta } : pane)) as BattleView["panes"];
            return { ...current, panes } as BattleView;
          });
        },
        onPane: (update) => {
          if (!alive) return;
          setBattle((current) => {
            if (!current) return current;
            const panes = current.panes.map((pane) =>
              pane.side === update.side
                ? {
                    ...pane,
                    state: update.state,
                    ...(update.finish ? { finish: update.finish } : {}),
                    ...(update.errorCode ? { errorCode: update.errorCode } : {}),
                  }
                : pane,
            ) as BattleView["panes"];
            return { ...current, panes } as BattleView;
          });
        },
        onState: (update) => {
          if (!alive) return;
          if (update.state && update.state !== "running") terminal = true;
          setBattle((current) => (current ? { ...current, ...update } : current));
        },
        onError: (cause) => {
          if (!alive) return;
          setStreamError(t(arenaErrorKey(cause)));
        },
        onEnd: () => {
          if (!alive) return;
          setStreamError(terminal ? null : t("arena.errorNetwork"));
        },
      },
      controller.signal,
    ).catch((cause: unknown) => {
      if (!alive || controller.signal.aborted) return;
      setStreamError(t(arenaErrorKey(cause)));
    });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [battle?.id, streamAttempt, tab]);

  const submitStart = useCallback(async () => {
    if (!accountId || !options || starting || startUncertain) return;
    if (options.disabledReason) {
      const reasonKey: PlainMessageKey = DISABLED_REASON[options.disabledReason] ?? "arena.disabledBody";
      setSetupError(t(reasonKey));
      return;
    }
    const text = prompt.trim();
    if (!text) {
      setSetupError(t("arena.promptRequired"));
      return;
    }
    if (text.length > options.limits.maxPrompt) {
      setSetupError(t("arena.promptTooLong", { count: formatNumber(options.limits.maxPrompt) }));
      return;
    }
    const candidates = options.models.filter((model) => mode === "personal" || model.publicEligible);
    const selected = pool === null ? candidates : candidates.filter((model) => pool.includes(model.ref));
    if (!options.modes[mode]) {
      setSetupError(t(mode === "public" ? "arena.publicUnavailable" : "arena.personalUnavailable"));
      return;
    }
    if (selected.length < 2) {
      setSetupError(t("arena.poolNeedTwo"));
      return;
    }
    const request = battleToken.current;
    setStarting(true);
    setSetupError(null);
    setStartUncertain(false);
    const mutationId = generateId();
    pendingMutation.current = mutationId;
    writePendingArenaMutation(accountId, mutationId);
    try {
      const result = await startArenaBattle({
        mutationId,
        prompt: text,
        mode,
        ...(pool === null ? {} : { poolRefs: selected.map((model) => model.ref) }),
      });
      if (request !== battleToken.current) return;
      clearPendingArenaMutation(accountId);
      pendingMutation.current = null;
      setBattle(result.battle);
      setJustVoted(false);
      setPendingVote(null);
      setVoteError(null);
      // A pushed battle entry leaves the ready pair reachable through Back until it expires.
      patchQuery({ battle: result.battle.id, tab: null }, false);
    } catch (cause) {
      if (request !== battleToken.current) return;
      if (isArenaNetworkError(cause)) {
        setStartUncertain(true);
      } else {
        clearPendingArenaMutation(accountId);
        pendingMutation.current = null;
        setSetupError(t(arenaErrorKey(cause)));
      }
    } finally {
      setStarting(false);
    }
  }, [accountId, mode, options, patchQuery, pool, prompt, startUncertain, starting]);

  const checkStart = useCallback(async () => {
    if (!accountId || !pendingMutation.current || checkingStart) return;
    setCheckingStart(true);
    try {
      const result = await findArenaBattleByMutation(pendingMutation.current);
      if (result.battle) {
        clearPendingArenaMutation(accountId);
        pendingMutation.current = null;
        setStartUncertain(false);
        setSetupError(null);
        setBattle(result.battle);
        patchQuery({ battle: result.battle.id, tab: null });
      } else {
        clearPendingArenaMutation(accountId);
        pendingMutation.current = null;
        setStartUncertain(false);
        setSetupError(t("arena.notFound"));
      }
    } catch (cause) {
      setSetupError(t(isArenaNetworkError(cause) ? "arena.errorNetwork" : arenaErrorKey(cause)));
    } finally {
      setCheckingStart(false);
    }
  }, [accountId, checkingStart, patchQuery]);

  const stop = useCallback(async () => {
    if (!battle || battle.state !== "running" || stopping) return;
    const request = battleToken.current;
    setStopping(true);
    setStopError(null);
    try {
      const result = await stopArenaBattle(battle.id);
      if (request !== battleToken.current) return;
      // A terminal SSE event can arrive before the Stop acknowledgement's older running snapshot.
      setBattle(current => current?.id === battle.id && current.state === "running" ? result.battle : current);
    } catch {
      setStopError(t("arena.stopFailed"));
    } finally {
      setStopping(false);
    }
  }, [battle, stopping]);

  const next = useCallback(() => {
    if (battle?.state === "running" || pendingVote) return;
    battleToken.current += 1;
    focusSetup.current = true;
    setOptionsLoading(true);
    setOptionsReload(value => value + 1);
    setBattle(null);
    setBattleError(null);
    setBattleLoading(false);
    setStreamError(null);
    setStopError(null);
    setPendingVote(null);
    setVoteError(null);
    setVoteNeedsRefresh(false);
    setJustVoted(false);
    setDiscardOpen(false);
    setDiscardError(null);
    patchQuery({ battle: null, tab: null }, false);

  }, [battle?.state, patchQuery, pendingVote]);

  const copy = useCallback(
    (side: ArenaSide) => {
      const text = battle?.panes.find((pane) => pane.side === side)?.text;
      if (!text) return;
      copyToClipboard(text);
      setCopiedSide(side);
    },
    [battle?.panes, copyToClipboard],
  );

  const submitVote = useCallback(
    async (choice: ArenaChoice) => {
      if (!battle || battle.visibility !== "blind" || !battle.canVote) return;
      if (pendingVote && pendingVote !== choice) return;
      const request = battleToken.current;
      setPendingVote(choice);
      setVoteNeedsRefresh(false);
      setVoteError(null);
      try {
        const result = await voteArenaBattle(battle.id, choice);
        if (request !== battleToken.current) return;
        setBattle(result.battle);
        setPendingVote(null);
        setJustVoted(true);
      } catch (cause) {
        if (request !== battleToken.current) return;
        if (isArenaNetworkError(cause)) {
          // Keep the erased intent: Retry must send this same choice, never a different one.
          setVoteError(t("arena.voteFailed"));
          return;
        }
        // A conflict or a race may have accepted a vote; adopt the server's stored view before offering another.
        const stored = await getArenaBattle(battle.id).catch(() => null);
        if (request !== battleToken.current) return;
        if (!stored) {
          // The server rejected the vote but its stored view is unreachable. Keep the chosen option disabled
          // until a read succeeds, so the browser never offers a different choice blindly.
          setVoteNeedsRefresh(true);
          setVoteError(t("arena.voteFailed"));
          return;
        }
        if (stored.battle.visibility === "revealed") {
          setBattle(stored.battle);
          setPendingVote(null);
          setJustVoted(true);
          setVoteError(null);
          setVoteNeedsRefresh(false);
          return;
        }
        setPendingVote(null);
        setVoteNeedsRefresh(false);
        if (stored.battle.state === "ready" && !stored.battle.canVote) setVoteError(t("arena.voteNotReady"));
        else setVoteError(t("arena.voteConflict"));
      }
    },
    [battle, pendingVote],
  );

  const retryVote = useCallback(async () => {
    if (!battle) return;
    if (voteNeedsRefresh) {
      const stored = await getArenaBattle(battle.id).catch(() => null);
      if (!stored) {
        setVoteError(t("arena.errorNetwork"));
        return;
      }
      setVoteNeedsRefresh(false);
      if (stored.battle.visibility === "revealed") {
        setBattle(stored.battle);
        setPendingVote(null);
        setJustVoted(true);
        setVoteError(null);
      } else {
        setPendingVote(null);
        setVoteError(stored.battle.canVote ? null : t("arena.voteNotReady"));
      }
      return;
    }
    if (pendingVote) void submitVote(pendingVote);
  }, [battle, pendingVote, submitVote, voteNeedsRefresh]);

  const discard = useCallback(async () => {
    if (!battle || battle.state === "running" || discardBusy || pendingVote) return;
    const request = battleToken.current;
    setDiscardBusy(true);
    setDiscardError(null);
    try {
      await discardArenaContent(battle.id);
      if (request !== battleToken.current) return;
      setBattle((current) =>
        current
          ? ({
              ...current,
              prompt: undefined,
              panes: current.panes.map((pane) => ({ ...pane, text: "" })) as BattleView["panes"],
              ...(current.state === "ready" ? { state: "expired" as const, canVote: false } : {}),
            } as BattleView)
          : current,
      );
      setDiscardOpen(false);
      const stored = await getArenaBattle(battle.id).catch(() => null);
      if (stored) setBattle(stored.battle);
    } catch {
      setDiscardError(t("arena.discardFailed"));
    } finally {
      setDiscardBusy(false);
    }
  }, [battle, discardBusy, pendingVote]);

  const openDiscard = useCallback(() => {
    if (!battle || battle.state === "running" || pendingVote) return;
    setDiscardError(null);
    setDiscardOpen(true);
  }, [battle, pendingVote]);

  const actions = useRef({
    run: () => {},
    stop: () => {},
    next: () => {},
    voteA: () => {},
    voteB: () => {},
    voteTie: () => {},
    voteBothBad: () => {},
    leaderboard: () => {},
    copyA: () => {},
    copyB: () => {},
    discard: () => {},
  });
  actions.current = {
    run: () => {
      if (!battle) void submitStart();
    },
    stop: () => void stop(),
    next,
    voteA: () => void submitVote("A"),
    voteB: () => void submitVote("B"),
    voteTie: () => void submitVote("tie"),
    voteBothBad: () => void submitVote("both_bad"),
    leaderboard: () => patchQuery({ tab: "leaderboard" }),
    copyA: () => copy("A"),
    copyB: () => copy("B"),
    discard: openDiscard,
  };

  useEffect(() => {
    const handlers = new Map<ArenaAction, () => void>();
    for (const name of ARENA_EVENTS) handlers.set(name, () => actions.current[name.slice("okaychat:arena:".length) as ArenaActionName]());
    for (const [name, handler] of handlers) window.addEventListener(name, handler);
    return () => {
      for (const [name, handler] of handlers) window.removeEventListener(name, handler);
    };
  }, []);

  useEffect(() => {
    if (focusSetup.current && !optionsLoading && !battleLoading && !battle && !battleParam && tab === "battle" && composerRef.current) {
      composerRef.current.focus(); focusSetup.current = false;
    }
  }, [optionsLoading, battleLoading, battle, battleParam, tab]);

  const disabled = options?.disabledReason ? (DISABLED_REASON[options.disabledReason] ?? DISABLED_REASON.default) : null;
  const running = battle?.state === "running";
  const battleContent =
    battle ? (
      <ArenaBattle
        battle={battle}
        stopping={stopping}
        stopError={stopError}
        streamError={streamError}
        pendingVote={pendingVote}
        voteError={voteError}
        copiedSide={copiedSide}
        justVoted={justVoted}
        discardOpen={discardOpen}
        discardBusy={discardBusy}
        discardError={discardError}
        onStop={() => void stop()}
        onNext={next}
        onVote={(choice) => void submitVote(choice)}
        onRetryVote={retryVote}
        onCopy={copy}
        onRetryStream={() => setStreamAttempt((value) => value + 1)}
        onDiscardOpenChange={setDiscardOpen}
        onDiscard={() => void discard()}
      />
    ) : battleLoading || (checkingStart && !battle) ? (
      <p role="status" className="text-muted-foreground flex flex-1 items-center justify-center gap-2 p-8 text-sm">
        <Loader2Icon className="animate-spin motion-reduce:animate-none" /> {t("arena.loading")}
      </p>
    ) : battleError ? (
      <div role="alert" className="mx-auto flex w-full max-w-md flex-col items-start gap-3 px-4 py-12 text-sm">
        <p>{battleError}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setBattleReload((value) => value + 1)}>
            {t("arena.retry")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => patchQuery({ battle: null })}>
            {t("arena.backToSetup")}
          </Button>
        </div>
      </div>
    ) : optionsLoading ? (
      <p role="status" className="text-muted-foreground flex flex-1 items-center justify-center gap-2 p-8 text-sm">
        <Loader2Icon className="animate-spin motion-reduce:animate-none" /> {t("arena.loading")}
      </p>
    ) : optionsError ? (
      <div role="alert" className="mx-auto flex w-full max-w-md flex-col items-start gap-3 px-4 py-12 text-sm">
        <p>{optionsError}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => setOptionsReload((value) => value + 1)}>
          {t("arena.retry")}
        </Button>
      </div>
    ) : options && disabled ? (
      <div className="mx-auto flex w-full max-w-lg flex-col items-center gap-3 px-4 py-16 text-center">
        <SwordsIcon aria-hidden className="text-muted-foreground size-8" />
        <h2 className="text-base font-medium">{t("arena.disabledTitle")}</h2>
        <p className="text-muted-foreground text-sm">{t(disabled)}</p>
      </div>
    ) : options ? (
      <ArenaSetup
        options={options}
        prompt={prompt}
        mode={mode}
        pool={pool}
        busy={starting}
        error={setupError}
        startUncertain={startUncertain}
        checkingStart={checkingStart}
        composerRef={composerRef}
        onPromptChange={setPrompt}
        onModeChange={(nextMode) => {
          setMode(nextMode);
          if (accountId) writeArenaMode(accountId, nextMode);
          if (nextMode === "public") {
            setPool((current) =>
              current === null
                ? null
                : current.filter((ref) => options.models.some((model) => model.ref === ref && model.publicEligible)),
            );
          }
        }}
        onPoolChange={setPool}
        onSubmit={() => void submitStart()}
        onCheckStart={() => void checkStart()}
      />
    ) : null;

  return (
    <div data-arena-state={running ? "running" : battle?.canVote ? "ready" : battle?.state ?? "setup"} className="flex min-h-0 flex-1 flex-col">
      <div className="border-border shrink-0 border-b px-4 pt-5">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t("arena.title")}</h1>
            <p className="text-muted-foreground mt-1 text-sm">{t("arena.intro")}</p>
          </div>
          <div role="tablist" aria-label={t("arena.title")} className="flex gap-4">
            {(["battle", "leaderboard"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                data-command={value === "leaderboard" ? "arena.leaderboard" : undefined}
                aria-selected={tab === value}
                tabIndex={tab === value ? 0 : -1}
                onClick={() => patchQuery({ tab: value === "battle" ? null : value })}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const nextTab = event.key === "Home" ? "battle" : event.key === "End" ? "leaderboard" : tab === "battle" ? "leaderboard" : "battle";
                  patchQuery({ tab: nextTab === "battle" ? null : nextTab });
                  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-arena-tab="${nextTab}"]`)?.focus());
                }}
                data-arena-tab={value}
                className={cn(
                  "focus-visible:outline-ring -mb-px flex min-h-11 items-center gap-1.5 border-b-2 px-1 pb-2 text-sm",
                  tab === value ? "border-foreground text-foreground font-medium" : "text-muted-foreground hover:text-foreground border-transparent",
                )}
              >
                {value === "battle" ? <SwordsIcon aria-hidden className="size-4" /> : <TrophyIcon aria-hidden className="size-4" />}
                {value === "battle" ? t("arena.tabBattle") : t("arena.tabLeaderboard")}
              </button>
            ))}
          </div>
        </div>
      </div>
      {tab === "battle" ? (
        <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
          {battleContent}
        </div>
      ) : (
        <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
          <ArenaLeaderboard
            key={`${scope}:${boardWindow}`}
            mode="session"
            scope={scope}
            window={boardWindow}
            onScopeChange={(value) => patchQuery({ scope: value === "global" ? null : value, tab: "leaderboard" })}
            onWindowChange={(value) => patchQuery({ window: value === "all" ? null : value, tab: "leaderboard" })}
            onStartBattle={() => {
              if (battle && battle.state === "running") patchQuery({ tab: null });
              else next();
            }}
          />
        </div>
      )}
    </div>
  );
}

type ArenaActionName = "run" | "stop" | "next" | "voteA" | "voteB" | "voteTie" | "voteBothBad" | "leaderboard" | "copyA" | "copyB" | "discard";
