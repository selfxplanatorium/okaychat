import { BrainIcon, CheckIcon, ChevronDownIcon, EyeIcon, SearchIcon, StarIcon, WrenchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import type { ModelInfo, ReasoningEffort } from "@shared/types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { TextSwap } from "@/components/assistant-ui/elements/surfaces";
import { formatTokens } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useActiveModel, useData } from "@/state/data";

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

export function ModelPicker() {
  const models = useData((s) => s.models);
  const providers = useData((s) => s.providers);
  const favorites = useData((s) => s.settings?.favoriteModels ?? []);
  const updateSettings = useData((s) => s.updateSettings);
  const selectModel = useData((s) => s.selectModel);
  const active = useActiveModel();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();

  const groups = useMemo(() => {
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
        className="group hover:bg-muted text-muted-foreground hover:text-foreground aria-expanded:bg-muted flex h-7 max-w-56 min-w-0 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors duration-(--motion-fast) ease-out-quart"
        aria-label="Choose model"
      >
        <TextSwap value={active?.name ?? "Choose model"} className="truncate" />
        <ChevronDownIcon className="size-3 shrink-0 transition-transform duration-(--motion-base) ease-out-expo group-aria-expanded:rotate-180" />
      </PopoverTrigger>
      <PopoverContent side="top" className="flex max-h-[min(32rem,70vh)] w-[min(26rem,92vw)] flex-col p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <SearchIcon className="text-muted-foreground size-4" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models"
            className="placeholder:text-muted-foreground h-7 flex-1 bg-transparent text-sm outline-none"
          />
        </div>
        <div className="flex-1 overflow-y-auto p-1">
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
                  tabIndex={0}
                  onClick={() => {
                    selectModel(m.ref);
                    setOpen(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      selectModel(m.ref);
                      setOpen(false);
                    }
                  }}
                  className="group hover:bg-accent focus-visible:bg-accent flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 outline-none transition-colors duration-(--motion-fast) ease-out-quart"
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
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleFavorite(m.ref);
                    }}
                    className={cn(
                      "text-muted-foreground hover:text-foreground rounded p-1 opacity-0 transition-[opacity,color] duration-(--motion-fast) ease-out-quart group-hover:opacity-100",
                      favorites.includes(m.ref) && "text-warning opacity-100",
                    )}
                  >
                    <StarIcon className={cn("size-3.5", favorites.includes(m.ref) && "fill-current")} />
                  </button>
                </div>
              ))}
            </div>
          ))}
          {groups.length === 0 && <p className="text-muted-foreground px-3 py-6 text-center text-sm">No models match.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function EffortPicker() {
  const active = useActiveModel();
  const efforts = useData((s) => s.settings?.reasoningEffort ?? {});
  const updateSettings = useData((s) => s.updateSettings);
  if (!active?.reasoning) return null;
  const options = (active.reasoningEfforts?.length ? active.reasoningEfforts : ["low", "medium", "high"]) as ReasoningEffort[];
  const current = efforts[active.ref];
  return (
    <Menu>
      <MenuTrigger className="hover:bg-muted text-muted-foreground hover:text-foreground aria-expanded:bg-muted flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors duration-(--motion-fast) ease-out-quart">
        <BrainIcon className="size-3.5" />
        <TextSwap value={current ? EFFORT_LABELS[current] : "Default"} />
      </MenuTrigger>
      <MenuContent side="top">
        <MenuLabel>Reasoning effort</MenuLabel>
        <MenuItem onClick={() => updateSettings({ reasoningEffort: { ...efforts, [active.ref]: undefined as never } })}>
          <CheckIcon className={cn(!current ? "opacity-100" : "opacity-0")} />
          Model default
        </MenuItem>
        {options.map((e) => (
          <MenuItem key={e} onClick={() => updateSettings({ reasoningEffort: { ...efforts, [active.ref]: e } })}>
            <CheckIcon className={cn(current === e ? "opacity-100" : "opacity-0")} />
            {EFFORT_LABELS[e] ?? e}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
