import { db, tx } from "../db.js";
import { featureAllowed } from "../permissions/guard.js";
import { notify } from "../notifications.js";
import { isNotificationBodyKey, isNotificationTitleKey } from "../../shared/notifications.js";
import { dueReminders } from "./store.js";

/**
 * Reminder delivery. The ledger is the durable terminal state: a row becomes `delivered` in the same
 * transaction that writes its notice, so a crash before commit delivers neither and a later tick retries.
 * A dismissed or pruned notice never re-arms a reminder.
 */

export const REMINDER_BATCH = 200;
export const MAX_BATCHES_PER_TICK = 5;
const CATCHUP_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReminderTickResult {
  delivered: number;
  suppressed: number;
  skipped: boolean;
}

let ticking = false;

/** Validates the calendar notice vocabulary before `notify`, whose silent drop must never look delivered. */
function calendarNoticeKeysValid(): boolean {
  return isNotificationTitleKey("calendar.reminder") && isNotificationBodyKey("calendar.openEvent");
}

function processOne(userId: string, eventId: string, reminderRevision: number, offsetMinutes: number, now: number): "delivered" | "suppressed" | "skipped" {
  return tx(() => {
    const reminder = db
      .prepare(
        `SELECT state FROM calendar_reminders
         WHERE event_id = ? AND reminder_revision = ? AND offset_minutes = ? AND state = 'pending'`,
      )
      .get(eventId, reminderRevision, offsetMinutes) as { state: string } | undefined;
    if (!reminder) return "skipped";
    const event = db
      .prepare("SELECT id, user_id, effective_end_at, reminder_revision FROM calendar_events WHERE id = ? AND user_id = ?")
      .get(eventId, userId) as { id: string; user_id: string; effective_end_at: number; reminder_revision: number } | undefined;
    if (!event || event.reminder_revision !== reminderRevision) return "skipped";
    const dueAt = db
      .prepare("SELECT due_at FROM calendar_reminders WHERE event_id = ? AND reminder_revision = ? AND offset_minutes = ?")
      .get(eventId, reminderRevision, offsetMinutes) as { due_at: number };
    const suppress =
      !featureAllowed(userId, "calendar") ||
      event.effective_end_at <= now ||
      dueAt.due_at < now - CATCHUP_MS;
    if (suppress) {
      db.prepare(
        "UPDATE calendar_reminders SET state = 'suppressed', processed_at = ? WHERE event_id = ? AND reminder_revision = ? AND offset_minutes = ? AND state = 'pending'",
      ).run(now, eventId, reminderRevision, offsetMinutes);
      return "suppressed";
    }
    if (!calendarNoticeKeysValid()) throw new Error("Calendar notification keys are not allowlisted");
    // Same outer transaction: a failed insert rolls the ledger update back too.
    notify({
      userId,
      kind: "calendar",
      level: "info",
      titleKey: "calendar.reminder",
      bodyKey: "calendar.openEvent",
      params: {},
      calendarEventId: event.id,
      threadId: null,
      sourceKey: `calendar:${event.id}:${reminderRevision}:${offsetMinutes}`,
      actionPath: `/calendar?event=${encodeURIComponent(event.id)}`,
    });
    db.prepare(
      "UPDATE calendar_reminders SET state = 'delivered', processed_at = ? WHERE event_id = ? AND reminder_revision = ? AND offset_minutes = ? AND state = 'pending'",
    ).run(now, eventId, reminderRevision, offsetMinutes);
    return "delivered";
  });
}

/** One tick: up to five batches of 200 due rows. No model, network, or browser call inside delivery. */
export function runDueReminders(now = Date.now()): ReminderTickResult {
  if (ticking) return { delivered: 0, suppressed: 0, skipped: true };
  ticking = true;
  try {
    let delivered = 0;
    let suppressed = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
      const due = dueReminders(now, REMINDER_BATCH);
      if (!due.length) break;
      for (const reminder of due) {
        const result = processOne(reminder.userId, reminder.event.id, reminder.reminderRevision, reminder.offsetMinutes, now);
        if (result === "delivered") delivered++;
        else if (result === "suppressed") suppressed++;
      }
      if (due.length < REMINDER_BATCH) break;
    }
    return { delivered, suppressed, skipped: false };
  } finally {
    ticking = false;
  }
}

/** Test-only: lets a suite assert the concurrency guard without waiting for a real tick. */
export function resetReminderTickForTest(): void {
  ticking = false;
}
