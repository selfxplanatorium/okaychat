import type { CalendarEventSummary } from "@shared/calendar";
import { t } from "@/i18n";
import { formatDate, formatTime } from "@/i18n/format";
import { addCivilDays, clockLabel, firstValidMinuteOfDate, offsetLabel, parseDateString, zoneOffsetMinutes } from "@shared/calendar-time";
import { allDayDates, overlapColumns, placeTimedEvent, type DaySegment } from "@/lib/calendar-layout";
import { EventCard } from "./EventCard";

const HOUR_PX = 40;
const dayTitle = (date: string) => formatDate(`${date}T12:00:00Z`, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** Week: all-day lane, a 24-hour scroll grid, and an always-available accessible list. */
export function WeekView({
  dates,
  events,
  zone,
  onOpen,
}: {
  dates: string[];
  events: CalendarEventSummary[];
  zone: string;
  onOpen: (id: string) => void;
}) {
  const segments = dates.map((date) => {
    const list: Array<{ event: CalendarEventSummary; segment: DaySegment | null }> = events.flatMap((event): Array<{ event: CalendarEventSummary; segment: DaySegment | null }> => {
      if (event.allDay) return allDayDates(event).includes(date) ? [{ event, segment: null }] : [];
      return placeTimedEvent(event, [date], zone).map((segment) => ({ event, segment }));
    });
    const timed = list.filter((item): item is { event: CalendarEventSummary; segment: DaySegment } => item.segment !== null);
    const placements = overlapColumns(timed.map((item) => ({ id: `${item.event.id}:${date}`, startAt: item.segment.startMinute, endAt: item.segment.endMinute })));
    return { date, allDay: list.filter((item) => item.segment === null).map((item) => item.event), timed, placements };
  });
  const unique = [...new Map(events.map((event) => [event.id, event])).values()];

  return (
    <div className="flex min-h-0 flex-col">
      <p className="text-muted-foreground px-3 pt-2 text-xs">{t("calendar.weekStarts")}</p>
      <div className="overflow-x-auto p-2">
        <div className="grid min-w-[42rem] grid-cols-[3rem_repeat(7,minmax(0,1fr))] gap-1">
          <div />
          {segments.map(({ date }) => {
            const parsed = parseDateString(date);
            const next = parsed ? addCivilDays(parsed, 1) : null;
            const start = parsed ? firstValidMinuteOfDate(zone, parsed) : null;
            const end = next ? firstValidMinuteOfDate(zone, next) : null;
            const offsetChanged = start !== null && end !== null && zoneOffsetMinutes(zone, start) !== zoneOffsetMinutes(zone, end);
            return (
              <div key={date} className="text-center">
                <div className="text-xs font-medium">{dayTitle(date)}</div>
                {offsetChanged && start !== null && <div className="text-muted-foreground text-[0.65rem]">{offsetLabel(zoneOffsetMinutes(zone, start))}</div>}
              </div>
            );
          })}
          <div className="text-muted-foreground flex items-center justify-center text-[0.65rem]">{t("calendar.allDay")}</div>
          {segments.map(({ date, allDay }) => (
            <div key={`all-${date}`} className="min-h-8 rounded-md border border-border/60 p-0.5">
              {allDay.map((event) => <EventCard key={`${date}-${event.id}`} event={event} zone={zone} onOpen={onOpen} compact className="mb-0.5" />)}
            </div>
          ))}
          <div className="text-muted-foreground relative" style={{ height: 24 * HOUR_PX }}>
            {Array.from({ length: 24 }, (_, hour) => (
              <div key={hour} className="text-end text-[0.65rem]" style={{ height: HOUR_PX }}>
                {formatTime(Date.UTC(2020, 0, 1, hour), { timeStyle: "short", timeZone: "UTC" })}
              </div>
            ))}
          </div>
          {segments.map(({ date, timed, placements }) => (
            <div key={`grid-${date}`} className="relative border-s border-border/60" style={{ height: 24 * HOUR_PX }}>
              {Array.from({ length: 24 }, (_, hour) => (
                <div key={hour} className="border-border/30 border-t" style={{ height: HOUR_PX }} aria-hidden />
              ))}
              {timed.map(({ event, segment }) => {
                const placement = placements.get(`${event.id}:${date}`) ?? { column: 0, columns: 1 };
                const top = (segment.startMinute / 60) * HOUR_PX;
                const height = Math.max(20, ((segment.endMinute - segment.startMinute) / 60) * HOUR_PX);
                return (
                  <div
                    key={`${event.id}:${date}`}
                    className="absolute px-0.5"
                    style={{
                      top,
                      height,
                      insetInlineStart: `${(placement.column / placement.columns) * 100}%`,
                      width: `${100 / placement.columns}%`,
                    }}
                  >
                    <EventCard event={event} zone={zone} onOpen={onOpen} compact className="h-full overflow-hidden" />
                    <span className="sr-only">{clockLabel(segment.startMinute)}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <details className="border-border mx-2 mb-2 rounded-lg border p-2">
        <summary className="cursor-pointer text-sm">{t("calendar.listWeek")}</summary>
        <ul className="mt-2 flex flex-col gap-1">
          {unique.map((event) => (
            <li key={event.id}><EventCard event={event} zone={zone} onOpen={onOpen} /></li>
          ))}
          {!unique.length && <li className="text-muted-foreground text-sm">{t("calendar.empty")}</li>}
        </ul>
      </details>
    </div>
  );
}
