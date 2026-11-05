import { useAui, useAuiState } from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { focusComposerEnd } from "@/components/chat/prompt-insert";
import { useData } from "@/state/data";
import { NOTE_HANDOFF_EVENT, takeNoteHandoff, type NoteHandoff } from "@/state/note-chat-handoff";

/**
 * Inserts a note handoff into a newly created composer only. The handoff is single-use, so a reload or a
 * second chat never receives it. Existing composer text is never overwritten.
 */
export function NoteChatHandoff() {
  const aui = useAui();
  const accountId = useData((state) => state.me?.id);
  const empty = useAuiState((state) => state.thread.isEmpty);
  const [pending, setPending] = useState<NoteHandoff | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const consumed = useRef(false);

  const consume = useCallback(() => {
    if (!accountId || !empty) return;
    if (consumed.current) return;
    const handoff = takeNoteHandoff(accountId);
    if (!handoff) return;
    consumed.current = true;
    const current = aui.composer.getState().text;
    if (current.trim()) {
      setPending(handoff);
      return;
    }
    aui.composer.setText(handoff.text);
    setNotice(t("notes.chatReady"));
    focusComposerEnd();
  }, [accountId, empty, aui]);

  useEffect(() => {
    consume();
    window.addEventListener(NOTE_HANDOFF_EVENT, consume);
    return () => window.removeEventListener(NOTE_HANDOFF_EVENT, consume);
  }, [consume]);

  useEffect(() => {
    if (!empty) consumed.current = false;
  }, [empty]);

  const append = () => {
    if (!pending) return;
    const current = aui.composer.getState().text;
    const separator = current.length > 0 && !current.endsWith("\n\n") ? "\n\n" : "";
    aui.composer.setText(`${current}${separator}${pending.text}`);
    setNotice(t("notes.chatReady"));
    setPending(null);
    focusComposerEnd();
  };

  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">{notice ?? ""}</span>
      <Dialog open={!!pending} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("notes.composerOccupied")}</DialogTitle>
            <DialogDescription>{t("notes.composerOccupied")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>{t("common.cancel")}</Button>
            <Button onClick={append}>{t("notes.append")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
