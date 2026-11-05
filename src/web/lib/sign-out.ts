import { api } from "@/lib/api";
import { resetServices } from "@/state/services";
import { resetNotifications } from "@/state/notifications";
import { clearThreadCache } from "@/runtime/threadCache";
import { clearMessageEdits } from "@/state/message-edits";
import { useN8nAgents } from "@/state/n8n-agents";
import { clearStoredMessages } from "@/runtime/message-persistence";
import { setAnnotationsAccount } from "@/state/message-annotations";
import { setSavedPromptsAccount } from "@/state/saved-prompts";
import { closePromptPicker } from "@/state/prompt-picker";
import { closeFeedback } from "@/state/feedback-dialog";
import { closeBookmarks } from "@/state/bookmark-dialog";
import { useMessageJump } from "@/state/message-jump";
import { useChannels } from "@/state/channels";

/** Every logout goes through here, so the message cache never outlives the session it belongs to. */
export async function signOut() {
  await api("/auth/logout", { method: "POST" });
  await clearThreadCache();
  clearMessageEdits();
  clearStoredMessages();
  setSavedPromptsAccount(null);
  setAnnotationsAccount(null);
  closePromptPicker();
  closeFeedback();
  closeBookmarks();
  useMessageJump.getState().clear();
  resetServices();
  resetNotifications();
  useChannels.getState().stop();
  // Drops the previous account's agent summaries and drops any response still in flight.
  useN8nAgents.getState().stop();
  window.location.href = "/";
}
