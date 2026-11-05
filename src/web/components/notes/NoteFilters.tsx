import { SearchIcon, StarIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { NoteTagCount } from "@shared/notes";
import type { Project } from "@shared/types";
import { t } from "@/i18n";
import { formatNumber } from "@/i18n/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { NotesFilters } from "@/state/notes";

/** Search and filter chips. Every control is reachable and every filter ANDs with the rest. */
export function NoteFilters({
  filters,
  onChange,
  tags,
  projects,
}: {
  filters: NotesFilters;
  onChange: (patch: Partial<NotesFilters>) => void;
  tags: NoteTagCount[];
  projects: Project[];
}) {
  const [search, setSearch] = useState(filters.q);
  useEffect(() => setSearch(filters.q), [filters.q]);
  useEffect(() => {
    if (search === filters.q) return;
    const timer = setTimeout(() => onChange({ q: search }), 300);
    return () => clearTimeout(timer);
  }, [search, filters.q, onChange]);

  const chip = (active: boolean) =>
    cn(
      "inline-flex min-h-8 pointer-coarse:min-h-11 items-center gap-1 rounded-full border px-3 text-xs font-medium transition-colors",
      active ? "depth-primary text-primary-foreground border-transparent" : "bg-muted/50 text-muted-foreground hover:text-foreground border-transparent",
    );

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <SearchIcon aria-hidden className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label={t("notes.search")}
          placeholder={t("notes.search")}
          data-command="notes.search"
          className="ps-8"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" aria-pressed={filters.favorite === null && filters.pinned === null} className={chip(filters.favorite === null && filters.pinned === null)} onClick={() => onChange({ favorite: null, pinned: null })}>
          {t("notes.all")}
        </button>
        <button type="button" aria-pressed={filters.favorite === true} className={chip(filters.favorite === true)} onClick={() => onChange({ favorite: filters.favorite === true ? null : true })}>
          <StarIcon aria-hidden className="size-3.5" /> {t("notes.favorites")}
        </button>
        <button type="button" aria-pressed={filters.pinned === true} className={chip(filters.pinned === true)} onClick={() => onChange({ pinned: filters.pinned === true ? null : true })}>
          {t("notes.pinned")}
        </button>
        {(filters.q || filters.favorite !== null || filters.pinned !== null || filters.projectId !== undefined || filters.tags.length > 0) && (
          <Button variant="ghost" size="sm" onClick={() => onChange({ q: "", favorite: null, pinned: null, projectId: undefined, tags: [], tagMatch: "any" })}>
            {t("notes.clearFilters")}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select
          aria-label={t("notes.tags")}
          className="h-8 w-auto min-w-32"
          value={filters.tags[0] ?? ""}
          onValueChange={(value) => onChange({ tags: value ? [value] : [] })}
          options={[
            { value: "", label: t("notes.tags") },
            ...tags.map((tag) => ({ value: tag.tag, label: `${tag.tag} (${formatNumber(tag.count)})` })),
          ]}
        />
        {filters.tags.length > 0 && (
          <Select
            aria-label={t("notes.tagMatchAny")}
            className="h-8 w-auto"
            value={filters.tagMatch}
            onValueChange={(value) => onChange({ tagMatch: value as "any" | "all" })}
            options={[
              { value: "any", label: t("notes.tagMatchAny") },
              { value: "all", label: t("notes.tagMatchAll") },
            ]}
          />
        )}
        <Select
          aria-label={t("notes.project")}
          className="h-8 w-auto min-w-32"
          value={filters.projectId === undefined ? "" : filters.projectId === null ? "none" : filters.projectId}
          onValueChange={(value) => onChange({ projectId: value === "" ? undefined : value === "none" ? null : value })}
          options={[
            { value: "", label: t("notes.allProjects") },
            { value: "none", label: t("notes.noProject") },
            ...projects.map((project) => ({ value: project.id, label: project.name })),
          ]}
        />
      </div>
    </div>
  );
}
