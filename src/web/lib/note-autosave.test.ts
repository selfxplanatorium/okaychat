import assert from "node:assert/strict";
import { test } from "node:test";
import type { Note, NoteWrite } from "@shared/notes";
import { NoteAutosave, type NoteAutosaveState } from "./note-autosave.js";

const note = (revision = 1): Note => ({
  id: "note_1",
  title: "Title",
  body: "Body",
  favorite: false,
  pinned: false,
  tags: ["a"],
  projectId: null,
  revision,
  createdAt: 1,
  updatedAt: 1,
  source: null,
  sourceAvailable: false,
});

const write = (over: Partial<NoteWrite> = {}): NoteWrite => ({ title: "Title", body: "Body", favorite: false, pinned: false, tags: ["a"], projectId: null, ...over });

function harness(save: (value: NoteWrite, revision: number) => Promise<Note>) {
  const timers = new Set<() => void>();
  const states: NoteAutosaveState[] = [];
  const controller = new NoteAutosave(note(), {
    save,
    onChange: (state) => states.push(state),
    schedule: (run) => {
      timers.add(run);
      return run;
    },
    cancel: (handle) => timers.delete(handle as () => void),
    online: () => true,
  });
  const runTimers = () => {
    const pending = [...timers];
    timers.clear();
    for (const run of pending) run();
  };
  return { controller, states, runTimers, timers };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("edits debounce and coalesce into one write with the latest value", async () => {
  let calls = 0;
  const { controller, runTimers } = harness(async (value, revision) => {
    calls++;
    assert.equal(revision, 1);
    assert.equal(value.body, "second");
    return { ...note(2), body: value.body };
  });
  controller.edit(write({ body: "first" }));
  controller.edit(write({ body: "second" }));
  assert.equal(calls, 0);
  runTimers();
  await tick();
  assert.equal(calls, 1);
  assert.equal(controller.state().status, "saved");
  assert.equal(controller.state().revision, 2);
});

test("typing during an in-flight write keeps dirty state and writes again after the acknowledgement", async () => {
  let release!: (note: Note) => void;
  let calls = 0;
  const { controller, runTimers } = harness((value, revision) => {
    calls++;
    if (calls === 1) {
      assert.equal(revision, 1);
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    assert.equal(revision, 2);
    return Promise.resolve({ ...note(3), body: value.body });
  });
  controller.edit(write({ body: "one" }));
  runTimers();
  await tick();
  controller.edit(write({ body: "two" }));
  assert.equal(controller.state().status, "dirty");
  release({ ...note(2), body: "one" });
  await tick();
  await tick();
  assert.equal(controller.state().status, "dirty");
  runTimers();
  await tick();
  assert.equal(controller.state().status, "saved");
  assert.equal(controller.state().value.body, "two");
});

test("a conflict stops automatic writes and keeps the local value", async () => {
  const { controller, runTimers } = harness(async () => {
    throw { status: 409 };
  });
  controller.edit(write({ body: "local" }));
  runTimers();
  await tick();
  assert.equal(controller.state().status, "conflict");
  controller.edit(write({ body: "later" }));
  assert.equal(controller.state().value.body, "local");
  await controller.flush();
  assert.equal(controller.state().status, "conflict");
});

test("offline failures can be retried and a 404 is terminal", async () => {
  let attempt = 0;
  const timers = new Set<() => void>();
  const controller = new NoteAutosave(note(), {
    save: async (value) => {
      attempt++;
      if (attempt === 1) throw { status: 0 };
      return { ...note(2), body: value.body };
    },
    online: () => false,
    schedule: (run) => {
      timers.add(run);
      return run;
    },
    cancel: (handle) => timers.delete(handle as () => void),
  });
  controller.edit(write({ body: "local" }));
  for (const run of [...timers]) run();
  await tick();
  assert.equal(controller.state().status, "offline");
  controller.retry();
  await tick();
  await tick();
  assert.equal(controller.state().status, "saved");

  const deleted = new NoteAutosave(note(), {
    save: async () => {
      throw { status: 404 };
    },
    schedule: (run) => run,
    cancel: () => {},
  });
  deleted.edit(write({ body: "gone" }));
  await deleted.flush();
  assert.equal(deleted.state().status, "deleted");
});

test("adopt replaces the base and clears dirty state", async () => {
  const { controller, timers } = harness(async () => {
    throw new Error("should not write");
  });
  controller.edit(write({ body: "local" }));
  assert.equal(timers.size, 1);
  controller.adopt({ ...note(5), body: "server" });
  assert.equal(controller.state().status, "saved");
  assert.equal(controller.state().value.body, "server");
  assert.equal(controller.isDirty(), false);
  await controller.flush();
});


test("recovering against a newer revision preserves every local field without writing", async () => {
  let calls = 0;
  const { controller, runTimers } = harness(async () => { calls++; return note(); });
  const local = write({ title: "Recovered title", body: "Unsaved local text", tags: ["recovered"] });
  controller.restore(local, 0);
  runTimers();
  await controller.flush();
  assert.equal(calls, 0);
  assert.equal(controller.state().status, "conflict");
  assert.deepEqual(controller.state().value, local);
  assert.equal(controller.state().server?.body, "Body");
});

test("a response after disposal cannot clear a newer editor's outbox", async () => {
  let release!: (note: Note) => void;
  const { controller, states } = harness(() => new Promise((resolve) => { release = resolve; }));
  controller.edit(write({ body: "local" }));
  const saving = controller.flush();
  controller.dispose();
  const count = states.length;
  release({ ...note(2), body: "local" });
  await saving;
  assert.equal(states.length, count);
});

test("disposal writes a debounced edit once without emitting state", async () => {
  const writes: Array<{ value: NoteWrite; revision: number }> = [];
  const { controller, states, runTimers } = harness(async (value, revision) => {
    writes.push({ value, revision });
    return { ...note(revision + 1), body: value.body };
  });
  controller.edit(write({ body: "typed before switching notes" }));
  const count = states.length;
  controller.dispose();
  runTimers();
  await tick();
  assert.deepEqual(writes, [{ value: write({ body: "typed before switching notes" }), revision: 1 }]);
  assert.equal(states.length, count);
});

test("edits made during an in-flight write are written once after disposal", async () => {
  let release!: (note: Note) => void;
  const writes: Array<{ value: NoteWrite; revision: number }> = [];
  const { controller } = harness((value, revision) => {
    writes.push({ value, revision });
    if (writes.length === 1) return new Promise((resolve) => { release = resolve; });
    return Promise.resolve({ ...note(revision + 1), body: value.body });
  });
  controller.edit(write({ body: "first" }));
  const saving = controller.flush();
  controller.edit(write({ body: "second" }));
  controller.dispose();
  release({ ...note(2), body: "first" });
  await saving;
  await tick();
  assert.deepEqual(writes.map((entry) => [entry.value.body, entry.revision]), [["first", 1], ["second", 2]]);
});

test("restoring an entry the server already holds is dropped instead of conflicting", () => {
  const { controller, runTimers, timers } = harness(async () => note());
  assert.equal(controller.restore(write({ tags: ["a"] }), 0), false);
  runTimers();
  assert.equal(timers.size, 0);
  assert.equal(controller.state().status, "saved");
  assert.equal(controller.restore(write({ body: "different" }), 0), true);
  assert.equal(controller.state().status, "conflict");
});
