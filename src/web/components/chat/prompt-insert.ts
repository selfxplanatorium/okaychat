import type { useAui } from "@assistant-ui/react";
import type { PromptInsertTarget } from "@/state/prompt-picker";

// Placement of expanded prompt text. The dialog and the slash menu share it so both follow the same rule:
// append to the live composer, or replace exactly the slash token that was captured when the prompt was chosen.

type Aui = ReturnType<typeof useAui>;

export type InsertOutcome = "inserted" | "changed";

const textarea = () =>
  document.querySelector<HTMLTextAreaElement>(
    "[data-slot=aui_composer-shell] .aui-composer-input",
  );

/** Returns focus to the main composer at the end of the text, without moving the page. */
export function focusComposerEnd() {
  requestAnimationFrame(() => {
    const input = textarea();
    if (!input) return;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });
}

/**
 * `changed` means the composer text or the owning chat moved since the prompt was chosen; nothing is written,
 * and the caller tells the user to choose again. `currentThreadKey` is the chat open at insertion time.
 */
export function insertPromptText(
  aui: Aui,
  expanded: string,
  target: PromptInsertTarget,
  currentThreadKey: string | null,
  currentAccountId?: string | null,
): InsertOutcome {
  if (target.kind === "replace") {
    if (target.threadKey !== currentThreadKey) return "changed";
    if (target.accountId !== undefined && target.accountId !== currentAccountId) return "changed";
    if (aui.composer.getState().text !== target.text) return "changed";
    aui.composer.setText(expanded);
    focusComposerEnd();
    return "inserted";
  }
  const current = aui.composer.getState().text;
  const separator = current.length > 0 && !current.endsWith("\n\n") ? "\n\n" : "";
  aui.composer.setText(`${current}${separator}${expanded}`);
  focusComposerEnd();
  return "inserted";
}
