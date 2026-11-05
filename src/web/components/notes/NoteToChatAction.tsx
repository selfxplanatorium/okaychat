import { MessageSquarePlusIcon } from "lucide-react";
import { useAui } from "@assistant-ui/react";
import { useLocation } from "wouter";
import type { Note } from "@shared/notes";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { showChat } from "@/state/data";
import { offerNoteToChat } from "@/state/note-chat-handoff";

/** Explicit user action: the note becomes composer text in a new chat, never a hidden model input. */
export function NoteToChatAction({ accountId, note, disabled }: { accountId: string; note: Pick<Note, "id" | "title" | "body">; disabled?: boolean }) {
  const aui = useAui();
  const [, navigate] = useLocation();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled}
      data-command="notes.toChat"
      onClick={async () => {
        await Promise.resolve(aui.threads.switchToNewThread()).catch(() => {});
        offerNoteToChat(accountId, note);
        showChat(navigate);
      }}
    >
      <MessageSquarePlusIcon aria-hidden /> {t("notes.toChat")}
    </Button>
  );
}
