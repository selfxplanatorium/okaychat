import { ExternalLinkIcon } from "lucide-react";
import type { Note } from "@shared/notes";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";

/** A copied note keeps a historical source pointer; a missing source is reported, never followed blindly. */
export function NoteSourceAction({ note, onOpen }: { note: Note; onOpen: (note: Note) => void }) {
  if (!note.source) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">
        {note.source.kind === "message" ? t("notes.fromMessage") : t("notes.fromArtifact")}
      </span>
      {note.sourceAvailable ? (
        <Button size="xs" variant="outline" onClick={() => onOpen(note)}>
          <ExternalLinkIcon aria-hidden /> {t("notes.source")}
        </Button>
      ) : (
        <span className="text-muted-foreground">{t("notes.sourceMissing")}</span>
      )}
    </div>
  );
}
