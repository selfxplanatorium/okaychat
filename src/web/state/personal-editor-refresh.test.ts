import assert from "node:assert/strict";
import { test } from "node:test";
import { useNotes } from "./notes.js";
import { useCalendar } from "./calendar.js";

// A refreshed record would reset EventDialog and advance its revision even when its form is dirty.
// Notes can likewise disappear on a background 404, unmounting the recovery controls.
test("background workspace refresh preserves the selected editor and its CAS base", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const path = String(input);
    paths.push(path);
    return Response.json(path.includes("/tags") ? { tags: [] } : { items: [], nextCursor: null });
  };
  try {
    useNotes.setState({ accountId: "alice", selectedId: "note_1", selectedStatus: "ready" });
    useCalendar.setState({ accountId: "alice", selectedId: "evt_1", selectedStatus: "ready", anchor: "2026-11-05", zone: "UTC" });
    await useNotes.getState().refresh();
    await useCalendar.getState().refresh();
    assert.equal(useNotes.getState().selectedId, "note_1");
    assert.equal(useCalendar.getState().selectedId, "evt_1");
    assert.equal(useNotes.getState().selectedStatus, "ready");
    assert.equal(useCalendar.getState().selectedStatus, "ready");
    assert(paths.some((path) => path.includes("/calendar/events?")));
    assert(!paths.some((path) => path.endsWith("/note_1") || path.endsWith("/evt_1")));
  } finally {
    globalThis.fetch = original;
    useNotes.getState().reset();
    useCalendar.getState().reset();
  }
});
