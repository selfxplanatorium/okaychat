import { CopyIcon, MoreHorizontalIcon, PinIcon, StarIcon, Trash2Icon } from "lucide-react";
import { useAui } from "@assistant-ui/react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import type { Note, NoteWrite } from "@shared/notes";
import type { Project } from "@shared/types";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCommand } from "@/keyboard/registry";
import { api } from "@/lib/api";
import { NoteAutosave, type NoteSaveStatus } from "@/lib/note-autosave";
import { readOutbox, removeOutbox, writeOutbox } from "@/lib/note-outbox";
import { uuidV4 } from "@/lib/ids";
import { cn } from "@/lib/utils";
import { useNotes } from "@/state/notes";
import { NoteConflictDialog } from "./NoteConflictDialog";
import { NotePreview } from "./NotePreview";
import { NoteSourceAction } from "./NoteSourceAction";
import { NoteTagsEditor } from "./NoteTagsEditor";
import { NoteToChatAction } from "./NoteToChatAction";

const writeOf = (note: Note): NoteWrite => ({
  title: note.title,
  body: note.body,
  favorite: note.favorite,
  pinned: note.pinned,
  tags: [...note.tags],
  projectId: note.projectId,
});

/** Autosaving note editor with one CAS write at a time, a plain-text outbox, and explicit conflict paths. */
export function NoteEditor({
  note,
  accountId,
  projects,
  onChanged,
  onDeleted,
  onBack,
  onOpenSource,
}: {
  note: Note;
  accountId: string;
  projects: Project[];
  onChanged: (note: Note) => void;
  onDeleted: () => void;
  onBack: () => void;
  onOpenSource: (note: Note) => void;
}) {
  const [value, setValue] = useState<NoteWrite>(() => writeOf(note));
  const [server, setServer] = useState<Note>(note);
  const [status, setStatus] = useState<NoteSaveStatus>("saved");
  const [localOnly, setLocalOnly] = useState(false);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<NoteAutosave | null>(null);
  const tagsRef = useRef<HTMLInputElement>(null);
  const aui = useAui();
  const [, navigate] = useLocation();

  useEffect(() => {
    const save = async (next: NoteWrite, revision: number) =>
      (await api<{ note: Note }>(`/notes/${encodeURIComponent(note.id)}`, { method: "PUT", json: { ...next, revision } })).note;
    const instance = new NoteAutosave(note, {
      save,
      online: () => (typeof navigator === "undefined" ? true : navigator.onLine),
      onChange: (state) => {
        setStatus(state.status);
        setValue(state.value);
        if (state.server) setServer(state.server);
        if (state.status === "saved") {
          removeOutbox(accountId, note.id);
          setLocalOnly(false);
          if (state.server) onChanged(state.server);
        } else if (state.status === "dirty" || state.status === "offline" || state.status === "error" || state.status === "saving") {
          scheduleOutbox(state.value, state.revision, state.server ?? note);
        }
      },
    });
    controller.current = instance;
    setValue(writeOf(note));
    setServer(note);
    setStatus("saved");
    const entry = readOutbox(accountId, note.id);
    if (entry && !instance.restore(entry.value, entry.baseRevision)) removeOutbox(accountId, note.id);
    return () => {
      instance.dispose();
      if (controller.current === instance) controller.current = null;
    };
    // One controller per note and account; server revisions arrive through `onChanged`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id, accountId]);

  const scheduleOutbox = (next: NoteWrite, revision: number, base: Note) => {
    // Persist before navigation can unmount the editor; a delayed write can resurrect a discarded draft.
    const result = writeOutbox(accountId, note.id, {
      version: 1,
      baseRevision: revision,
      baseValue: writeOf(base),
      value: next,
      editSequence: Date.now(),
      savedAt: Date.now(),
    });
    setLocalOnly(result !== "saved");
  };

  useEffect(() => {
    const flush = () => void controller.current?.flush();
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const warn = (event: BeforeUnloadEvent) => {
      if (!controller.current?.isDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", warn);
    };
  }, []);

  useEffect(() => {
    if (status === "conflict") setConflictOpen(true);
  }, [status]);

  const edit = (patch: Partial<NoteWrite>) => {
    const next = { ...value, ...patch };
    setValue(next);
    controller.current?.edit(next);
  };

  const statusText = (): string => {
    if (localOnly) return t("notes.localOnly");
    switch (status) {
      case "saving":
        return t("notes.saving");
      case "saved":
        return t("notes.saved");
      case "dirty":
        return t("notes.unsaved");
      case "offline":
        return t("notes.offline");
      case "conflict":
        return t("notes.conflict");
      case "forbidden":
        return t("notes.disabled");
      case "deleted":
        return t("notes.missing");
      case "error":
        return t("notes.saveFailed");
      default:
        return t("notes.saved");
    }
  };

  const reload = async () => {
    const latest = await useNotes.getState().reloadSelected();
    if (!latest) return;
    setServer(latest);
    setValue(writeOf(latest));
    controller.current?.adopt(latest);
    setStatus("saved");
    setConflictOpen(false);
    removeOutbox(accountId, note.id);
  };

  const copyAttempt = useRef<{ key: string; id: string } | null>(null);

  const saveCopy = async () => {
    try {
      const result = await api<{ note: Note }>("/notes", {
        method: "POST",
        json: { ...value, requestId: (() => {
          const key = JSON.stringify(value);
          if (copyAttempt.current?.key !== key) copyAttempt.current = { key, id: uuidV4() };
          return copyAttempt.current.id;
        })() },
      });
      useNotes.getState().applyNote(result.note);
      controller.current?.adopt(server);
      setConflictOpen(false);
      navigate(`/notes/${result.note.id}`);
    } catch (copyError) {
      setError((copyError as Error).message);
    }
  };

  const copyLocal = async () => {
    try {
      await navigator.clipboard.writeText(value.body);
    } catch {
      setError(t("notes.saveFailed"));
    }
  };

  const remove = async () => {
    try {
      await useNotes.getState().deleteNote(server);
      removeOutbox(accountId, note.id);
      setDeleteOpen(false);
      onDeleted();
    } catch (deleteError) {
      setError((deleteError as Error).message);
    }
  };

  useCommand("notes.preview", () => setTab((current) => (current === "edit" ? "preview" : "edit")), true);
  useCommand("notes.favorite", () => edit({ favorite: !value.favorite }), true);
  useCommand("notes.pin", () => edit({ pinned: !value.pinned }), true);
  useCommand("notes.tags", () => tagsRef.current?.focus(), true);
  useCommand("notes.project", () => document.querySelector<HTMLElement>("[data-notes-project] button")?.focus(), true);
  useCommand("notes.toChat", () => void offerToChat(), true);
  useCommand("notes.delete", () => setDeleteOpen(true), true);
  useCommand("notes.retrySave", () => controller.current?.retry(), status === "error" || status === "offline");
  useCommand("notes.copyLocal", () => void copyLocal(), true);

  const offerLocalToChat = async () => {
    await Promise.resolve(aui.threads.switchToNewThread()).catch(() => {});
    navigate("/");
    const { offerNoteToChat } = await import("@/state/note-chat-handoff");
    offerNoteToChat(accountId, { id: note.id, title: value.title, body: value.body });
  };

  const offerToChat = async () => {
    await controller.current?.flush();
    if (status === "conflict" || status === "offline" || status === "error") return;
    await Promise.resolve(aui.threads.switchToNewThread()).catch(() => {});
    navigate("/");
    // The handoff consumer in the shell inserts the snapshot into the new composer.
    const { offerNoteToChat } = await import("@/state/note-chat-handoff");
    offerNoteToChat(accountId, { id: note.id, title: value.title, body: value.body });
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={t("notes.title")}>
      <header className="border-border flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="sm" className="md:hidden" onClick={() => (controller.current?.isDirty() ? setDiscardOpen(true) : onBack())} data-command="notes.back">
          {t("notes.back")}
        </Button>
        <div role="tablist" aria-label={t("notes.titleLabel")} className="flex items-center gap-1">
          <button type="button" role="tab" aria-selected={tab === "edit"} onClick={() => setTab("edit")} className={cn("rounded-md px-2 py-1 text-xs", tab === "edit" ? "bg-muted font-medium" : "text-muted-foreground")}>
            {t("notes.edit")}
          </button>
          <button type="button" role="tab" aria-selected={tab === "preview"} onClick={() => setTab("preview")} className={cn("rounded-md px-2 py-1 text-xs", tab === "preview" ? "bg-muted font-medium" : "text-muted-foreground")}>
            {t("notes.preview")}
          </button>
        </div>
        <span role="status" aria-live="polite" className={cn("text-xs", status === "error" || status === "conflict" ? "text-destructive" : "text-muted-foreground")}>
          {statusText()}
        </span>
        {(status === "error" || status === "offline") && (
          <Button size="xs" variant="outline" onClick={() => controller.current?.retry()} data-command="notes.retrySave">{t("notes.retrySave")}</Button>
        )}
        {(status === "conflict" || status === "offline" || status === "error") && (
          <Button size="xs" variant="outline" onClick={() => void offerLocalToChat()}>{t("notes.useLocal")}</Button>
        )}
        <div className="ms-auto flex items-center gap-1">
          <Button size="icon-sm" variant={value.favorite ? "secondary" : "ghost"} aria-label={value.favorite ? t("notes.unfavorite") : t("notes.favorite")} aria-pressed={value.favorite} onClick={() => edit({ favorite: !value.favorite })} data-command="notes.favorite">
            <StarIcon fill={value.favorite ? "currentColor" : "none"} />
          </Button>
          <Button size="icon-sm" variant={value.pinned ? "secondary" : "ghost"} aria-label={value.pinned ? t("notes.unpin") : t("notes.pin")} aria-pressed={value.pinned} onClick={() => edit({ pinned: !value.pinned })} data-command="notes.pin">
            <PinIcon />
          </Button>
          <NoteToChatAction accountId={accountId} note={{ id: note.id, title: value.title, body: value.body }} disabled={status === "conflict" || status === "forbidden" || status === "deleted"} />
          <Menu>
            <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={t("common.more")} data-command="notes.more" />}>
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuContent className="w-52">
              <MenuItem onClick={() => void copyLocal()} data-command="notes.copyLocal"><CopyIcon /> {t("notes.copyLocal")}</MenuItem>
              <MenuItem onClick={() => setConflictOpen(true)}><CopyIcon /> {t("notes.compare")}</MenuItem>
              <MenuItem onClick={() => setDeleteOpen(true)} className="text-destructive" data-command="notes.delete"><Trash2Icon /> {t("notes.delete")}</MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4">
          {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
          {status === "conflict" && <p role="alert" className="text-destructive text-sm">{t("notes.conflict")}</p>}
          {localOnly && <p role="alert" className="text-warning text-sm">{t("notes.localOnly")}</p>}
          <Input
            value={value.title}
            onChange={(event) => edit({ title: event.target.value })}
            aria-label={t("notes.titleLabel")}
            placeholder={t("notes.untitled")}
            maxLength={200}
            title={t("notes.titleTooLong", { count: 200 })}
            className="h-11 border-0 bg-transparent px-0 text-xl font-semibold shadow-none focus-visible:bg-transparent"
          />
          <div className="flex flex-wrap items-center gap-2">
            <NoteTagsEditor tags={value.tags} onChange={(tags) => edit({ tags })} disabled={status === "forbidden" || status === "deleted"} inputRef={tagsRef} />
            <span data-notes-project>
              <Select
                aria-label={t("notes.project")}
                className="h-8 w-auto min-w-32"
                value={value.projectId ?? ""}
                onValueChange={(projectId) => edit({ projectId: projectId || null })}
                options={[{ value: "", label: t("notes.noProject") }, ...projects.map((project) => ({ value: project.id, label: project.name }))]}
              />
            </span>
          </div>
          <NoteSourceAction note={note} onOpen={onOpenSource} />
          {tab === "preview" ? (
            <NotePreview body={value.body} />
          ) : (
            <Textarea
              value={value.body}
              onChange={(event) => edit({ body: event.target.value })}
              onBlur={() => void controller.current?.flush()}
              aria-label={t("notes.bodyLabel")}
              placeholder={t("notes.bodyLabel")}
              maxLength={200_000}
              title={t("notes.bodyTooLong")}
              className="min-h-[55dvh] resize-y font-mono text-sm"
            />
          )}
        </div>
      </div>

      <NoteConflictDialog
        open={conflictOpen}
        local={value.body}
        server={server.body}
        onClose={() => setConflictOpen(false)}
        onReload={() => void reload()}
        onSaveCopy={() => void saveCopy()}
        onCopy={() => void copyLocal()}
      />
      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("notes.discardTitle")}</DialogTitle>
            <DialogDescription>{t("notes.discardBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscardOpen(false)}>{t("notes.keepEditing")}</Button>
            <Button variant="destructive" onClick={() => { setDiscardOpen(false); onBack(); }}>{t("notes.back")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("notes.deleteTitle", { title: value.title || t("notes.untitled") })}</DialogTitle>
            <DialogDescription>{t("notes.deleteBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={() => void remove()}>{t("notes.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
