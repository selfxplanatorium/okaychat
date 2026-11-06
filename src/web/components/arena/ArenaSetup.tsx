import { useMemo, useRef, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, Loader2Icon, PlayIcon, SearchIcon } from "lucide-react";
import type { ArenaMode } from "@shared/arena";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { formatNumber } from "@/i18n/format";
import { useData } from "@/state/data";
import type { ArenaModelOption, ArenaOptions } from "@/lib/arena-api";
import { cn } from "@/lib/utils";

export function ArenaSetup({
  options,
  prompt,
  mode,
  pool,
  busy,
  error,
  startUncertain,
  checkingStart,
  composerRef,
  onPromptChange,
  onModeChange,
  onPoolChange,
  onSubmit,
  onCheckStart,
}: {
  options: ArenaOptions;
  prompt: string;
  mode: ArenaMode;
  pool: string[] | null;
  busy: boolean;
  error: string | null;
  startUncertain: boolean;
  checkingStart: boolean;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  onPromptChange: (value: string) => void;
  onModeChange: (mode: ArenaMode) => void;
  onPoolChange: (pool: string[] | null) => void;
  onSubmit: () => void;
  onCheckStart: () => void;
}) {
  const sendWith = useData((state) => state.settings?.keyboard?.sendWith);
  const [poolOpen, setPoolOpen] = useState(false);
  const [search, setSearch] = useState("");
  const candidates = useMemo(
    () => options.models.filter((model) => mode === "personal" || model.publicEligible),
    [mode, options.models],
  );
  const candidateRefs = useMemo(() => new Set(candidates.map((model) => model.ref)), [candidates]);
  const selected = useMemo(
    () => (pool === null ? candidates : candidates.filter((model) => pool.includes(model.ref))),
    [candidates, pool],
  );
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return candidates;
    return candidates.filter((model) => `${model.name} ${model.ref}`.toLowerCase().includes(needle));
  }, [candidates, search]);
  const modeUnavailable = mode === "personal" ? !options.modes.personal : !options.modes.public;
  const missingPool = selected.length < 2;
  const tooLong = prompt.length > options.limits.maxPrompt;
  const disabled = busy || startUncertain || !prompt.trim() || tooLong || missingPool || modeUnavailable;

  const toggle = (model: ArenaModelOption) => {
    const all = pool === null ? candidates.map((item) => item.ref) : pool.filter((ref) => candidateRefs.has(ref));
    const next = all.includes(model.ref) ? all.filter((ref) => ref !== model.ref) : [...all, model.ref];
    // `null` is the canonical "every eligible model" selection; keep it when everything is checked.
    onPoolChange(next.length === candidates.length ? null : next);
  };

  const send = () => {
    if (disabled) return;
    onSubmit();
  };

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col gap-5 overflow-y-auto px-4 py-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{t("arena.setupTitle")}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{t("arena.setupIntro")}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label htmlFor="arena-prompt" className="text-sm font-medium">{t("arena.promptLabel")}</label>
          <span className={cn("text-muted-foreground text-[11px] tabular-nums", tooLong && "text-destructive")}>
            {formatNumber(prompt.length)} / {formatNumber(options.limits.maxPrompt)}
          </span>
        </div>
        <Textarea
          id="arena-prompt"
          ref={composerRef}
          value={prompt}
          maxLength={options.limits.maxPrompt}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder={t("arena.promptPlaceholder")}
          aria-label={t("arena.promptPlaceholder")}
          className="min-h-32"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            const mod = sendWith === "modEnter";
            const submit = event.key === "Enter" && (mod ? event.metaKey || event.ctrlKey : !event.shiftKey && !event.metaKey && !event.ctrlKey);
            if (!submit) return;
            event.preventDefault();
            send();
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs">{t("arena.examplesLabel")}</span>
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" size="sm" variant="outline" onClick={() => onPromptChange(t("arena.exampleCompare"))}>
            {t("arena.exampleCompare")}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onPromptChange(t("arena.exampleDecide"))}>
            {t("arena.exampleDecide")}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onPromptChange(t("arena.exampleExplain"))}>
            {t("arena.exampleExplain")}
          </Button>
        </div>
      </div>

      <fieldset className="flex min-w-0 flex-col gap-1.5">
        <legend className="text-sm font-medium">{t("arena.modeLabel")}</legend>
        <SegmentedControl
          value={mode}
          onValueChange={(value) => {
            if (value === "personal" || value === "public") onModeChange(value);
          }}
          label={t("arena.modeLabel")}
          items={[
            {
              value: "personal",
              label: t("arena.modePersonal"),
              disabled: !options.modes.personal,
              ...(!options.modes.personal ? { reason: t("arena.personalUnavailable") } : {}),
            },
            {
              value: "public",
              label: t("arena.modePublic"),
              disabled: !options.modes.public,
              ...(!options.modes.public ? { reason: t("arena.publicUnavailable") } : {}),
            },
          ]}
          className="self-start"
        />
        <p className="text-muted-foreground text-xs">{mode === "public" ? t("arena.modePublicHelp") : t("arena.modePersonalHelp")}</p>
        {modeUnavailable && (
          <p role="status" className="text-destructive text-xs">
            {t(mode === "public" ? "arena.publicUnavailable" : "arena.personalUnavailable")}
          </p>
        )}
        {mode === "public" && (
          <p className="border-border bg-muted/40 rounded-lg border px-3 py-2 text-xs text-pretty">{t("arena.publicNotice")}</p>
        )}
      </fieldset>

      <section className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">{t("arena.poolLabel")}</h3>
            <p className="text-muted-foreground text-xs">{t("arena.poolHelp")}</p>
            <p className="text-muted-foreground mt-0.5 text-xs tabular-nums">{t("arena.poolSelected", { count: formatNumber(selected.length) })}</p>
          </div>
          <Button type="button" size="sm" variant="outline" className="pointer-coarse:min-h-11" aria-expanded={poolOpen} onClick={() => setPoolOpen((open) => !open)}>
            {poolOpen ? t("arena.poolHide") : t("arena.poolShow")}
            {poolOpen ? <ChevronUpIcon /> : <ChevronDownIcon />}
          </Button>
        </div>
        {poolOpen && (
          <div className="border-border bg-card flex max-h-72 flex-col gap-2 rounded-xl border p-2.5">
            {candidates.length === 0 ? (
              <p className="text-muted-foreground px-1 py-2 text-sm">{t("arena.poolEmpty")}</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="relative min-w-40 flex-1">
                    <SearchIcon aria-hidden className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" />
                    <Input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={t("arena.poolSearch")}
                      aria-label={t("arena.poolSearch")}
                      className="ps-8"
                    />
                  </div>
                  <Button type="button" size="sm" variant="ghost" onClick={() => onPoolChange(null)}>
                    {t("arena.poolSelectAll")}
                  </Button>
                </div>
                <div className="min-h-0 overflow-y-auto">
                  {shown.length === 0 ? (
                    <p className="text-muted-foreground px-1 py-2 text-sm">{t("arena.poolNoMatch")}</p>
                  ) : (
                    <ul className="flex flex-col">
                      {shown.map((model) => (
                        <li key={model.ref}>
                          <label className="hover:bg-muted/60 flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm">
                            <input
                              type="checkbox"
                              className="accent-primary size-4 shrink-0"
                              checked={selected.some((item) => item.ref === model.ref)}
                              onChange={() => toggle(model)}
                            />
                            <span className="min-w-0 flex-1 truncate">{model.name}</span>
                            {model.publicEligible && <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px]">{t("arena.poolPublicOnly")}</span>}
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        {missingPool && <p className="text-muted-foreground text-xs">{t("arena.poolNeedTwo")}</p>}
      </section>

      {startUncertain && (
        <div role="alert" className="border-border bg-muted/40 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">{t("arena.startUncertain")}</span>
          <Button type="button" size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={checkingStart} onClick={onCheckStart}>
            {checkingStart ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : null}
            {t("arena.checkStart")}
          </Button>
        </div>
      )}

      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" className="pointer-coarse:min-h-11" disabled={disabled} data-command="arena.run" onClick={send}>
          {busy ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <PlayIcon />}
          {busy ? t("arena.running") : t("arena.run")}
        </Button>
        <p className="text-muted-foreground text-xs">{t("arena.capacityHint")}</p>
      </div>
    </div>
  );
}
