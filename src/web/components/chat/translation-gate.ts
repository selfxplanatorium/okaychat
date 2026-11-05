import type { PlainMessageKey } from "@/i18n";

// The disabled matrix for per-message translation. It lives apart from the React hook so the reasons can be
// tested without a chat runtime, and it is the single place that decides what "available" means.

export interface TranslationGateInput {
  threadId: string | null | undefined;
  temporary: boolean;
  sync: "pending" | "stale" | undefined;
  stored: boolean;
  running: boolean;
  editing: boolean;
  /** The account's Translate switch. */
  enabled: boolean;
  /** A utility model or a non-agent chat model exists to call. */
  hasModel: boolean;
  /** The message has text that is not an attachment placeholder. */
  hasText: boolean;
}

/** Pure so the disabled matrix is testable without a runtime: temporary, unsaved, syncing, busy, off, empty. */
export function translationGateState(input: TranslationGateInput): { available: boolean; reason: PlainMessageKey | null } {
  const known = !!input.threadId && !input.temporary;
  const syncing = !!input.sync;
  let reason: PlainMessageKey | null = null;
  if (input.temporary || !input.threadId) reason = "annotations.saveChatFirst";
  else if (input.sync === "stale") reason = "annotations.messageNotStored";
  else if (input.sync) reason = "annotations.syncRequired";
  else if (!input.stored) reason = "annotations.savingMessage";
  else if (input.running || input.editing) reason = "annotations.busy";
  else if (!input.enabled) reason = "translation.off";
  else if (!input.hasModel) reason = "translation.noModel";
  else if (!input.hasText) reason = "translation.empty";
  return {
    available:
      known && !syncing && input.stored && !input.running && !input.editing && input.enabled && input.hasModel && input.hasText,
    reason,
  };
}
