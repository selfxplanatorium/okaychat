import { useMemo, useState } from "react";
import type { CalendarEventSummary } from "@shared/calendar";
import { t } from "@/i18n";
import { formatDate } from "@/i18n/format";
import { addCivilDays, mondayIndex, parseDateString } from "@shared/calendar-time";
import { allDayDates, placeTimedEvent } from "@/lib/calendar-layout";
import { EventCard } from "./EventCard";

const dayLabel = (date: string) => formatDate(`${date}T12:00:00Z`, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
function formatDateString(date: { year: number; month: number; day: number }): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

/** Six-week Monday grid. One roving tab stop; arrows move by day/week, PageUp/PageDown by month. */
export function MonthView({
  dates,
  events,
  zone,
  anchor,
  today,
  onOpen,
  onDay,
  onNewOnDay,
}: {
  dates: string[];
  events: CalendarEventSummary[];
  zone: string;
  anchor: string;
  today: string;
  onOpen: (id: string) => void;
  onDay: (date: string) => void;
  onNewOnDay: (date: string) => void;
}) {
  const grouped = useMemo(() => {
    const map = new Map<string, CalendarEventSummary[]>();
    for (const event of events) {
      if (event.allDay) {
        for (const date of allDayDates(event)) map.set(date, [...(map.get(date) ?? []), event]);
      } else {
        for (const segment of placeTimedEvent(event, dates, zone)) map.set(segment.date, [...(map.get(segment.date) ?? []), event]);
      }
    }
    return map;
  }, [dates, events, zone]);
  const [focus, setFocus] = useState(dates.includes(today) ? today : anchor);
  const anchorDate = parseDateString(anchor) ?? { year: 1970, month: 1, day: 1 };
  // Weekday names follow the active locale; never format them at module load.
  const weekdayLabels = useMemo(
    () => Array.from({ length: 7 }, (_, index) =>
      formatDate(`${formatDateString(addCivilDays({ year: 2024, month: 1, day: 1 }, index))}T12:00:00Z`, { weekday: "short", timeZone: "UTC" }),
    ),
    [],
  );

  const move = (days: number) => {
    const date = parseDateString(focus) ?? anchorDate;
    const next = formatDateString(addCivilDays(date, days));
    if (!dates.includes(next)) return;
    setFocus(next);
    document.querySelector<HTMLElement>(`[data-month-day="${next}"]`)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
    else if (event.key === "ArrowDown") { event.preventDefault(); move(7); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(-7); }
    else if (event.key === "Home") { event.preventDefault(); move(-mondayIndex(parseDateString(focus) ?? anchorDate)); }
    else if (event.key === "End") { event.preventDefault(); move(6 - mondayIndex(parseDateString(focus) ?? anchorDate)); }
    else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      const date = parseDateString(focus) ?? anchorDate;
      const probe = new Date(Date.UTC(date.year, date.month - 1 + (event.key === "PageUp" ? -1 : 1), 1));
      const days = new Date(Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth() + 1, 0)).getUTCDate();
      const next = formatDateString({ year: probe.getUTCFullYear(), month: probe.getUTCMonth() + 1, day: Math.min(date.day, days) });
      setFocus(next);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onDay(focus);
    } else if (event.key === " ") {
      event.preventDefault();
      onNewOnDay(focus);
    }
  };

  return (
    <div className="flex flex-col gap-1 p-2">
      <p className="text-muted-foreground px-1 text-xs">{t("calendar.weekStarts")}</p>
      <div className="grid grid-cols-7 gap-1 px-1">
        {weekdayLabels.map((label, index) => <span key={index} className="text-muted-foreground text-center text-[0.7rem] font-medium">{label}</span>)}
      </div>
      <div role="grid" aria-label={t("calendar.month")} className="grid grid-cols-7 gap-1" onKeyDown={onKeyDown}>
        {dates.map((date) => {
          const inMonth = (parseDateString(date)?.month ?? 0) === anchorDate.month;
          const items = grouped.get(date) ?? [];
          const visible = items.slice(0, 3);
          return (
            <div
              key={date}
              role="gridcell"
              aria-selected={focus === date}
              className={`flex min-h-24 flex-col gap-0.5 rounded-lg border p-1 ${inMonth ? "bg-background" : "bg-muted/30 text-muted-foreground"} ${today === date ? "border-primary" : "border-border"}`}
            >
              <button
                type="button"
                data-month-day={date}
                tabIndex={focus === date ? 0 : -1}
                onFocus={() => setFocus(date)}
                onClick={() => onDay(date)}
                aria-label={dayLabel(date)}
                className="focus-visible:outline-ring self-start rounded px-1 text-xs font-medium"
              >
                {parseDateString(date)?.day}
              </button>
              {visible.map((event) => <EventCard key={`${date}-${event.id}`} event={event} zone={zone} onOpen={onOpen} compact />)}
              {items.length > 3 && (
                <button type="button" onClick={() => onDay(date)} className="text-muted-foreground hover:text-foreground text-start text-[0.65rem]">
                  {t("calendar.more", { count: items.length - 3 })}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
