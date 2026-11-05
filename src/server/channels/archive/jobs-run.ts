import { finishCleanup, getRoomJobById, jobShouldStop, markFailed, setPhase, updateJob, type RoomArchiveJobRow } from "./jobs.js";
import { prepareRoomExport } from "./export.js";
import { commitRoomImport, prepareRoomImport } from "./import.js";

/**
 * One dispatch point for the in-process worker. Every step re-reads the durable row, so a cancellation
 * that arrives at the phase boundary is honored before anything is published.
 */
export async function runRoomArchiveJob(row: RoomArchiveJobRow, signal: AbortSignal): Promise<void> {
  const latest = getRoomJobById(row.id);
  if (!latest) return;
  try {
    if (latest.kind === "export") {
      if (!updateJob(latest.id, ["queued"], { state: "preparing" })) return;
      await prepareRoomExport(getRoomJobById(latest.id)!, signal);
    } else if (latest.state === "committing") {
      await commitRoomImport(latest, signal);
    } else {
      if (!updateJob(latest.id, ["queued"], { state: "preparing", phase: "validate" })) return;
      setPhase(latest.id, "validate", 0, null);
      await prepareRoomImport(getRoomJobById(latest.id)!, signal);
    }
  } catch (error) {
    const current = getRoomJobById(latest.id);
    if (!current) return;
    if (signal.aborted || jobShouldStop(current)) {
      finishCleanup(current, current.expires_at <= Date.now() ? "expired" : "cancelled");
      return;
    }
    markFailed(current.id, current.kind === "export" ? "export_failed" : "import_failed");
  }
}
