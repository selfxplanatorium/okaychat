/// <reference types="node" />
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

const originalFetch = globalThis.fetch;
const pending: Array<(response: Response) => void> = [];
globalThis.fetch = (() => new Promise<Response>((resolve) => pending.push(resolve))) as typeof fetch;
const { useRoomArchives, startRoomArchiveAccount } = await import("./room-archives.js");
const answer = (body: unknown, status = 200) => pending.shift()!(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
beforeEach(() => { startRoomArchiveAccount(""); startRoomArchiveAccount("alice"); });
after(() => { globalThis.fetch = originalFetch; });

test("late private job and review responses are discarded after account switches", async () => {
  for (const run of [
    () => useRoomArchives.getState().poll("private-job"),
    () => useRoomArchives.getState().resume(),
    () => useRoomArchives.getState().inspect("private-job"),
    () => useRoomArchives.getState().roster("private-job"),
  ]) {
    startRoomArchiveAccount("alice");
    const request = run();
    startRoomArchiveAccount("bob");
    answer({ job: { id: "private-job", state: "ready" }, summary: { name: "private name" }, items: [{ historicalName: "private member" }] });
    assert.equal(await request, null);
    assert.equal(useRoomArchives.getState().job, null);
    assert.equal(useRoomArchives.getState().error, null);
  }
});

test("an old admission cannot start uploading or polling as the next account", async () => {
  for (const run of [
    () => useRoomArchives.getState().startExport("private-room", { mode: "all" }, false),
    () => useRoomArchives.getState().startImport(new File(["zip"], "room.zip")),
    () => useRoomArchives.getState().confirm("private-job", "Room", "digest"),
  ]) {
    startRoomArchiveAccount("alice");
    const request = run();
    startRoomArchiveAccount("bob");
    answer({ jobId: "private-job", uploadUrl: "/api/room-archives/private-job/upload" });
    assert.equal(await request, null);
    assert.equal(pending.length, 0);
    assert.equal(useRoomArchives.getState().busy, false);
  }
});

test("late errors are discarded even after switching back to the original account", async () => {
  const request = useRoomArchives.getState().poll("private-job");
  startRoomArchiveAccount("bob");
  startRoomArchiveAccount("alice");
  answer({ error: "private error" }, 400);
  assert.equal(await request, null);
  assert.equal(useRoomArchives.getState().error, null);
});
