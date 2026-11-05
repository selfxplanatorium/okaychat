/** Explicit continuation and the trusted generation status shown on a reply. */
export default {
  outputLimit: "Answer reached its output limit",
  continue: "Continue",
  continueHint: "Sends a continuation request using the current chat settings.",
  continueDraftTitle: "Keep your draft and continue this answer?",
  keepDraft: "Keep draft",
  savingMessage: "Waiting for this reply to be saved…",
  syncRequired: "Wait for this chat to sync before continuing.",
  targetChanged: "This answer changed. Reload the chat and try again.",
  editedTarget: "This answer was edited, so it cannot be continued automatically.",
  waitingTools: "This answer is still waiting for a tool. Finish or stop it first.",
  stopPending: "Stop pending reply",
  continueFailed: "Could not send the continuation.",
} as const;
