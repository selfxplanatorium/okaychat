import { api } from "@/lib/api";
import { resetServices } from "@/state/services";
import { clearThreadCache } from "@/runtime/threadCache";
import { clearMessageEdits } from "@/state/message-edits";
import { useN8nAgents } from "@/state/n8n-agents";

/** Every logout goes through here, so the message cache never outlives the session it belongs to. */
export async function signOut() {
  await api("/auth/logout", { method: "POST" });
  await clearThreadCache();
  clearMessageEdits();
  resetServices();
  // Drops the previous account's agent summaries and drops any response still in flight.
  useN8nAgents.getState().stop();
  window.location.href = "/";
}
