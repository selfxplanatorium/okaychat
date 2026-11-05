import { FileTextIcon } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import type { Note } from "@shared/notes";
import { t } from "@/i18n";
import { ActionBarMorePrimitive } from "@assistant-ui/react";
import { api } from "@/lib/api";
import { uuidV4 } from "@/lib/ids";

/** Copies a stored message's text parts into a new note. The server reads the real message, never client text. */
export function SaveNoteMenuItem({ threadId, messageId }: { threadId: string | null | undefined; messageId: string }) {
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!threadId) return null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ note: Note }>("/notes/from-source", {
        method: "POST",
        json: { requestId: uuidV4(), source: { kind: "message", threadId, messageId } },
      });
      navigate(`/notes/${result.note.id}`);
    } catch (failure) {
      const status = (failure as { status?: number }).status;
      setError(status === 404 ? t("notes.sourceMissing") : status === 409 ? t("notes.sourceUnavailable") : t("notes.sourceFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ActionBarMorePrimitive.Item
        data-command="message.saveNote"
        disabled={busy}
        onClick={() => void save()}
        className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors duration-(--motion-fast) ease-out-quart select-none"
      >
        <FileTextIcon className="size-4" /> {t("notes.fromMessage")}
      </ActionBarMorePrimitive.Item>
      {error && <span role="alert" className="text-destructive px-2.5 py-1 text-xs">{error}</span>}
    </>
  );
}

/** A Markdown artifact version becomes a note snapshot. Other kinds stay disabled with an explanation. */
export function SaveArtifactNoteButton({
  threadId,
  artifactId,
  version,
  kind,
}: {
  threadId: string | null | undefined;
  artifactId: string | null | undefined;
  version: number | null | undefined;
  kind: string | null;
}) {
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!threadId || !artifactId || !version) return null;
  if (kind !== "markdown") {
    return <span className="text-muted-foreground text-xs">{t("notes.sourceUnsupported")}</span>;
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        data-command="artifact.saveNote"
        disabled={busy}
        title={t("notes.fromArtifact")}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const result = await api<{ note: Note }>("/notes/from-source", {
              method: "POST",
              json: { requestId: uuidV4(), source: { kind: "artifact", threadId, artifactId, version } },
            });
            navigate(`/notes/${result.note.id}`);
          } catch (failure) {
            const status = (failure as { status?: number }).status;
            setError(status === 404 ? t("notes.sourceMissing") : status === 409 ? t("notes.sourceUnavailable") : t("notes.sourceFailed"));
          } finally {
            setBusy(false);
          }
        }}
        className="text-muted-foreground hover:text-foreground inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-xs pointer-coarse:min-h-11"
      >
        <FileTextIcon aria-hidden className="size-3.5" /> {t("notes.fromArtifact")}
      </button>
      {error && <span role="alert" className="text-destructive text-xs">{error}</span>}
    </span>
  );
}
