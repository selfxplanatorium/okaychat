import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { CalendarView } from "@/lib/calendar-layout";
import { TimeZonePicker } from "./TimeZonePicker";

/** View controls: navigation, view choice, display zone, scoped search, and New event. */
export function CalendarToolbar({
  view,
  zone,
  rangeLabel,
  count,
  search,
  onView,
  onToday,
  onPrevious,
  onNext,
  onZone,
  onSearch,
  onNew,
}: {
  view: CalendarView;
  zone: string;
  rangeLabel: string;
  count: number;
  search: string;
  onView: (view: CalendarView) => void;
  onToday: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onZone: (zone: string) => void;
  onSearch: (value: string) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState(search);
  useEffect(() => setQuery(search), [search]);
  useEffect(() => {
    if (query === search) return;
    const timer = setTimeout(() => onSearch(query), 300);
    return () => clearTimeout(timer);
  }, [query, search, onSearch]);

  const views: Array<{ id: CalendarView; label: string; command: string }> = [
    { id: "agenda", label: t("calendar.agenda"), command: "calendar.agenda" },
    { id: "month", label: t("calendar.month"), command: "calendar.month" },
    { id: "week", label: t("calendar.week"), command: "calendar.week" },
  ];

  return (
    <header className="border-border flex shrink-0 flex-col gap-2 border-b px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-base font-semibold">{t("calendar.title")}</h1>
        <span className="text-muted-foreground text-xs">{t("calendar.count", { count })}</span>
        <div className="ms-auto flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={onToday} data-command="calendar.today">{t("calendar.today")}</Button>
          <Button size="icon-sm" variant="ghost" aria-label={t("calendar.previous")} onClick={onPrevious} data-command="calendar.previous"><ChevronLeftIcon /></Button>
          <Button size="icon-sm" variant="ghost" aria-label={t("calendar.next")} onClick={onNext} data-command="calendar.next"><ChevronRightIcon /></Button>
          <Button size="sm" onClick={onNew} data-command="calendar.create"><PlusIcon aria-hidden /> {t("calendar.new")}</Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label={t("calendar.title")} className="bg-muted/50 flex items-center gap-0.5 rounded-lg p-0.5">
          {views.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={view === item.id}
              data-command={item.command}
              onClick={() => onView(item.id)}
              className={cn("min-h-7 rounded-md px-2 text-xs pointer-coarse:min-h-11", view === item.id ? "bg-background font-medium" : "text-muted-foreground")}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="text-sm font-medium">{rangeLabel}</span>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <SearchIcon aria-hidden className="text-muted-foreground pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t("calendar.search")}
              placeholder={t("calendar.search")}
              data-command="calendar.search"
              className="h-8 w-48 ps-7 text-xs"
            />
          </div>
          <span className="text-muted-foreground text-xs">{t("calendar.viewZone")}</span>
          <TimeZonePicker value={zone} onChange={onZone} />
        </div>
      </div>
    </header>
  );
}
