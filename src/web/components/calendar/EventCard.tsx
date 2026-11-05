import type { CalendarEventSummary } from "@shared/calendar";
import { t } from "@/i18n";
import { formatDate, formatTime } from "@/i18n/format";
import { cn } from "@/lib/utils";

/** One accessible event button; the visible label is short, the accessible name carries full dates. */
export function EventCard({
  event,
  zone,
  onOpen,
  className,
  compact = false,
}: {
  event: CalendarEventSummary;
  zone: string;
  onOpen: (id: string) => void;
  className?: string;
  compact?: boolean;
}) {
  const label = event.allDay
    ? t("calendar.allDayLabel", {
        title: event.title,
        start: formatDate(`${event.startDate}T12:00:00Z`, { dateStyle: "medium", timeZone: "UTC" }),
        end: formatDate(`${event.endDate}T12:00:00Z`, { dateStyle: "medium", timeZone: "UTC" }),
      })
    : t("calendar.eventLabel", {
        title: event.title,
        start: formatDate(event.effectiveStartAt, { dateStyle: "medium", timeStyle: "short", timeZone: zone }),
        end: formatDate(event.effectiveEndAt, { dateStyle: "medium", timeStyle: "short", timeZone: zone }),
        zone: event.timeZone,
      });
  return (
    <button
      type="button"
      onClick={() => onOpen(event.id)}
      aria-label={label}
      title={label}
      className={cn(
        "depth-row-active focus-visible:outline-ring block w-full min-w-0 truncate rounded-md border-s-2 border-current bg-muted/60 px-1.5 text-start text-xs leading-5 hover:bg-muted",
        compact && "text-[0.7rem] leading-4",
        className,
      )}
    >
      {!event.allDay && !compact && <span className="text-muted-foreground me-1 tabular-nums">{formatTime(event.effectiveStartAt, { timeStyle: "short", timeZone: zone })}</span>}
      {event.title}
    </button>
  );
}
