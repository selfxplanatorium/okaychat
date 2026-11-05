import { useEffect, useMemo, useState } from "react";
import { CheckIcon, FunnelIcon, PencilIcon, TagIcon, Trash2Icon, XIcon } from "lucide-react";
import { MAX_TAGS_IN_FILTER, MAX_TAG_PRESET_NAME } from "@shared/tags";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { useTagFilter } from "@/state/tag-filter";

/**
 * The sidebar's tag filter: ANDs with the project filter and the title search. Filter state is per
 * account in localStorage; saved presets come from the server so another device sees them too.
 */
export function TagFilterBar() {
  const accountId = useData((s) => s.me?.id);
  const { tags, presets, filter, busy, error, load } = useTagFilter();
  const setFilter = useTagFilter((s) => s.setFilter);
  const clear = useTagFilter((s) => s.clear);
  const applyPreset = useTagFilter((s) => s.applyPreset);
  const savePreset = useTagFilter((s) => s.savePreset);
  const renamePreset = useTagFilter((s) => s.renamePreset);
  const deletePreset = useTagFilter((s) => s.deletePreset);
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [busyName, setBusyName] = useState(false);

  useEffect(() => {
    if (accountId) void load(accountId);
  }, [accountId, load]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tags.filter((item) => !query || item.tag.includes(query));
  }, [tags, search]);

  if (!tags.length && !filter.tags.length) return null;

  const toggle = (tag: string) => {
    const next = filter.tags.includes(tag) ? filter.tags.filter((item) => item !== tag) : [...filter.tags, tag];
    if (next.length > MAX_TAGS_IN_FILTER) return;
    setFilter({ tags: next });
  };

  const run = async (task: () => Promise<void>) => {
    setBusyName(true);
    try {
      await task();
    } catch {
      // The store keeps the translated failure for the inline alert below.
    } finally {
      setBusyName(false);
    }
  };

  return (
    <div className="flex flex-col gap-1 px-2 pb-2">
      <Menu>
        <MenuTrigger
          data-command="tags.filter"
          className="text-sidebar-muted-foreground hover:bg-sidebar-row-hover focus-visible:outline-ring flex min-h-8 w-full items-center gap-2 rounded-lg px-2.5 text-start text-xs pointer-coarse:min-h-11"
        >
          <FunnelIcon aria-hidden className="size-3.5 shrink-0" />
          {filter.tags.length ? (
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              {filter.tags.map((tag) => (
                <span key={tag} className="bg-sidebar-row-hover text-sidebar-foreground max-w-[6rem] truncate rounded-full px-1.5 py-0.5">
                  #{tag}
                </span>
              ))}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate">{t("tags.filterByTag")}</span>
          )}
          <span className="text-sidebar-muted-foreground shrink-0 text-[10px] tabular-nums">{filter.tags.length || tags.length}</span>
        </MenuTrigger>
        <MenuContent side="bottom" align="start" className="max-h-[min(30rem,var(--available-height))] w-72 max-w-[calc(100vw-1rem)]">
          <MenuLabel>{t("tags.filterByTag")}</MenuLabel>
          <div className="px-1 pb-1">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("tags.searchTags")}
              aria-label={t("tags.searchTags")}
              className="h-8"
            />
          </div>
          {visible.length === 0 && <p className="text-muted-foreground px-2.5 py-2 text-xs">{t("tags.noTags")}</p>}
          {visible.map((item) => {
            const checked = filter.tags.includes(item.tag);
            return (
              <MenuItem key={item.tag} closeOnClick={false} onClick={() => toggle(item.tag)} className="pointer-coarse:min-h-11">
                <CheckIcon className={cn("size-4", checked ? "opacity-100" : "opacity-0")} />
                <span className="min-w-0 flex-1 truncate">#{item.tag}</span>
                <span className="text-muted-foreground text-xs tabular-nums">{item.count}</span>
              </MenuItem>
            );
          })}
          <MenuSeparator />
          <div className="px-2 pb-1.5">
            <SegmentedControl
              aria-label={t("tags.selectedTags")}
              className="w-fit"
              value={filter.match}
              onValueChange={(value) => setFilter({ match: value === "all" ? "all" : "any" })}
              items={[
                { value: "any", label: t("tags.matchAny") },
                { value: "all", label: t("tags.matchAll") },
              ]}
            />
          </div>
          <MenuSeparator />
          <MenuLabel>{t("tags.savedFilters")}</MenuLabel>
          {presets.map((preset) => (
            <div key={preset.id} className="flex items-center gap-1 rounded-lg px-1 py-0.5 hover:bg-sidebar-row-hover">
              {renaming?.id === preset.id ? (
                <Input
                  autoFocus
                  value={renaming.name}
                  aria-label={t("tags.renameFilter")}
                  onChange={(event) => setRenaming({ id: preset.id, name: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      const next = renaming.name.trim();
                      setRenaming(null);
                      if (next) void run(() => renamePreset(preset.id, next));
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setRenaming(null);
                    }
                  }}
                  className="h-7 min-w-0 flex-1"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => applyPreset(preset.id)}
                  className="focus-visible:outline-ring flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-start text-sm pointer-coarse:min-h-11"
                >
                  <TagIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                  <span className="text-muted-foreground text-xs tabular-nums">{preset.filter.tags.length}</span>
                </button>
              )}
              <button
                type="button"
                aria-label={t("tags.renameFilter")}
                onClick={() => setRenaming({ id: preset.id, name: preset.name })}
                className="text-muted-foreground hover:bg-background focus-visible:outline-ring rounded-md p-1.5 pointer-coarse:p-2.5"
              >
                <PencilIcon className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={t("tags.deleteFilter")}
                disabled={busyName}
                onClick={() => void run(() => deletePreset(preset.id))}
                className="text-muted-foreground hover:bg-background hover:text-destructive focus-visible:outline-ring rounded-md p-1.5 pointer-coarse:p-2.5"
              >
                <Trash2Icon className="size-3.5" />
              </button>
            </div>
          ))}
          <MenuSeparator />
          <div className="flex items-end gap-1 px-1 pb-1.5">
            <Input
              value={name}
              maxLength={MAX_TAG_PRESET_NAME}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("tags.filterName")}
              aria-label={t("tags.filterName")}
              className="h-8 min-w-0 flex-1"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!name.trim() || busyName}
              onClick={() => {
                const next = name.trim();
                if (!next) return;
                setName("");
                void run(() => savePreset(next));
              }}
            >
              {t("tags.saveFilter")}
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-destructive px-2.5 pb-1 text-xs">
              {t(error)}
            </p>
          )}
          <MenuItem disabled={busy || !filter.tags.length} onClick={clear}>
            <XIcon /> {t("tags.clearFilter")}
          </MenuItem>
        </MenuContent>
      </Menu>
      {filter.tags.length > 0 && (
        <button
          type="button"
          onClick={clear}
          className="text-sidebar-muted-foreground hover:text-sidebar-foreground self-start px-1 text-[11px] underline underline-offset-2"
        >
          {t("tags.clearFilter")}
        </button>
      )}
    </div>
  );
}
