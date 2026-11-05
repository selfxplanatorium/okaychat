import { useAui, useAuiState } from "@assistant-ui/react";
import { t } from "@/i18n";
import { useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";

/** Pasted text this long becomes a text attachment, so it does not flood the composer or the sent bubble. */
const LONG_PASTE_CHARS = 2000;
const LONG_PASTE_LINES = 30;

type Pasted = { file: File; text: string; before: string; start: number; end: number; input: HTMLTextAreaElement };

const isLong = (text: string) => text.length >= LONG_PASTE_CHARS || text.split("\n").length >= LONG_PASTE_LINES;

/**
 * Long pastes attach as "Pasted text.txt", with an offer to paste inline instead. Ctrl/⌘+Shift+V (paste as plain
 * text) always pastes inline. Spread `inputProps` on the composer input and render `notice` inside the composer.
 */
export function useLongPaste(enabled = true): {
  inputProps: {
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  };
  notice: ReactNode;
} {
  const aui = useAui();
  const [pasted, setPasted] = useState<Pasted | null>(null);
  const plainPaste = useRef(false);
  const attached = useAuiState((s) => pasted !== null && s.composer.attachments.some((a) => a.file === pasted.file));

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    plainPaste.current = event.shiftKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const inline = plainPaste.current;
    plainPaste.current = false;
    // Agent targets accept text only, so a long paste stays inline instead of becoming an attachment.
    if (!enabled || inline || event.clipboardData.files.length > 0) return;
    const text = event.clipboardData.getData("text/plain");
    if (!isLong(text)) return;
    event.preventDefault();
    const names = new Set(aui.composer.getState().attachments.map((a) => a.name));
    let name = t("composer.pastedText");
    for (let n = 2; names.has(name); n++) name = t("composer.pastedTextN", { n });
    const file = new File([text], name, { type: "text/plain" });
    const input = event.currentTarget;
    setPasted({ file, text, before: input.value, start: input.selectionStart, end: input.selectionEnd, input });
    void aui.composer.addAttachment(file);
  };

  const pasteInline = () => {
    if (!pasted) return;
    const attachment = aui.composer.getState().attachments.find((a) => a.file === pasted.file);
    if (attachment) void aui.composer.attachment({ id: attachment.id }).remove();
    const current = aui.composer.getState().text;
    // Insert where the paste happened; if the text changed since, the old selection no longer applies.
    const [start, end] = current === pasted.before ? [pasted.start, pasted.end] : [current.length, current.length];
    aui.composer.setText(current.slice(0, start) + pasted.text + current.slice(end));
    setPasted(null);
    const caret = start + pasted.text.length;
    requestAnimationFrame(() => {
      pasted.input.focus();
      pasted.input.setSelectionRange(caret, caret);
    });
  };

  const notice = attached ? (
    <div role="status" className="text-muted-foreground flex items-center gap-2 px-2.5 text-xs">
      <span className="min-w-0 truncate">{t("composer.longPasteAttached")}</span>
      <button
        type="button"
        onClick={pasteInline}
        className="text-foreground hover:bg-muted focus-visible:ring-ring/50 shrink-0 rounded px-1.5 py-0.5 font-medium outline-none focus-visible:ring-2 pointer-coarse:py-1.5"
      >
        {t("composer.pasteInline")}
      </button>
    </div>
  ) : null;

  return { inputProps: { onPaste, onKeyDown }, notice };
}
