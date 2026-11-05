import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_INSTANT_EXCLUSIVE,
  allDayBounds,
  canonicalZone,
  firstValidMinuteOfDate,
  formatDateString,
  formatInZone,
  isMinuteInstant,
  parseDateString,
  parseLocalDateTime,
  resolveLocalCandidates,
} from "../shared/calendar-time.js";

test("strict dates: leap years, real days, and the supported year range", () => {
  assert.deepEqual(parseDateString("2024-02-29"), { year: 2024, month: 2, day: 29 });
  assert.equal(parseDateString("2026-02-29"), null);
  assert.equal(parseDateString("2026-13-01"), null);
  assert.equal(parseDateString("2026-1-01"), null);
  assert.equal(parseDateString("1969-12-31"), null);
  assert.equal(parseDateString("2101-01-01"), null);
  assert.equal(formatDateString({ year: 2100, month: 12, day: 31 }), "2100-12-31");
  assert.equal(parseLocalDateTime("2026-01-01T24:00"), null);
  assert.equal(parseLocalDateTime("2026-01-01T23:59")?.minute, 59);
});

test("Europe/Rome spring gap has no candidate and the autumn fold has two explicit offsets", () => {
  const gap = resolveLocalCandidates("Europe/Rome", parseLocalDateTime("2026-03-29T02:30")!);
  assert.deepEqual(gap, []);
  const fold = resolveLocalCandidates("Europe/Rome", parseLocalDateTime("2026-10-25T02:30")!);
  assert.deepEqual(fold.map((candidate) => [new Date(candidate.at).toISOString(), candidate.offsetMinutes]), [
    ["2026-10-25T00:30:00.000Z", 120],
    ["2026-10-25T01:30:00.000Z", 60],
  ]);
});

test("a non-hour zone and a half-hour DST transition resolve correctly", () => {
  const kathmandu = resolveLocalCandidates("Asia/Kathmandu", parseLocalDateTime("2026-05-01T10:00")!);
  assert.deepEqual(kathmandu.map((candidate) => [new Date(candidate.at).toISOString(), candidate.offsetMinutes]), [["2026-05-01T04:15:00.000Z", 345]]);
  const gap = resolveLocalCandidates("Australia/Lord_Howe", parseLocalDateTime("2026-10-04T02:15")!);
  assert.deepEqual(gap, []);
  const fold = resolveLocalCandidates("Australia/Lord_Howe", parseLocalDateTime("2026-04-05T01:45")!);
  assert.deepEqual(fold.map((candidate) => candidate.offsetMinutes), [660, 630]);
});

test("a skipped midnight starts at the first valid minute, and a skipped civil date fails", () => {
  const santiago = firstValidMinuteOfDate("America/Santiago", { year: 2026, month: 9, day: 6 });
  assert.equal(santiago, Date.parse("2026-09-06T04:00:00.000Z"));
  assert.equal(firstValidMinuteOfDate("Pacific/Apia", { year: 2011, month: 12, day: 30 }), null);
});

test("all-day bounds are exact civil days, including 23 and 25 hour days, with an exclusive end", () => {
  const spring = allDayBounds("Europe/Rome", { year: 2026, month: 3, day: 29 }, { year: 2026, month: 3, day: 30 });
  assert.ok(spring);
  assert.equal(spring.endAt - spring.startAt, 23 * 60 * 60 * 1000);
  assert.equal(new Date(spring.startAt).toISOString(), "2026-03-28T23:00:00.000Z");
  const autumn = allDayBounds("Europe/Rome", { year: 2026, month: 10, day: 25 }, { year: 2026, month: 10, day: 26 });
  assert.ok(autumn);
  assert.equal(autumn.endAt - autumn.startAt, 25 * 60 * 60 * 1000);
  const multi = allDayBounds("UTC", { year: 2026, month: 1, day: 1 }, { year: 2026, month: 1, day: 3 });
  assert.equal(multi?.endAt, Date.parse("2026-01-03T00:00:00.000Z"));
});

test("zone names are canonical, and numeric offsets are refused", () => {
  assert.equal(canonicalZone("Europe/Rome"), "Europe/Rome");
  assert.equal(canonicalZone("UTC"), "UTC");
  assert.equal(canonicalZone("+02:00"), null);
  assert.equal(canonicalZone("UTC+1"), null);
  assert.equal(canonicalZone("Not/AZone"), null);
  assert.equal(canonicalZone(""), null);
});

test("instants are minute-aligned, bounded, and round trip through a zone", () => {
  assert.equal(isMinuteInstant(60_000), true);
  assert.equal(isMinuteInstant(60_001), false);
  assert.equal(isMinuteInstant(-1), false);
  assert.equal(isMinuteInstant(MAX_INSTANT_EXCLUSIVE), false);
  assert.equal(isMinuteInstant(MAX_INSTANT_EXCLUSIVE - 60_000), true);
  const at = Date.parse("2026-07-01T12:34:00.000Z");
  const parts = formatInZone("Europe/Rome", at);
  assert.deepEqual([parts.year, parts.month, parts.day, parts.hour, parts.minute], [2026, 7, 1, 14, 34]);
});

test("the host timezone never changes a stored civil result", () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Kiritimati";
    const first = resolveLocalCandidates("Europe/Rome", parseLocalDateTime("2026-06-01T09:00")!)[0]!.at;
    process.env.TZ = "America/Adak";
    const second = resolveLocalCandidates("Europe/Rome", parseLocalDateTime("2026-06-01T09:00")!)[0]!.at;
    assert.equal(first, second);
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
