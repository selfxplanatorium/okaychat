import type { CalendarEventSummary } from "@shared/calendar";
import {
  MAX_INSTANT_EXCLUSIVE,
  MIN_INSTANT,
  addCivilDays,
  firstValidMinuteOfDate,
  formatDateString,
  formatInZone,
  mondayIndex,
  parseDateString,
  type CivilDate,
} from "@shared/calendar-time";

/**
 * View math for the calendar. Pure: month/week grids, the UTC fetch window (expanded by 26 hours so an
 * all-day event in another zone is never lost), overnight splits, and deterministic overlap columns.
 */

export type CalendarView = "agenda" | "month" | "week";

export const AGENDA_DAYS = 30;
export const EXPANSION_MS = 26 * 60 * 60 * 1000;

export function monthDates(anchor: string): string[] {
  const date = parseDateString(anchor) ?? { year: 1970, month: 1, day: 1 };
  const first = { year: date.year, month: date.month, day: 1 };
  const start = addCivilDays(first, -mondayIndex(first));
  return Array.from({ length: 42 }, (_, index) => formatDateString(addCivilDays(start, index)));
}

export function weekDates(anchor: string): string[] {
  const date = parseDateString(anchor) ?? { year: 1970, month: 1, day: 1 };
  const monday = addCivilDays(date, -mondayIndex(date));
  return Array.from({ length: 7 }, (_, index) => formatDateString(addCivilDays(monday, index)));
}

export function agendaDates(anchor: string, count = AGENDA_DAYS): string[] {
  const date = parseDateString(anchor) ?? { year: 1970, month: 1, day: 1 };
  return Array.from({ length: count }, (_, index) => formatDateString(addCivilDays(date, index)));
}

export function viewDates(view: CalendarView, anchor: string): string[] {
  if (view === "month") return monthDates(anchor);
  if (view === "week") return weekDates(anchor);
  return agendaDates(anchor);
}

/** The UTC fetch window for a view. `from`/`to` stay inside the supported range. */
export function viewBounds(view: CalendarView, anchor: string, zone: string): { dates: string[]; from: number; to: number } {
  const dates = viewDates(view, anchor);
  const first = parseDateString(dates[0]!) ?? { year: 1970, month: 1, day: 1 };
  const last = parseDateString(dates.at(-1)!) ?? first;
  const start = firstValidMinuteOfDate(zone, first) ?? Date.UTC(first.year, first.month - 1, first.day);
  const end = firstValidMinuteOfDate(zone, addCivilDays(last, 1)) ?? Date.UTC(last.year, last.month - 1, last.day + 1);
  const from = Math.max(MIN_INSTANT, start - EXPANSION_MS);
  const to = Math.min(MAX_INSTANT_EXCLUSIVE, end + EXPANSION_MS);
  return { dates, from, to };
}

export function shiftAnchor(view: CalendarView, anchor: string, direction: -1 | 1): string {
  const date = parseDateString(anchor) ?? { year: 1970, month: 1, day: 1 };
  if (view === "agenda") return formatDateString(addCivilDays(date, direction * AGENDA_DAYS));
  if (view === "week") return formatDateString(addCivilDays(date, direction * 7));
  const month = date.month - 1 + direction;
  const probe = new Date(Date.UTC(date.year, month, 1));
  const daysInTarget = new Date(Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth() + 1, 0)).getUTCDate();
  return formatDateString({
    year: probe.getUTCFullYear(),
    month: probe.getUTCMonth() + 1,
    day: Math.min(date.day, daysInTarget),
  });
}

export function shiftAnchorDays(anchor: string, days: number): string {
  const date = parseDateString(anchor) ?? { year: 1970, month: 1, day: 1 };
  return formatDateString(addCivilDays(date, days));
}

export function todayInZone(zone: string, now = Date.now()): string {
  const civil = formatInZone(zone, now);
  return formatDateString({ year: civil.year, month: civil.month, day: civil.day });
}

export interface DaySegment {
  date: string;
  startMinute: number;
  endMinute: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
  startLabel: string;
  endLabel: string;
}

const clock = (at: number, zone: string): string => {
  const civil = formatInZone(zone, at);
  return `${String(civil.hour).padStart(2, "0")}:${String(civil.minute).padStart(2, "0")}`;
};

/** Splits a timed event across the visible civil dates in the view zone. */
export function placeTimedEvent(event: Pick<CalendarEventSummary, "effectiveStartAt" | "effectiveEndAt">, dates: readonly string[], zone: string): DaySegment[] {
  const segments: DaySegment[] = [];
  for (let index = 0; index < dates.length; index++) {
    const date = parseDateString(dates[index]!);
    if (!date) continue;
    const dayStart = firstValidMinuteOfDate(zone, date);
    const next = parseDateString(dates[index + 1] ?? "");
    const dayEnd = next
      ? firstValidMinuteOfDate(zone, next)
      : dayStart === null
        ? null
        : dayStart + 24 * 60 * 60 * 1000;
    if (dayStart === null || dayEnd === null) continue;
    const start = Math.max(dayStart, event.effectiveStartAt);
    const end = Math.min(dayEnd, event.effectiveEndAt);
    if (end <= start) continue;
    const startParts = formatInZone(zone, start);
    const endParts = formatInZone(zone, end);
    const startsAtDay = start === dayStart;
    const endsAtDay = end === dayEnd;
    segments.push({
      date: dates[index]!,
      startMinute: startsAtDay ? 0 : startParts.hour * 60 + startParts.minute,
      endMinute: endsAtDay ? 1440 : endParts.hour * 60 + endParts.minute,
      continuesBefore: event.effectiveStartAt < start,
      continuesAfter: event.effectiveEndAt > end,
      startLabel: clock(start, zone),
      endLabel: clock(end, zone),
    });
  }
  return segments;
}

/** Civil dates an all-day event occupies: start inclusive, end exclusive. */
export function allDayDates(event: Pick<CalendarEventSummary, "allDay" | "startDate" | "endDate">): string[] {
  if (!event.allDay || !event.startDate || !event.endDate) return [];
  const start = parseDateString(event.startDate);
  const end = parseDateString(event.endDate);
  if (!start || !end) return [];
  const out: string[] = [];
  for (let cursor = start; formatDateString(cursor) < formatDateString(end); cursor = addCivilDays(cursor, 1)) {
    out.push(formatDateString(cursor));
    if (out.length > 366) break;
  }
  return out;
}

export interface ColumnPlacement {
  column: number;
  columns: number;
}

/** Lowest free column per interval, then the shared maximum across each connected overlap cluster. */
export function overlapColumns(events: ReadonlyArray<{ id: string; startAt: number; endAt: number }>): Map<string, ColumnPlacement> {
  const sorted = [...events].sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const columns = new Map<string, number>();
  const columnEnds: number[] = [];
  for (const event of sorted) {
    let column = columnEnds.findIndex((end) => end <= event.startAt);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(event.endAt);
    } else {
      columnEnds[column] = event.endAt;
    }
    columns.set(event.id, column);
  }
  // Connected components by interval overlap; each component shares one column count.
  const placement = new Map<string, ColumnPlacement>();
  const remaining = new Set(sorted.map((event) => event.id));
  const byId = new Map(sorted.map((event) => [event.id, event]));
  while (remaining.size) {
    const seed = byId.get(remaining.values().next().value!)!;
    const cluster: typeof sorted = [];
    let clusterEnd = seed.endAt;
    for (const event of sorted) {
      if (!remaining.has(event.id)) continue;
      if (event.startAt < clusterEnd) {
        cluster.push(event);
        remaining.delete(event.id);
        clusterEnd = Math.max(clusterEnd, event.endAt);
      }
    }
    const width = Math.max(...cluster.map((event) => (columns.get(event.id) ?? 0) + 1));
    for (const event of cluster) placement.set(event.id, { column: columns.get(event.id) ?? 0, columns: width });
  }
  return placement;
}

export function isSupportedDate(value: string): boolean {
  const date = parseDateString(value);
  return !!date && date.year >= 1970 && date.year <= 2100;
}

export const civilDate = (value: string): CivilDate | null => parseDateString(value);

/** An event is "dense" once a visible range exceeds this many summaries. */
export const DENSE_RANGE_LIMIT = 600;
