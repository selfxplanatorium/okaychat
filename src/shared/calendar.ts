import {
  MAX_INSTANT_EXCLUSIVE,
  MINUTE_MS,
  allDayBounds,
  canonicalZone,
  civilDayDifference,
  isMinuteInstant,
  isValidInstant,
  parseDateString,
  type CivilDate,
} from "./calendar-time.js";
import { codePointLength, hasControl, hasNul, isSafeId, utf8Bytes } from "./notes.js";

/**
 * Personal calendar events. Timed events are absolute instants plus the IANA zone they were entered in;
 * all-day events are civil dates with an exclusive end. Neither is a scheduled prompt, and neither is
 * sent to a model. See docs/implementation/calendar.md.
 */

export const MAX_EVENTS = 10_000;
export const MAX_EVENT_TITLE_CHARS = 200;
export const MAX_EVENT_TITLE_BYTES = 800;
export const MAX_EVENT_DESCRIPTION_CHARS = 20_000;
export const MAX_EVENT_DESCRIPTION_BYTES = 64 * 1024;
export const MAX_EVENT_LOCATION_CHARS = 500;
export const MAX_EVENT_LOCATION_BYTES = 2 * 1024;
export const MAX_EVENT_URL_BYTES = 2_048;
export const MAX_REMINDERS = 5;
export const MAX_REMINDER_OFFSET_MINUTES = 40_320;
export const MAX_EVENT_SPAN_DAYS = 366;
export const MAX_RANGE_DAYS = 93;
export const CALENDAR_PAGE_DEFAULT = 50;
export const CALENDAR_PAGE_MAX = 100;
export const CALENDAR_WRITE_LIMIT = 128 * 1024;
export const CALENDAR_SMALL_LIMIT = 4 * 1024;
export const RESOLVE_RATE_PER_MINUTE = 20;

export type EventTime =
  | { allDay: false; timeZone: string; startAt: number; endAt: number; startDate: null; endDate: null }
  | { allDay: true; timeZone: string; startAt: null; endAt: null; startDate: string; endDate: string };

export type CalendarEventWrite = EventTime & {
  title: string;
  description: string;
  location: string;
  url: string;
  reminderOffsets: number[];
  threadId: string | null;
  projectId: string | null;
};

export type CalendarEvent = CalendarEventWrite & {
  id: string;
  revision: number;
  reminderRevision: number;
  createdAt: number;
  updatedAt: number;
  /** Derived UTC bounds; never accepted from a client. */
  effectiveStartAt: number;
  effectiveEndAt: number;
};

export type CalendarEventSummary = Omit<CalendarEvent, "description" | "location" | "url">;

export interface CalendarPage {
  items: CalendarEventSummary[];
  nextCursor: string | null;
}

export type CalendarCreate = CalendarEventWrite & {
  requestId: string;
};

export type CalendarUpdate = CalendarEventWrite & {
  revision: number;
};

export interface CalendarTimeCandidate {
  at: number;
  offsetMinutes: number;
  label: string;
}

export interface CalendarResolveResult {
  startCandidates: CalendarTimeCandidate[];
  endCandidates: CalendarTimeCandidate[];
}

export interface CalendarReminderOffset {
  minutes: number;
}

export type CalendarProblem =
  | "invalidTitle"
  | "titleRequired"
  | "titleTooLong"
  | "invalidDescription"
  | "descriptionTooLong"
  | "invalidLocation"
  | "locationTooLong"
  | "invalidUrl"
  | "urlTooLong"
  | "invalidZone"
  | "invalidRange"
  | "tooLong"
  | "invalidOffsets"
  | "invalidLink"
  | "invalidTime";

export type Checked<T> = { ok: true; value: T } | { ok: false; problem: CalendarProblem };

const URL_CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Empty, or an absolute http(s) URL without embedded credentials or control characters. Private hosts
 * are allowed: this is a user-click navigation target, never a server fetch.
 */
export function checkEventUrl(value: unknown): { ok: true; value: string } | { ok: false; problem: CalendarProblem } {
  if (typeof value !== "string") return { ok: false, problem: "invalidUrl" };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: "" };
  if (utf8Bytes(trimmed) > MAX_EVENT_URL_BYTES) return { ok: false, problem: "urlTooLong" };
  if (URL_CONTROL.test(trimmed)) return { ok: false, problem: "invalidUrl" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, problem: "invalidUrl" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, problem: "invalidUrl" };
  if (url.username || url.password) return { ok: false, problem: "invalidUrl" };
  if (!url.hostname) return { ok: false, problem: "invalidUrl" };
  return { ok: true, value: trimmed };
}

function textField(
  value: unknown,
  options: { trim: boolean; maxChars: number; maxBytes: number; required?: boolean; allowNewlines?: boolean },
): { ok: true; value: string } | { ok: false; problem: CalendarProblem } {
  if (typeof value !== "string" || hasNul(value)) return { ok: false, problem: "invalidTitle" };
  const normalized = options.trim ? value.trim() : value;
  if (options.required && !normalized) return { ok: false, problem: "titleRequired" };
  if (codePointLength(normalized) > options.maxChars || utf8Bytes(normalized) > options.maxBytes) {
    return { ok: false, problem: options.maxChars === MAX_EVENT_TITLE_CHARS ? "titleTooLong" : options.maxChars === MAX_EVENT_LOCATION_CHARS ? "locationTooLong" : "descriptionTooLong" };
  }
  if (options.allowNewlines) {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(normalized)) return { ok: false, problem: "invalidDescription" };
  } else if (hasControl(normalized)) {
    return { ok: false, problem: options.maxChars === MAX_EVENT_TITLE_CHARS ? "invalidTitle" : "invalidLocation" };
  }
  return { ok: true, value: normalized };
}

/** Reminder offsets: 0–5 unique whole minutes, 0–40,320, sorted ascending. */
export function checkReminderOffsets(value: unknown): { ok: true; value: number[] } | { ok: false; problem: "invalidOffsets" } {
  if (!Array.isArray(value) || value.length > MAX_REMINDERS) return { ok: false, problem: "invalidOffsets" };
  const offsets: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry > MAX_REMINDER_OFFSET_MINUTES) {
      return { ok: false, problem: "invalidOffsets" };
    }
    if (offsets.includes(entry)) return { ok: false, problem: "invalidOffsets" };
    offsets.push(entry);
  }
  offsets.sort((a, b) => a - b);
  return { ok: true, value: offsets };
}

export interface CheckedEventWrite {
  write: CalendarEventWrite;
  effectiveStartAt: number;
  effectiveEndAt: number;
  startDate: CivilDate | null;
  endDate: CivilDate | null;
}

/** Strict event validation, including the derived all-day bounds. Pure and shared. */
export function checkCalendarEventWrite(value: unknown): Checked<CheckedEventWrite> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, problem: "invalidTime" };
  const input = value as Record<string, unknown>;
  const title = textField(input.title, { trim: true, maxChars: MAX_EVENT_TITLE_CHARS, maxBytes: MAX_EVENT_TITLE_BYTES, required: true });
  if (!title.ok) return title;
  const description = textField(input.description, { trim: false, maxChars: MAX_EVENT_DESCRIPTION_CHARS, maxBytes: MAX_EVENT_DESCRIPTION_BYTES, allowNewlines: true });
  if (!description.ok) return description;
  const location = textField(input.location, { trim: true, maxChars: MAX_EVENT_LOCATION_CHARS, maxBytes: MAX_EVENT_LOCATION_BYTES });
  if (!location.ok) return location;
  const url = checkEventUrl(input.url);
  if (!url.ok) return url;
  const zone = canonicalZone(input.timeZone);
  if (!zone) return { ok: false, problem: "invalidZone" };
  const offsets = checkReminderOffsets(input.reminderOffsets);
  if (!offsets.ok) return offsets;
  if (input.threadId !== null && !isSafeId(input.threadId)) return { ok: false, problem: "invalidLink" };
  if (input.projectId !== null && !isSafeId(input.projectId)) return { ok: false, problem: "invalidLink" };

  let time: EventTime;
  let effectiveStartAt: number;
  let effectiveEndAt: number;
  let startDate: CivilDate | null = null;
  let endDate: CivilDate | null = null;
  if (input.allDay === true) {
    const start = parseDateString(input.startDate);
    const end = parseDateString(input.endDate);
    if (!start || !end) return { ok: false, problem: "invalidRange" };
    if (input.startAt !== null || input.endAt !== null) return { ok: false, problem: "invalidTime" };
    if (civilDayDifference(start, end) <= 0) return { ok: false, problem: "invalidRange" };
    if (civilDayDifference(start, end) > MAX_EVENT_SPAN_DAYS) return { ok: false, problem: "tooLong" };
    const bounds = allDayBounds(zone, start, end);
    if (!bounds) return { ok: false, problem: "invalidRange" };
    effectiveStartAt = bounds.startAt;
    effectiveEndAt = bounds.endAt;
    startDate = start;
    endDate = end;
    time = { allDay: true, timeZone: zone, startAt: null, endAt: null, startDate: input.startDate as string, endDate: input.endDate as string };
  } else if (input.allDay === false) {
    if (!isMinuteInstant(input.startAt) || !isMinuteInstant(input.endAt)) return { ok: false, problem: "invalidTime" };
    if (input.startDate !== null || input.endDate !== null) return { ok: false, problem: "invalidTime" };
    if (input.endAt <= input.startAt) return { ok: false, problem: "invalidRange" };
    if (input.endAt - input.startAt > MAX_EVENT_SPAN_DAYS * 24 * 60 * MINUTE_MS) return { ok: false, problem: "tooLong" };
    if (input.endAt >= MAX_INSTANT_EXCLUSIVE) return { ok: false, problem: "invalidTime" };
    effectiveStartAt = input.startAt;
    effectiveEndAt = input.endAt;
    time = { allDay: false, timeZone: zone, startAt: input.startAt, endAt: input.endAt, startDate: null, endDate: null };
  } else {
    return { ok: false, problem: "invalidTime" };
  }

  return {
    ok: true,
    value: {
      write: {
        ...time,
        title: title.value,
        description: description.value,
        location: location.value,
        url: url.value,
        reminderOffsets: offsets.value,
        threadId: input.threadId as string | null,
        projectId: input.projectId as string | null,
      },
      effectiveStartAt,
      effectiveEndAt,
      startDate,
      endDate,
    },
  };
}

/** UTF-8 bytes one event charges against the storage quota. */
export const eventBytes = (write: Pick<CalendarEventWrite, "title" | "description" | "location" | "url">): number =>
  utf8Bytes(write.title) + utf8Bytes(write.description) + utf8Bytes(write.location) + utf8Bytes(write.url);

/** A range query is a positive half-open interval of at most 93 elapsed days. */
export function checkRange(from: unknown, to: unknown): { ok: true; from: number; to: number } | { ok: false } {
  if (!isValidInstant(from) || !isValidInstant(to)) return { ok: false };
  if (to <= from) return { ok: false };
  if (to - from > MAX_RANGE_DAYS * 86_400_000) return { ok: false };
  return { ok: true, from, to };
}

/** The reminder schedule identity: only these changes rebuild the ledger. */
export function reminderSignature(event: Pick<CalendarEvent, "effectiveStartAt" | "timeZone" | "allDay" | "startDate" | "reminderOffsets">): string {
  return JSON.stringify([event.effectiveStartAt, event.timeZone, event.allDay, event.startDate, event.reminderOffsets]);
}
