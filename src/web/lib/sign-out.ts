import { api } from "@/lib/api";
import { resetServices } from "@/state/services";
import { clearThreadCache } from "@/runtime/threadCache";
import { clearMessageEdits } from "@/state/message-edits";
import { clearStoredMessages } from "@/runtime/message-persistence";

/** Every logout goes through here, so the message cache never outlives the session it belongs to. */
export async function signOut() {
  await api("/auth/logout", { method: "POST" });
  await clearThreadCache();
  clearMessageEdits();
  clearStoredMessages();
  resetServices();
  window.location.href = "/";
}
