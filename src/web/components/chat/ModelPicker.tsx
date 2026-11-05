import { BrainIcon, CheckIcon, ChevronDownIcon, ChevronsUpDownIcon, EyeIcon, SearchIcon, StarIcon, TriangleAlertIcon, WrenchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { reasoningOptions, resolveReasoningEffort } from "@shared/reasoning";
import { isAgentRef, isAgentTarget } from "@shared/n8n-agents";
import type { ChatTargetInfo, ModelInfo, ReasoningEffort } from "@shared/types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { TextSwap } from "@/components/assistant-ui/elements/surfaces";
import { AgentAvatar } from "@/components/agents/AgentAvatar";
import { t, type PlainMessageKey } from "@/i18n";
import { compareText, formatNumber, formatTokens } from "@/i18n/format";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useData, useUnavailableTargetRef } from "@/state/data";
import { settingsHref } from "@/lib/settings-link";
import { useChatModel, useCurrentThreadId } from "@/state/thread-meta";

import { EffortIcon } from "./EffortIcon";

const OPENCODE_GO = "opencode-go";
const AGENT_GROUP = "agents";

export function modelPrice(m: ModelInfo) {
  if (m.free) return t("composer.free");
  if (!m.cost) return null;
  const fmt = (n: number) => formatNumber(n, { minimumFractionDigits: 0, maximumFractionDigits: n < 1 ? 2 : n % 1 ? 1 : 0 });
  return t("composer.modelPrice", { input: fmt(m.cost.input), output: fmt(m.cost.output) });
}

export function Capabilities({ model }: { model: ModelInfo }) {
  return (
    <span className="text-muted-foreground flex items-center gap-1 [&_svg]:size-3">
      {model.reasoning && <BrainIcon aria-label={t("composer.capReasoning")} />}
      {model.inputModalities.includes("image") && <EyeIcon aria-label={t("composer.capVision")} />}
      {model.toolCall && <WrenchIcon aria-label={t("composer.capTools")} />}
    </span>
  );
}

/** The small Agent/Shared labels an agent entry carries instead of capability, context, and price badges. */
function AgentTags({ shared }: { shared: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span className="bg-primary/10 text-primary rounded px-1.5 text-[10px] font-medium">{t("agents.badge")}</span>
      {shared && <span className="bg-muted text-muted-foreground rounded px-1.5 text-[10px]">{t("agents.shared")}</span>}
    </span>
  );
}

/**
 * Favorites first, then n8n agents as their own group, then connected providers with OpenCode Go leading.
 * Agents are chat targets, not models: they never join a provider's group.
 */
export function useModelGroups(query = "", filter?: (m: ChatTargetInfo) => boolean, allowAgents = true) {
  const models = useData((s) => s.models);
  const providers = useData((s) => s.providers);
  const favorites = useData((s) => s.settings?.favoriteModels ?? []);
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (m: ChatTargetInfo) =>
      (allowAgents || !isAgentTarget(m)) &&
      (!filter || filter(m)) &&
      (!q || `${m.name} ${isAgentTarget(m) ? m.description : m.id} ${isAgentTarget(m) ? "" : m.providerId}`.toLowerCase().includes(q));
    const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
    const shown = models.filter(match);
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of shown) if (!isAgentTarget(m)) byProvider.set(m.providerId, [...(byProvider.get(m.providerId) ?? []), m]);
    const ordered = [...byProvider.entries()].sort(([a], [b]) => Number(b === OPENCODE_GO) - Number(a === OPENCODE_GO));
    const agents = shown.filter(isAgentTarget).sort((a, b) => compareText(a.name, b.name));
    const favs = shown.filter((m) => favorites.includes(m.ref));
    return [
      ...(favs.length ? [{ id: "favorites", label: t("composer.favorites"), models: favs }] : []),
      ...(agents.length ? [{ id: AGENT_GROUP, label: t("agents.pickerGroup"), models: agents as ChatTargetInfo[] }] : []),
      ...ordered.map(([id, list]) => ({
        id,
        label: providerName(id),
        models: list.sort((a, b) => Number(b.free) - Number(a.free) || compareText(b.releaseDate ?? "", a.releaseDate ?? "")) as ChatTargetInfo[],
      })),
    ];
  }, [models, providers, favorites, query, filter, allowAgents]);
}

/** A non-model choice listed above the models, e.g. "Same as chat model". */
export interface ModelChoice {
  value: string;
  label: string;
}

/** Opens the agent management page from any picker. */
function AddAgentLink({ compact }: { compact: boolean }) {
  return (
    <div className={cn("border-t", compact ? "px-2 py-1.5" : "px-2.5 py-2")}>
      <Link
        href={settingsHref("agents")}
        data-command="settings.agents"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-8 items-center rounded-lg text-xs outline-none transition-colors duration-(--motion-fast) focus-visible:ring-2 pointer-coarse:min-h-11"
      >
        {t("composer.addAgent")}
      </Link>
    </div>
  );
}

/**
 * Search field and target-grouped options. `compact` drops the context/price line for pickers outside the composer.
 * Arrows walk the options, Enter picks, F toggles a favorite.
 */
export function ModelList({
  value,
  onSelect,
  filter,
  choices = [],
  compact = false,
  allowAgents = true,
  showAddAgent = true,
}: {
  value: string | null | undefined;
  onSelect: (value: string) => void;
  filter?: (m: ChatTargetInfo) => boolean;
  choices?: ModelChoice[];
  compact?: boolean;
  /** Utility and sub-agent pickers are language-model only: no agent group and no Add agent link. */
  allowAgents?: boolean;
  /** Settings forms keep the link out, so navigating away never discards a half-written form. */
  showAddAgent?: boolean;
}) {
  const favorites = useData((s) => s.settings?.favoriteModels ?? []);
  const updateSettings = useData((s) => s.updateSettings);
  const [query, setQuery] = useState("");
  const groups = useModelGroups(query, filter, allowAgents);
  const q = query.trim().toLowerCase();
  const shownChoices = choices.filter((c) => !q || c.label.toLowerCase().includes(q));

  const toggleFavorite = (ref: string) =>
    updateSettings({ favoriteModels: favorites.includes(ref) ? favorites.filter((f) => f !== ref) : [...favorites, ref] });

  const optionKeys = (e: React.KeyboardEvent<HTMLDivElement>, pick: () => void, ref?: string) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick();
      return;
    }
    if (ref && e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      void toggleFavorite(ref);
      return;
    }
    // Up from the first option returns to the search field.
    const picker = e.currentTarget.closest("[data-slot=model-picker]");
    const options = [...(picker?.querySelectorAll<HTMLElement>("[role=option]") ?? [])];
    const index = options.indexOf(e.currentTarget);
    const next =
      e.key === "ArrowDown" ? options[index + 1] :
      e.key === "ArrowUp" ? options[index - 1] ?? picker?.querySelector<HTMLElement>("input") :
      e.key === "Home" ? options[0] :
      e.key === "End" ? options.at(-1) : undefined;
    if (!next) return;
    e.preventDefault();
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  };

  const optionClass = cn(
    "group hover:bg-accent focus-visible:bg-accent active:bg-accent flex cursor-pointer items-center gap-2 rounded-lg px-2 outline-none transition-colors duration-(--motion-fast) ease-out-quart",
    compact ? "py-1 pointer-coarse:py-2" : "py-1.5 pointer-coarse:py-2.5",
  );
  const check = (selected: boolean) => (
    <CheckIcon className={cn("size-3.5 shrink-0 transition-opacity duration-(--motion-fast) ease-out-quart", selected ? "opacity-100" : "opacity-0")} />
  );

  return (
    <div data-slot="model-picker" className="flex min-h-0 flex-1 flex-col">
      <div className={cn("flex items-center gap-2 border-b px-3", compact ? "py-1.5" : "py-2")}>
        <SearchIcon className="text-muted-foreground size-4" />
        <input
          // Touch: focusing opens the keyboard over the list people came to scroll.
          autoFocus={window.matchMedia("(pointer: fine)").matches}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter that confirms an IME candidate is not a selection.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key !== "ArrowDown" && e.key !== "Enter") return;
            const first = e.currentTarget.closest("[data-slot=model-picker]")?.querySelector<HTMLElement>("[role=option]");
            if (!first) return;
            e.preventDefault();
            if (e.key === "Enter") first.click();
            else first.focus();
          }}
          placeholder={t("composer.searchModels")}
          className="placeholder:text-muted-foreground h-7 pointer-coarse:h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
      </div>
      <ScrollArea className="flex-1" viewportClassName="p-1">
        {shownChoices.length > 0 && (
          <div className="mb-1">
            {shownChoices.map((c) => (
              <div
                key={c.value}
                role="option"
                aria-selected={c.value === (value ?? "")}
                tabIndex={0}
                onClick={() => onSelect(c.value)}
                onKeyDown={(e) => optionKeys(e, () => onSelect(c.value))}
                className={cn(optionClass, "text-sm")}
              >
                {check(c.value === (value ?? ""))}
                <span className="truncate">{c.label}</span>
              </div>
            ))}
          </div>
        )}
        {groups.map((group) => (
          <div key={group.id} className="mb-1">
            <div className="text-muted-foreground flex items-center gap-2 px-2 pt-2 pb-1 text-xs font-medium">
              {group.label}
              {group.id === OPENCODE_GO && <span className="bg-primary/10 text-primary rounded px-1.5 text-[10px]">{t("composer.primary")}</span>}
            </div>
            {group.models.map((m) => {
              const agent = isAgentTarget(m);
              return (
                <div
                  key={`${group.id}:${m.ref}`}
                  role="option"
                  aria-selected={m.ref === value}
                  aria-keyshortcuts="F"
                  tabIndex={0}
                  onClick={() => onSelect(m.ref)}
                  onKeyDown={(e) => optionKeys(e, () => onSelect(m.ref), m.ref)}
                  className={optionClass}
                >
                  {check(m.ref === value)}
                  {agent ? (
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <AgentAvatar avatar={m.avatar} size="xs" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-sm">
                          <span className="truncate">{m.name}</span>
                          <AgentTags shared={m.shared} />
                        </div>
                        {!compact && m.description && <div className="text-muted-foreground line-clamp-1 text-[11px]">{m.description}</div>}
                      </div>
                    </div>
                  ) : (
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-sm">
                        <span className="truncate">{m.name}</span>
                        <Capabilities model={m} />
                      </div>
                      {!compact && (
                        <div className="text-muted-foreground flex gap-2 text-[11px] tabular-nums">
                          <span>{t("composer.contextWindow", { tokens: formatTokens(m.context) })}</span>
                          {modelPrice(m) && <span>{modelPrice(m)}</span>}
                        </div>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    aria-label={favorites.includes(m.ref) ? t("composer.unfavorite") : t("composer.favorite")}
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleFavorite(m.ref);
                    }}
                    className={cn(
                      "text-muted-foreground hover:text-foreground rounded p-1 pointer-coarse:p-2.5 opacity-0 pointer-coarse:opacity-60 transition-[opacity,color] duration-(--motion-fast) ease-out-quart group-hover:opacity-100 group-focus-visible:opacity-100",
                      favorites.includes(m.ref) && "text-warning opacity-100 pointer-coarse:opacity-100",
                    )}
                  >
                    <StarIcon className={cn("size-3.5", favorites.includes(m.ref) && "fill-current")} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
        {groups.length === 0 && shownChoices.length === 0 && <p className="text-muted-foreground px-3 py-6 text-center text-sm">{t("composer.noModels")}</p>}
      </ScrollArea>
      {allowAgents && showAddAgent && <AddAgentLink compact={compact} />}
    </div>
  );
}

export function ModelPicker() {
  const models = useData((s) => s.models);
  const selectModel = useData((s) => s.selectModel);
  const active = useChatModel();
  const unavailable = useUnavailableTargetRef(useCurrentThreadId());
  const threadId = useCurrentThreadId();
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();

  if (models.length === 0) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <button type="button" data-command="settings.providers" onClick={() => navigate(settingsHref("providers"))} className="text-muted-foreground hover:text-foreground rounded-lg px-2 py-1 text-xs">
          {t("composer.connectProvider")}
        </button>
        <Link href={settingsHref("agents")} data-command="settings.agents" className="text-muted-foreground hover:text-foreground rounded-lg px-2 py-1 text-xs">
          {t("composer.addAgent")}
        </Link>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="group hover:bg-muted text-muted-foreground hover:text-foreground aria-expanded:bg-muted flex h-7 pointer-coarse:h-9 max-w-56 sm:max-w-72 min-w-0 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors duration-(--motion-fast) ease-out-quart"
        aria-label={t("composer.chooseModel")}
        aria-live="polite"
        data-command="composer.model"
      >
        {unavailable ? (
          <>
            <TriangleAlertIcon className="text-warning size-3.5 shrink-0" />
            <span className="truncate">{t("composer.agentUnavailable")}</span>
          </>
        ) : (
          <TextSwap value={active?.name ?? t("composer.chooseModel")} className="truncate" />
        )}
        <ChevronDownIcon className="size-3 shrink-0 transition-transform duration-(--motion-base) ease-out-expo group-aria-expanded:rotate-180" />
      </PopoverTrigger>
      <PopoverContent side="top" className="flex max-h-[min(32rem,70dvh)] w-[min(26rem,calc(100vw-1rem))] flex-col p-0">
        <ModelList
          value={active?.ref}
          onSelect={(ref) => {
            selectModel(ref, threadId);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Form-field model picker for settings: a select-style trigger opening the compact searchable list. */
export function ModelSelect({
  value,
  onValueChange,
  choices,
  filter,
  allowAgents = true,
  className,
  "aria-label": ariaLabel,
}: {
  value: string | null | undefined;
  onValueChange: (value: string) => void;
  choices?: ModelChoice[];
  filter?: (m: ChatTargetInfo) => boolean;
  allowAgents?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const models = useData((s) => s.models);
  const [open, setOpen] = useState(false);
  const model = models.find((m) => m.ref === value);
  const choice = choices?.find((c) => c.value === (value ?? ""));
  const unavailable = !!value && isAgentRef(value) && !model;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={ariaLabel}
        className={cn(
          "bg-muted/60 hover:bg-muted aria-expanded:bg-muted focus-visible:ring-ring/50 inline-flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-lg border px-2.5 text-sm transition-[color,background-color,border-color,box-shadow] duration-(--motion-fast) ease-out-quart outline-none focus-visible:ring-2",
          className,
        )}
      >
        {model ? (
          isAgentTarget(model) ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <AgentAvatar avatar={model.avatar} size="xs" />
              <span className="truncate">{model.name}</span>
            </span>
          ) : (
            // The provider is secondary, so it is the part that gives way when the trigger is narrow.
            <span className="flex min-w-0 items-baseline">
              <span className="min-w-0 truncate">{model.name}</span>
              <span className="text-muted-foreground shrink-0 whitespace-pre">{` · ${model.providerId}`}</span>
            </span>
          )
        ) : (
          <span className={cn("truncate", !choice && !unavailable && "text-muted-foreground", unavailable && "text-warning")}>
            {unavailable ? t("agents.unavailable") : choice?.label ?? (value || t("composer.chooseModel"))}
          </span>
        )}
        <ChevronsUpDownIcon className="text-muted-foreground size-3.5 shrink-0" />
      </PopoverTrigger>
      <PopoverContent className="flex max-h-[min(22rem,60dvh)] w-[max(var(--anchor-width),min(20rem,calc(100vw-1rem)))] flex-col p-0">
        <ModelList
          compact
          value={value}
          choices={choices}
          filter={filter}
          allowAgents={allowAgents}
          showAddAgent={false}
          onSelect={(v) => {
            onValueChange(v);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

const EFFORT_LABELS = {
  none: "composer.effortNone",
  minimal: "composer.effortMinimal",
  low: "composer.effortLow",
  medium: "composer.effortMedium",
  high: "composer.effortHigh",
  xhigh: "composer.effortXhigh",
  max: "composer.effortMax",
} as const satisfies Record<ReasoningEffort, PlainMessageKey>;

export const effortLabel = (effort: ReasoningEffort) => (EFFORT_LABELS[effort] ? t(EFFORT_LABELS[effort]) : effort);

/** Shared by the desktop effort menu and the mobile composer menu. */
export function useEffortChoices() {
  const active = useChatModel();
  const settings = useData((s) => s.settings);
  const efforts = settings?.reasoningEffort ?? {};
  const updateSettings = useData((s) => s.updateSettings);
  // Agents have no reasoning effort: the control is hidden and the bridge sends none.
  const model = active && !isAgentTarget(active) ? active : undefined;
  const current = resolveReasoningEffort(model ?? { ref: "" }, settings);
  const options = reasoningOptions(model ?? {});
  const set = (effort: ReasoningEffort) => {
    if (model) void updateSettings({ reasoningEffort: { ...efforts, [model.ref]: effort } });
  };
  return { active, current, options, set };
}

/** "Instant" means reasoning is off, which only exists for models that offer it. */
export function EffortPicker() {
  const { active, current, options, set } = useEffortChoices();
  if (!active?.reasoning || isAgentTarget(active)) return null;
  return (
    <Menu>
      <MenuTrigger data-command="composer.effort" aria-label={t("composer.reasoningEffortValue", { value: effortLabel(current) })} className="hover:bg-muted text-muted-foreground hover:text-foreground aria-expanded:bg-muted flex h-7 shrink-0 pointer-coarse:h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors duration-(--motion-fast) ease-out-quart">
        <EffortIcon effort={current} options={options} className="size-3.5" />
        <TextSwap value={effortLabel(current)} />
      </MenuTrigger>
      <MenuContent side="top">
        <MenuLabel>{t("composer.reasoningEffort")}</MenuLabel>
        {options.map((e) => (
          <MenuItem key={e} onClick={() => set(e)}>
            <EffortIcon effort={e} options={options} />
            <span className="flex-1">{effortLabel(e)}</span>
            <CheckIcon className={cn("ml-auto", current === e ? "opacity-100" : "opacity-0")} />
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
