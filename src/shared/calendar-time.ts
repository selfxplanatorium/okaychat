/**
 * Pure calendar time arithmetic. No dependency: native `Intl` is the zone database. A civil date-time is
 * resolved by scanning every whole-minute UTC offset it could denote, then keeping the ones that format
 * back to exactly the same civil tuple. That bounded scan is what makes a spring-forward gap (no
 * candidate) and an autumn fold (two candidates) explicit instead of silently guessing.
 *
 * Server and browser may ship different zone data, so `/api/calendar/resolve-time` is authoritative for
 * editing; a stored timed event keeps its instant.
 */

/** 1970-01-01T00:00:00.000Z, the first accepted instant. */
export const MIN_INSTANT = 0;
/** 2101-01-01T00:00:00.000Z exclusive: the last accepted instant is in 2100. */
export const MAX_INSTANT_EXCLUSIVE = Date.UTC(2101, 0, 1);
export const MIN_YEAR = 1970;
export const MAX_YEAR = 2100;
export const MINUTE_MS = 60_000;

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

export interface CivilDateTime extends CivilDate {
  hour: number;
  minute: number;
}

export interface CalendarTimeCandidate {
  /** Absolute epoch milliseconds. */
  at: number;
  /** Minutes east of UTC at that instant. */
  offsetMinutes: number;
  /** Numeric UTC offset such as `+02:00`; never localized prose. */
  label: string;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Strict YYYY-MM-DD with a real Gregorian day inside the supported year range. */
export function parseDateString(value: unknown): CivilDate | null {
  if (typeof value !== "string") return null;
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

export const isValidDateString = (value: unknown): value is string => parseDateString(value) !== null;

/** `YYYY-MM-DD` from a civil date, without ever going through a local timezone. */
export function formatDateString(date: CivilDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export function isValidInstant(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_INSTANT && value < MAX_INSTANT_EXCLUSIVE;
}

export const isMinuteInstant = (value: unknown): value is number => isValidInstant(value) && value % MINUTE_MS === 0;

/** Adds whole civil days to a date. */
export function addCivilDays(date: CivilDate, days: number): CivilDate {
  const probe = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: probe.getUTCFullYear(), month: probe.getUTCMonth() + 1, day: probe.getUTCDate() };
}

/** Whole civil days from `a` to `b` (b - a). */
export function civilDayDifference(a: CivilDate, b: CivilDate): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

export const sameCivilDate = (a: CivilDate, b: CivilDate): boolean =>
  a.year === b.year && a.month === b.month && a.day === b.day;

/** 0 = Monday … 6 = Sunday, independent of locale. */
export function mondayIndex(date: CivilDate): number {
  return (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(zone, formatter);
  }
  return formatter;
}

/** Formats an instant in `zone` as a civil tuple. Throws for an unusable zone. */
export function formatInZone(zone: string, at: number): CivilDateTime & { second: number } {
  const parts = zoneFormatter(zone).formatToParts(new Date(at));
  const pick = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? NaN);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    // `h23` can still report 24 for midnight in some runtimes.
    hour: pick("hour") % 24,
    minute: pick("minute"),
    second: pick("second"),
  };
}

/** Minutes east of UTC at an instant, derived from a round trip rather than a second API. */
export function zoneOffsetMinutes(zone: string, at: number): number {
  const civil = formatInZone(zone, at);
  const asUtc = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute, civil.second);
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / MINUTE_MS);
}

const NUMERIC_OFFSET = /^[+-]?\d{1,2}:?\d{0,2}$/;
const OFFSET_PREFIX = /^(?:UTC|GMT)[+-]/i;

/**
 * Canonical IANA name, or null. Numeric offsets and `UTC+1`-style identifiers are refused even when the
 * runtime accepts them, because they are not stable zone identities across DST changes.
 */
export function canonicalZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 100 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (NUMERIC_OFFSET.test(trimmed) || OFFSET_PREFIX.test(trimmed)) return null;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
    if (!resolved || NUMERIC_OFFSET.test(resolved) || OFFSET_PREFIX.test(resolved)) return null;
    return resolved;
  } catch {
    return null;
  }
}

export function isKnownZone(value: unknown): boolean {
  return canonicalZone(value) !== null;
}

/** A numeric UTC offset for display, e.g. `+02:00`, `-05:30`, `+00:00`. */
export function offsetLabel(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Parses `YYYY-MM-DDTHH:mm` (minute precision, no zone suffix). */
export function parseLocalDateTime(value: unknown): CivilDateTime | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const date = parseDateString(match[1]);
  if (!date) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (hour > 23 || minute > 59) return null;
  return { ...date, hour, minute };
}

export function formatLocalDateTime(value: CivilDateTime): string {
  return `${formatDateString(value)}T${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;
}

const resolutionCache = new Map<string, CalendarTimeCandidate[]>();
const RESOLUTION_CACHE_LIMIT = 100;

function rememberResolution(key: string, candidates: CalendarTimeCandidate[]): CalendarTimeCandidate[] {
  if (resolutionCache.size >= RESOLUTION_CACHE_LIMIT) {
    const oldest = resolutionCache.keys().next().value;
    if (oldest !== undefined) resolutionCache.delete(oldest);
  }
  resolutionCache.set(key, candidates);
  return candidates;
}

/**
 * Every instant whose civil representation in `zone` is exactly the requested tuple. Zero means a
 * daylight-saving gap; two means a fold. Results are sorted by instant, then deduped.
 */
export function resolveLocalCandidates(zone: string, local: CivilDateTime): CalendarTimeCandidate[] {
  const canonical = canonicalZone(zone);
  if (!canonical) return [];
  const key = `${canonical}|${local.year}-${local.month}-${local.day}T${local.hour}:${local.minute}`;
  const cached = resolutionCache.get(key);
  if (cached) return cached;
  const nominal = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const found = new Map<number, CalendarTimeCandidate>();
  for (let offset = -1440; offset <= 1440; offset++) {
    const at = nominal - offset * MINUTE_MS;
    if (at < MIN_INSTANT || at >= MAX_INSTANT_EXCLUSIVE) continue;
    const civil = formatInZone(canonical, at);
    if (
      civil.year === local.year &&
      civil.month === local.month &&
      civil.day === local.day &&
      civil.hour === local.hour &&
      civil.minute === local.minute
    ) {
      found.set(at, { at, offsetMinutes: offset, label: offsetLabel(offset) });
    }
  }
  const candidates = [...found.values()].sort((a, b) => a.at - b.at);
  return rememberResolution(key, candidates);
}

/** Convenience for a stored local date-time string. */
export function resolveLocalString(zone: string, value: string): CalendarTimeCandidate[] {
  const local = parseLocalDateTime(value);
  return local ? resolveLocalCandidates(zone, local) : [];
}

const dateOrdinal = (date: CivilDate): number => date.year * 10_000 + date.month * 100 + date.day;

/**
 * The first valid minute of a civil date in `zone`, or null when the whole date is skipped. A binary
 * search over the ±26-hour window around the nominal UTC midnight finds the first minute whose local
 * date reaches the target; a skipped midnight therefore lands on the transition minute, and a skipped
 * date overshoots to the next day and is rejected.
 */
export function firstValidMinuteOfDate(zone: string, date: CivilDate): number | null {
  const canonical = canonicalZone(zone);
  if (!canonical) return null;
  const nominal = Date.UTC(date.year, date.month - 1, date.day);
  const target = dateOrdinal(date);
  const ordinalAt = (minute: number): number => {
    const civil = formatInZone(canonical, minute * MINUTE_MS);
    return dateOrdinal(civil);
  };
  let low = Math.floor((nominal - 26 * 60 * MINUTE_MS) / MINUTE_MS);
  let high = Math.ceil((nominal + 26 * 60 * MINUTE_MS) / MINUTE_MS);
  if (ordinalAt(low) >= target) return ordinalAt(low) === target ? low * MINUTE_MS : null;
  if (ordinalAt(high) < target) return null;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (ordinalAt(middle) >= target) high = middle;
    else low = middle;
  }
  return ordinalAt(high) === target ? high * MINUTE_MS : null;
}

/**
 * UTC bounds of an all-day range. `endDate` is exclusive. Each boundary is the first valid minute of
 * that local date, so a 23- or 25-hour day stays exactly one civil day long. Null when a boundary date
 * does not exist in the zone (a silently shifted day would be worse).
 */
export function allDayBounds(zone: string, startDate: CivilDate, endDate: CivilDate): { startAt: number; endAt: number } | null {
  const startAt = firstValidMinuteOfDate(zone, startDate);
  if (startAt === null) return null;
  const endAt = firstValidMinuteOfDate(zone, endDate);
  if (endAt === null || endAt <= startAt) return null;
  return { startAt, endAt };
}

/** Milliseconds between two instants, in whole minutes (floored). */
export const minutesBetween = (startAt: number, endAt: number): number => Math.floor((endAt - startAt) / MINUTE_MS);

/** A local date plus a minute-of-day as an `HH:mm` clock label, for grid placement. */
export function clockLabel(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60) % 24;
  const minute = minuteOfDay % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
