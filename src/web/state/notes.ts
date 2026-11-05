import { create } from "zustand";
import type { Note, NoteFromSource, NotePage, NoteSummary, NoteTagCount, NoteTagMatch, NoteWrite } from "@shared/notes";
import { noteExcerpt } from "@shared/notes";
import { ApiError, api } from "@/lib/api";
import { uuidV4 } from "@/lib/ids";

/**
 * Notes workspace state. Each account has its own generation: late answers from a previous account or
 * filter are dropped. Selected-note GET, list pages, and tag inventory load independently.
 */

export interface NotesFilters {
  q: string;
  favorite: boolean | null;
  pinned: boolean | null;
  projectId: string | null | undefined;
  tags: string[];
  tagMatch: NoteTagMatch;
}

export const EMPTY_NOTES_FILTERS: NotesFilters = { q: "", favorite: null, pinned: null, projectId: undefined, tags: [], tagMatch: "any" };

export const summaryOf = (note: Note): NoteSummary => {
  const { body, ...rest } = note;
  return { ...rest, excerpt: noteExcerpt(body) };
};

export function notesQuery(filters: NotesFilters, cursor?: string, limit = 50): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.favorite !== null) params.set("favorite", filters.favorite ? "1" : "0");
  if (filters.pinned !== null) params.set("pinned", filters.pinned ? "1" : "0");
  if (filters.projectId !== undefined) params.set("projectId", filters.projectId ?? "none");
  for (const tag of filters.tags) params.append("tag", tag);
  if (filters.tags.length) params.set("tagMatch", filters.tagMatch);
  params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  return `/notes?${params.toString()}`;
}

type LoadStatus = "idle" | "loading" | "ready" | "error";

interface NotesState {
  accountId: string | null;
  filters: NotesFilters;
  items: NoteSummary[];
  nextCursor: string | null;
  listStatus: LoadStatus;
  listError: string | null;
  tags: NoteTagCount[];
  tagsStatus: LoadStatus;
  selectedId: string | null;
  selected: Note | null;
  selectedStatus: LoadStatus;
  selectedError: string | null;
  disabled: boolean;
  creating: boolean;
  begin: (accountId: string, filters?: NotesFilters) => void;
  reset: () => void;
  setFilters: (patch: Partial<NotesFilters>) => void;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  reloadSelected: () => Promise<Note | null>;
  applyNote: (note: Note) => void;
  createNote: () => Promise<Note | null>;
  createFromSource: (input: Omit<NoteFromSource, "requestId">) => Promise<Note | null>;
  deleteNote: (note: Note) => Promise<boolean>;
  markDisabled: () => void;
}

let generation = 0;
let listRequest = 0;

const errorText = (error: unknown) => (error instanceof ApiError ? error.message : String(error));

export const useNotes = create<NotesState>((set, get) => {
  const loadList = async (cursor?: string) => {
    const { accountId, filters } = get();
    if (!accountId) return;
    const token = generation;
    const request = ++listRequest;
    set(cursor ? { listStatus: get().listStatus === "ready" ? "ready" : "loading" } : { listStatus: "loading", listError: null, items: [], nextCursor: null });
    try {
      const page = await api<NotePage>(notesQuery(filters, cursor));
      if (token !== generation || request !== listRequest) return;
      set((state) => ({
        items: cursor ? [...state.items, ...page.items.filter((item) => !state.items.some((old) => old.id === item.id))] : page.items,
        nextCursor: page.nextCursor,
        listStatus: "ready",
        listError: null,
      }));
    } catch (error) {
      if (token !== generation || request !== listRequest) return;
      if (error instanceof ApiError && error.status === 403) set({ disabled: true, listStatus: "error", listError: error.message });
      else set({ listStatus: "error", listError: errorText(error) });
    }
  };

  const loadTags = async () => {
    const token = generation;
    set({ tagsStatus: "loading" });
    try {
      const result = await api<{ tags: NoteTagCount[] }>("/notes/tags");
      if (token === generation) set({ tags: result.tags, tagsStatus: "ready" });
    } catch {
      if (token === generation) set({ tagsStatus: "error" });
    }
  };

  const loadSelected = async (id: string) => {
    const token = generation;
    set({ selectedStatus: "loading", selectedError: null });
    try {
      const result = await api<{ note: Note }>(`/notes/${encodeURIComponent(id)}`);
      if (token !== generation || get().selectedId !== id) return;
      set({ selected: result.note, selectedStatus: "ready" });
    } catch (error) {
      if (token !== generation || get().selectedId !== id) return;
      if (error instanceof ApiError && error.status === 403) set({ disabled: true, selectedStatus: "error", selectedError: error.message });
      else set({ selectedStatus: "error", selectedError: errorText(error), selected: null });
    }
  };

  return {
    accountId: null,
    filters: EMPTY_NOTES_FILTERS,
    items: [],
    nextCursor: null,
    listStatus: "idle",
    listError: null,
    tags: [],
    tagsStatus: "idle",
    selectedId: null,
    selected: null,
    selectedStatus: "idle",
    selectedError: null,
    disabled: false,
    creating: false,
    begin(accountId, filters = EMPTY_NOTES_FILTERS) {
      if (get().accountId === accountId) {
        set({ filters });
        void loadList();
        return;
      }
      generation++;
      listRequest++;
      set({
        accountId,
        filters,
        items: [],
        nextCursor: null,
        listStatus: "loading",
        listError: null,
        tags: [],
        tagsStatus: "loading",
        selectedId: null,
        selected: null,
        selectedStatus: "idle",
        selectedError: null,
        disabled: false,
        creating: false,
      });
      void loadList();
      void loadTags();
    },
    reset() {
      generation++;
      listRequest++;
      set({
        accountId: null,
        filters: EMPTY_NOTES_FILTERS,
        items: [],
        nextCursor: null,
        listStatus: "idle",
        listError: null,
        tags: [],
        tagsStatus: "idle",
        selectedId: null,
        selected: null,
        selectedStatus: "idle",
        selectedError: null,
        disabled: false,
        creating: false,
      });
    },
    setFilters(patch) {
      const filters = { ...get().filters, ...patch };
      set({ filters });
      void loadList();
    },
    refresh: async () => {
      await loadList();
      void loadTags();
      const id = get().selectedId;
      if (id) await loadSelected(id);
    },
    loadMore: async () => {
      const cursor = get().nextCursor;
      if (!cursor || get().listStatus === "loading") return;
      await loadList(cursor);
    },
    async select(id) {
      if (id === null) {
        set({ selectedId: null, selected: null, selectedStatus: "idle", selectedError: null });
        return;
      }
      set({ selectedId: id, selected: null, selectedStatus: "loading", selectedError: null });
      await loadSelected(id);
    },
    reloadSelected: async () => {
      const id = get().selectedId;
      if (!id) return null;
      await loadSelected(id);
      return get().selected;
    },
    applyNote(note) {
      set((state) => ({
        selected: state.selectedId === note.id ? note : state.selected,
        selectedStatus: state.selectedId === note.id ? "ready" : state.selectedStatus,
        items: state.items.map((item) => (item.id === note.id ? summaryOf(note) : item)),
      }));
    },
    async createNote() {
      const accountId = get().accountId;
      if (!accountId || get().creating) return null;
      set({ creating: true });
      const token = generation;
      try {
        const filterProject = get().filters.projectId;
        const body: NoteWrite & { requestId: string } = {
          title: "",
          body: "",
          favorite: false,
          pinned: false,
          tags: [],
          projectId: filterProject === undefined ? null : filterProject,
          requestId: uuidV4(),
        };
        const result = await api<{ note: Note }>("/notes", { method: "POST", json: body });
        if (token !== generation) return null;
        get().applyNote(result.note);
        set((state) => ({ items: [summaryOf(result.note), ...state.items.filter((item) => item.id !== result.note.id)] }));
        set({ creating: false });
        await get().select(result.note.id);
        return result.note;
      } catch (error) {
        if (token === generation) set({ creating: false });
        if (error instanceof ApiError && error.status === 403) get().markDisabled();
        throw error;
      }
    },
    async createFromSource(input) {
      const token = generation;
      const result = await api<{ note: Note }>("/notes/from-source", { method: "POST", json: { ...input, requestId: uuidV4() } });
      if (token !== generation) return null;
      get().applyNote(result.note);
      set((state) => ({ items: [summaryOf(result.note), ...state.items.filter((item) => item.id !== result.note.id)] }));
      await get().select(result.note.id);
      return result.note;
    },
    async deleteNote(note) {
      const token = generation;
      try {
        await api(`/notes/${encodeURIComponent(note.id)}`, { method: "DELETE", json: { revision: note.revision } });
        if (token !== generation) return false;
        set((state) => ({
          items: state.items.filter((item) => item.id !== note.id),
          selectedId: state.selectedId === note.id ? null : state.selectedId,
          selected: state.selectedId === note.id ? null : state.selected,
          selectedStatus: state.selectedId === note.id ? "idle" : state.selectedStatus,
        }));
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) get().markDisabled();
        throw error;
      }
    },
    markDisabled() {
      set({ disabled: true });
    },
  };
});

export const resetNotes = () => useNotes.getState().reset();
