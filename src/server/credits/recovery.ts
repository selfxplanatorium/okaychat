import { db, tx } from "../db.js";
import { settleCreditRequest } from "./store.js";

/** Called once from index.ts before the listener and every worker. Never run on a live server. */
export function recoverCreditOperations(): void {
  tx(() => {
    for (const row of db.prepare("SELECT id,dispatched_at FROM token_credit_requests WHERE state='open'").all()) {
      settleCreditRequest(String(row.id), { state: row.dispatched_at === null ? "not_dispatched" : "unknown", errorCode: "interrupted" });
    }
    db.prepare("UPDATE token_credit_roots SET state='interrupted',finished_at=? WHERE state='active'").run(Date.now());
  });
}
