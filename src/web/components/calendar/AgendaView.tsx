import type { CalendarEventSummary } from "@shared/calendar";
import { t } from "@/i18n";
import { formatDate } from "@/i18n/format";
import { allDayDates, placeTimedEvent } from "@/lib/calendar-layout";
import { EventCard } from "./EventCard";

/** Agenda over the visible civil dates. Empty days stay hidden; only days with events appear. */
export function AgendaView({
  dates,
  events,
  zone,
  onOpen,
  dense,
  onLoadMore,
  loadingMore,
}: {
  dates: string[];
  events: CalendarEventSummary[];
  zone: string;
  onOpen: (id: string) => void;
  dense: boolean;
  onLoadMore: () => void;
  loadingMore: boolean;
}) {
  const groups = new Map<string, CalendarEventSummary[]>();
  for (const event of events) {
    if (event.allDay) {
      for (const date of allDayDates(event)) {
        if (!dates.includes(date)) continue;
        groups.set(date, [...(groups.get(date) ?? []), event]);
      }
    } else {
      for (const segment of placeTimedEvent(event, dates, zone)) {
        groups.set(segment.date, [...(groups.get(segment.date) ?? []), event]);
      }
    }
  }
  const days = [...groups.keys()].sort();
  if (!days.length) {
    return (
      <div className="flex flex-col items-center gap-1 p-8 text-center">
        <p className="text-sm font-medium">{t("calendar.empty")}</p>
        <p className="text-muted-foreground text-sm">{t("calendar.emptyBody")}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5 p-4">
      {dense && (
        <div role="status" className="border-warning/40 bg-warning/5 rounded-lg border p-3 text-sm">
          <p>{t("calendar.dense")}</p>
          <button type="button" className="text-primary mt-1 text-xs underline" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? t("calendar.loadingMore") : t("calendar.more", { count: events.length })}
          </button>
        </div>
      )}
      {days.map((date) => {
        const items = groups.get(date)!;
        return (
          <section key={date} aria-label={t("calendar.dayAgenda", { date: formatDate(`${date}T12:00:00Z`, { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }) })}>
            <h2 className="text-muted-foreground mb-1 text-xs font-medium uppercase tracking-wide">
              {formatDate(`${date}T12:00:00Z`, { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })}
            </h2>
            <ul className="flex flex-col gap-1">
              {items.map((event) => (
                <li key={`${date}-${event.id}`}>
                  <EventCard event={event} zone={zone} onOpen={onOpen} className="bg-transparent px-1 py-1.5 hover:bg-muted" />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
