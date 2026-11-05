import { PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearch, useLocation } from "wouter";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { useCommand } from "@/keyboard/registry";
import { ApiError, api } from "@/lib/api";
import { useData } from "@/state/data";
import { EMPTY_NOTES_FILTERS, useNotes, type NotesFilters } from "@/state/notes";
import { NoteEditor } from "./NoteEditor";
import { NoteFilters } from "./NoteFilters";
import { NoteList } from "./NoteList";

function filtersFrom(search: string): NotesFilters {
  const params = new URLSearchParams(search);
  const favorite = params.get("favorite");
  const pinned = params.get("pinned");
  const projectId = params.get("projectId");
  return {
    q: params.get("q") ?? "",
    favorite: favorite === "1" ? true : favorite === "0" ? false : null,
    pinned: pinned === "1" ? true : pinned === "0" ? false : null,
    projectId: projectId === null ? undefined : projectId === "none" ? null : projectId,
    tags: params.getAll("tag"),
    tagMatch: params.get("tagMatch") === "all" ? "all" : "any",
  };
}

function filtersQuery(filters: NotesFilters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.favorite !== null) params.set("favorite", filters.favorite ? "1" : "0");
  if (filters.pinned !== null) params.set("pinned", filters.pinned ? "1" : "0");
  if (filters.projectId !== undefined) params.set("projectId", filters.projectId ?? "none");
  for (const tag of filters.tags) params.append("tag", tag);
  if (filters.tags.length) params.set("tagMatch", filters.tagMatch);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function NotesPage({ noteId }: { noteId?: string }) {
  const me = useData((state) => state.me);
  const projects = useData((state) => state.projects);
  const search = useSearch();
  const [location, navigate] = useLocation();
  const items = useNotes((state) => state.items);
  const filters = useNotes((state) => state.filters);
  const listStatus = useNotes((state) => state.listStatus);
  const listError = useNotes((state) => state.listError);
  const nextCursor = useNotes((state) => state.nextCursor);
  const tags = useNotes((state) => state.tags);
  const selected = useNotes((state) => state.selected);
  const selectedStatus = useNotes((state) => state.selectedStatus);
  const selectedError = useNotes((state) => state.selectedError);
  const disabled = useNotes((state) => state.disabled);
  const started = useRef<string | null>(null);
  const handledNew = useRef(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    if (started.current === me.id) return;
    started.current = me.id;
    useNotes.getState().begin(me.id, filtersFrom(search));
  }, [me, search]);

  useEffect(() => {
    if (!me) return;
    const params = new URLSearchParams(search);
    if (params.get("new") === "1" && !handledNew.current) {
      handledNew.current = true;
      void useNotes
        .getState()
        .createNote()
        .then((note) => {
          if (!note) return;
          const next = filtersQuery(useNotes.getState().filters);
          navigate(`/notes/${note.id}${next}`, { replace: true });
        })
        .catch((error: unknown) => {
          setCreateError(error instanceof ApiError && error.status === 409 ? t("notes.limit", { count: 5000 }) : t("notes.saveFailed"));
        });
    }
  }, [me, search, navigate]);

  useEffect(() => {
    if (!noteId) {
      if (useNotes.getState().selectedId) void useNotes.getState().select(null);
      return;
    }
    if (useNotes.getState().selectedId !== noteId) void useNotes.getState().select(noteId);
  }, [noteId]);

  useEffect(() => {
    const refresh = () => void useNotes.getState().refresh();
    const online = () => void useNotes.getState().refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", online);
    };
  }, []);

  const applyFilters = (patch: Partial<NotesFilters>) => {
    const next = { ...useNotes.getState().filters, ...patch };
    useNotes.getState().setFilters(patch);
    const query = filtersQuery(next);
    navigate(`${noteId ? `/notes/${noteId}` : "/notes"}${query}`, { replace: true });
  };

  const openNote = (id: string) => navigate(`/notes/${id}${filtersQuery(filters)}`);

  useCommand("notes.create", () => {
    void useNotes.getState().createNote().then((note) => {
      if (note) openNote(note.id);
    });
  }, !disabled);
  useCommand("notes.search", () => document.querySelector<HTMLElement>("[data-command=notes.search]")?.focus(), !disabled);

  const toggle = async (id: string, patch: { favorite?: boolean; pinned?: boolean }) => {
    try {
      const { note } = await api<{ note: import("@shared/notes").Note }>(`/notes/${encodeURIComponent(id)}`);
      const saved = await api<{ note: import("@shared/notes").Note }>(`/notes/${encodeURIComponent(id)}`, {
        method: "PUT",
        json: {
          title: note.title,
          body: note.body,
          favorite: patch.favorite ?? note.favorite,
          pinned: patch.pinned ?? note.pinned,
          tags: note.tags,
          projectId: note.projectId,
          revision: note.revision,
        },
      });
      useNotes.getState().applyNote(saved.note);
    } catch (error) {
      setCreateError((error as Error).message);
    }
  };

  if (!me) return null;

  if (disabled) {
    return (
      <main className="grid min-h-0 flex-1 place-items-center p-8">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold">{t("notes.title")}</h1>
          <p role="alert" className="text-muted-foreground mt-2 text-sm">{t("notes.disabled")}</p>
        </div>
      </main>
    );
  }

  const editor = selected && selected.id === noteId ? (
    <NoteEditor
      key={selected.id}
      note={selected}
      accountId={me.id}
      projects={projects}
      onChanged={(note) => useNotes.getState().applyNote(note)}
      onDeleted={() => navigate(`/notes${filtersQuery(filters)}`, { replace: true })}
      onBack={() => navigate(`/notes${filtersQuery(filters)}`)}
      onOpenSource={(note) => note.source && navigate(`/c/${note.source.threadId}`)}
    />
  ) : noteId && selectedStatus === "error" ? (
    <div className="grid flex-1 place-items-center p-8 text-center">
      <div>
        <p role="alert" className="text-sm">{t("notes.missing")}</p>
        <p className="text-muted-foreground mt-1 text-xs">{selectedError}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => navigate(`/notes${filtersQuery(filters)}`)}>{t("notes.back")}</Button>
      </div>
    </div>
  ) : (
    <div className="grid flex-1 place-items-center p-8 text-sm text-muted-foreground">{t("notes.loading")}</div>
  );

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="border-border flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <h1 className="text-base font-semibold">{t("notes.title")}</h1>
        <span className="text-muted-foreground text-xs">{t("notes.count", { count: items.length })}</span>
        <div className="ms-auto flex items-center gap-1.5">
          <Button size="sm" onClick={() => void useNotes.getState().createNote().then((note) => note && openNote(note.id)).catch((error: unknown) => setCreateError(error instanceof ApiError && error.status === 409 ? t("notes.limit", { count: 5000 }) : t("notes.saveFailed")))} data-command="notes.create">
            <PlusIcon aria-hidden /> {t("notes.new")}
          </Button>
        </div>
      </header>
      {createError && <p role="alert" className="text-destructive border-border border-b px-3 py-1.5 text-sm">{createError}</p>}
      <div className="flex min-h-0 flex-1">
        <aside className={`${noteId ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col border-e md:w-[clamp(17.5rem,28vw,22.5rem)]`}>
          <div className="shrink-0 p-2">
            <NoteFilters filters={filters} onChange={applyFilters} tags={tags} projects={projects} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <NoteList
              items={items}
              selectedId={noteId ?? null}
              loading={listStatus === "loading"}
              error={listError}
              nextCursor={nextCursor}
              onSelect={openNote}
              onToggleFavorite={(note) => void toggle(note.id, { favorite: !note.favorite })}
              onTogglePin={(note) => void toggle(note.id, { pinned: !note.pinned })}
              onLoadMore={() => void useNotes.getState().loadMore()}
              onRetry={() => void useNotes.getState().refresh()}
            />
            {items.length > 0 && !listError && <p className="text-muted-foreground px-3 pb-3 text-[0.7rem]">{t("notes.browserDraftHelp")}</p>}
          </div>
        </aside>
        <div className={`${noteId ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>{editor}</div>
      </div>
      {location === "/notes" && !items.length && listStatus === "ready" && (
        <p className="text-muted-foreground sr-only">{t("notes.noResults")}</p>
      )}
    </main>
  );
}
