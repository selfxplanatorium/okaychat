import assert from "node:assert/strict";
import { test } from "node:test";
import type { CalendarEventSummary } from "@shared/calendar";
import {
  agendaDates,
  allDayDates,
  monthDates,
  overlapColumns,
  placeTimedEvent,
  shiftAnchor,
  viewBounds,
  weekDates,
} from "./calendar-layout.js";

const event = (over: Partial<CalendarEventSummary>): CalendarEventSummary => ({
  id: "e1",
  title: "Event",
  allDay: false,
  timeZone: "UTC",
  startAt: 0,
  endAt: 60_000,
  startDate: null,
  endDate: null,
  reminderOffsets: [],
  threadId: null,
  projectId: null,
  revision: 1,
  reminderRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  effectiveStartAt: 0,
  effectiveEndAt: 60_000,
  ...over,
});

test("month and week grids start on Monday and cover the whole month", () => {
  const march = monthDates("2026-03-15");
  assert.equal(march.length, 42);
  assert.equal(march[0], "2026-02-23");
  assert.equal(march.at(-1), "2026-04-05");
  assert.deepEqual(weekDates("2026-03-15").slice(0, 2), ["2026-03-09", "2026-03-10"]);
  assert.equal(monthDates("2024-02-10")[0], "2024-01-29");
  assert.equal(agendaDates("2026-12-31", 3).at(-1), "2027-01-02");
});

test("navigation clamps the day and stays inside the supported range", () => {
  assert.equal(shiftAnchor("month", "2026-01-31", 1), "2026-02-28");
  assert.equal(shiftAnchor("month", "2024-01-31", 1), "2024-02-29");
  assert.equal(shiftAnchor("week", "2026-03-15", -1), "2026-03-08");
  assert.equal(shiftAnchor("agenda", "2026-03-15", 1), "2026-04-14");
});

test("view bounds are expanded by 26 hours and stay under the 93-day cap", () => {
  const month = viewBounds("month", "2026-03-15", "Europe/Rome");
  assert.ok(month.to > month.from);
  assert.ok(month.to - month.from < 93 * 86_400_000);
  const agenda = viewBounds("agenda", "2026-03-15", "Europe/Rome");
  assert.equal(agenda.dates.length, 30);
});

test("all-day placement uses an exclusive end", () => {
  const dates = allDayDates(event({ allDay: true, startDate: "2026-03-29", endDate: "2026-03-31", startAt: null, endAt: null }));
  assert.deepEqual(dates, ["2026-03-29", "2026-03-30"]);
});

test("overnight timed events split across visible days with continuation flags", () => {
  const start = Date.parse("2026-03-15T22:00:00.000Z");
  const end = Date.parse("2026-03-16T02:00:00.000Z");
  const segments = placeTimedEvent(event({ effectiveStartAt: start, effectiveEndAt: end }), ["2026-03-15", "2026-03-16"], "UTC");
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map((segment) => [segment.date, segment.startMinute, segment.endMinute]), [
    ["2026-03-15", 22 * 60, 1440],
    ["2026-03-16", 0, 120],
  ]);
  assert.equal(segments[0]!.continuesAfter, true);
  assert.equal(segments[1]!.continuesBefore, true);
});

test("overlap columns are deterministic and shared per connected cluster", () => {
  const placements = overlapColumns([
    { id: "b", startAt: 0, endAt: 60 },
    { id: "a", startAt: 0, endAt: 60 },
    { id: "c", startAt: 30, endAt: 90 },
    { id: "d", startAt: 200, endAt: 260 },
  ]);
  assert.deepEqual(placements.get("a"), { column: 0, columns: 3 });
  assert.deepEqual(placements.get("b"), { column: 1, columns: 3 });
  assert.deepEqual(placements.get("c"), { column: 2, columns: 3 });
  assert.deepEqual(placements.get("d"), { column: 0, columns: 1 });
});


test("new timed events use the chosen calendar day, including midnight crossings", async () => {
  const { newEventTimes } = await import("./calendar-layout.js");
  assert.deepEqual(newEventTimes("UTC", "2026-12-10", Date.UTC(2026, 10, 5, 12, 10)), {
    start: "2026-12-10T12:30", end: "2026-12-10T13:30",
  });
  assert.deepEqual(newEventTimes("UTC", "2026-12-31", Date.UTC(2026, 10, 5, 22, 45)), {
    start: "2026-12-31T23:00", end: "2027-01-01T00:00",
  });
});
