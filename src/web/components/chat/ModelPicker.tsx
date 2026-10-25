import { BrainIcon, CheckIcon, ChevronDownIcon, EyeIcon, SearchIcon, StarIcon, WrenchIcon, ZapIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import type { ModelInfo, ReasoningEffort } from "@shared/types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { TextSwap } from "@/components/assistant-ui/elements/surfaces";
import { formatTokens } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useData } from "@/state/data";
import { useChatModel, useCurrentThreadId } from "@/state/thread-meta";

const OPENCODE_GO = "opencode-go";

function price(m: ModelInfo) {
  if (m.free) return "Free";
  if (!m.cost) return null;
  const fmt = (n: number) => (n < 1 ? n.toFixed(2).replace(/0$/, "") : n.toFixed(n % 1 ? 1 : 0));
  return `$${fmt(m.cost.input)} / $${fmt(m.cost.output)}`;
}

function Capabilities({ model }: { model: ModelInfo }) {
  return (
    <span className="text-muted-foreground flex items-center gap-1 [&_svg]:size-3">
      {model.reasoning && <BrainIcon aria-label="Reasoning" />}
      {model.inputModalities.includes("image") && <EyeIcon aria-label="Vision" />}
      {model.toolCall && <WrenchIcon aria-label="Tools" />}
    </span>
  );
}

/** Favorites first, then connected providers with OpenCode Go leading. Shared by the composer picker and the branch menu. */
export function useModelGroups(query = "") {
  const models = useData((s) => s.models);
  const providers = useData((s) => s.providers);
  const favorites = useData((s) => s.settings?.favoriteModels ?? []);
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (m: ModelInfo) => !q || `${m.name} ${m.id} ${m.providerId}`.toLowerCase().includes(q);
    const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of models.filter(match)) byProvider.set(m.providerId, [...(byProvider.get(m.providerId) ?? []), m]);
    const ordered = [...byProvider.entries()].sort(([a], [b]) => Number(b === OPENCODE_GO) - Number(a === OPENCODE_GO));
    const favs = models.filter((m) => favorites.includes(m.ref) && match(m));
    return [
      ...(favs.length ? [{ id: "favorites", label: "Favorites", models: favs }] : []),
      ...ordered.map(([id, list]) => ({
        id,
        label: providerName(id),
        models: list.sort((a, b) => Number(b.free) - Number(a.free) || (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "")),
      })),
    ];
  }, [models, providers, favorites, query]);
}

export function ModelPicker() {
  const models = useData((s) => s.models);
  const favorites = useData((s) => s.settings?.favoriteModels ?? []);
  const updateSettings = useData((s) => s.updateSettings);
  const selectModel = useData((s) => s.selectModel);
  const active = useChatModel();
  const threadId = useCurrentThreadId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();

  const groups = useModelGroups(query);

  const toggleFavorite = (ref: string) =>
    updateSettings({ favoriteModels: favorites.includes(ref) ? favorites.filter((f) => f !== ref) : [...favorites, ref] });

  if (models.length === 0) {
    return (
      <button type="button" onClick={() => navigate("/settings/providers")} className="text-muted-foreground hover:text-foreground rounded-lg px-2 py-1 text-xs">
        Connect a provider
      </button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="group hover:bg-muted text-muted-foreground hover:text-foreground aria-expanded:bg-muted flex h-7 pointer-coarse:h-9 max-w-56 min-w-0 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors duration-(--motion-fast) ease-out-quart"
        aria-label="Choose model"
        data-command="composer.model"
      >
        <TextSwap value={active?.name ?? "Choose model"} className="truncate" />
        <ChevronDownIcon className="size-3 shrink-0 transition-transform duration-(--motion-base) ease-out-expo group-aria-expanded:rotate-180" />
      </PopoverTrigger>
      <PopoverContent data-slot="model-picker" side="top" className="flex max-h-[min(32rem,70dvh)] w-[min(26rem,calc(100vw-1rem))] flex-col p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <SearchIcon className="text-muted-foreground size-4" />
          <input
            // Touch: focusing opens the keyboard over the list people came to scroll.
            autoFocus={window.matchMedia("(pointer: fine)").matches}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "Enter") return;
              const first = e.currentTarget.closest("[data-slot=model-picker]")?.querySelector<HTMLElement>("[role=option]");
              if (!first) return;
              e.preventDefault();
              if (e.key === "Enter") first.click();
              else first.focus();
            }}
            placeholder="Search models"
            className="placeholder:text-muted-foreground h-7 pointer-coarse:h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </div>
        <ScrollArea className="flex-1" viewportClassName="p-1">
          {groups.map((group) => (
            <div key={group.id} className="mb-1">
              <div className="text-muted-foreground flex items-center gap-2 px-2 pt-2 pb-1 text-xs font-medium">
                {group.label}
                {group.id === OPENCODE_GO && <span className="bg-primary/10 text-primary rounded px-1.5 text-[10px]">Primary</span>}
              </div>
              {group.models.map((m) => (
                <div
                  key={`${group.id}:${m.ref}`}
                  role="option"
                  aria-selected={m.ref === active?.ref}
                  aria-keyshortcuts="F"
                  tabIndex={0}
                  onClick={() => {
                    selectModel(m.ref, threadId);
                    setOpen(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectModel(m.ref, threadId);
                      setOpen(false);
                      return;
                    }
                    if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey && !e.altKey) {
                      e.preventDefault();
                      void toggleFavorite(m.ref);
                      return;
                    }
                    // Arrows walk the options; up from the first one returns to the search field.
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
                  }}
                  className="group hover:bg-accent focus-visible:bg-accent flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 pointer-coarse:py-2.5 active:bg-accent outline-none transition-colors duration-(--motion-fast) ease-out-quart"
                >
                  <CheckIcon className={cn("size-3.5 shrink-0 transition-opacity duration-(--motion-fast) ease-out-quart", m.ref === active?.ref ? "opacity-100" : "opacity-0")} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-sm">
                      <span className="truncate">{m.name}</span>
                      <Capabilities model={m} />
                    </div>
                    <div className="text-muted-foreground flex gap-2 text-[11px] tabular-nums">
                      <span>{formatTokens(m.context)} ctx</span>
                      {price(m) && <span>{price(m)}</span>}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={favorites.includes(m.ref) ? "Unfavorite" : "Favorite"}
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
              ))}
            </div>
          ))}
          {groups.length === 0 && <p className="text-muted-foreground px-3 py-6 text-center text-sm">No models match.</p>}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "Instant",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** Shared by the desktop effort menu and the mobile composer menu. */
export function useEffortChoices() {
  const active = useChatModel();
  const efforts = useData((s) => s.settings?.reasoningEffort ?? {});
  const updateSettings = useData((s) => s.updateSettings);
  const current = active ? efforts[active.ref] : undefined;
  const options = (active?.reasoningEfforts?.length ? active.reasoningEfforts : ["low", "medium", "high"]) as ReasoningEffort[];
  const set = (effort: ReasoningEffort | undefined) => {
    if (active) void updateSettings({ reasoningEffort: { ...efforts, [active.ref]: effort as never } });
  };
  return { active, current, options, set };
}

/** "Instant" means reasoning is off, which only exists for models that offer it. */
export function EffortPicker() {
  const { active, current, options, set } = useEffortChoices();
  if (!active?.reasoning) return null;
  const instant = current === "none";
  return (
    <Menu>
      <MenuTrigger data-command="composer.effort" aria-label={`Reasoning effort: ${current ? EFFORT_LABELS[current] : "Default"}`} className="hover:bg-muted text-muted-foreground hover:text-foreground aria-expanded:bg-muted flex h-7 shrink-0 pointer-coarse:h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors duration-(--motion-fast) ease-out-quart">
        {instant ? <ZapIcon className="size-3.5" /> : <BrainIcon className="size-3.5" />}
        <TextSwap value={current ? EFFORT_LABELS[current] : "Default"} />
      </MenuTrigger>
      <MenuContent side="top">
        <MenuLabel>Reasoning effort</MenuLabel>
        <MenuItem onClick={() => set(undefined)}>
          <CheckIcon className={cn(!current ? "opacity-100" : "opacity-0")} />
          Model default
        </MenuItem>
        {options.map((e) => (
          <MenuItem key={e} onClick={() => set(e)}>
            <CheckIcon className={cn(current === e ? "opacity-100" : "opacity-0")} />
            {EFFORT_LABELS[e] ?? e}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
