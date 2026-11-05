import { create } from "zustand";
import type { AssistantPreset, AssistantSnapshot, PresetOptions, ThreadAssistant } from "@shared/assistant-presets";
import type { ThreadSummary } from "@shared/types";
import { api } from "@/lib/api";

/**
 * Private assistant library state for this session. Never persisted: a signed-out device must not keep a
 * builder draft, and a late answer for the previous account must never paint the next one.
 */

interface Selection {
  presetId: string;
  presetRevision: number;
}

interface AssistantPresetsState {
  mine: AssistantPreset[];
  published: AssistantPreset[];
  nextCursor: string | null;
  loading: boolean;
  publishedLoading: boolean;
  error: string | null;
  options: PresetOptions | null;
  optionsKey: string | null;
  optionsLoading: boolean;
  /** Thread id → assistant revision, so model and knowledge PATCHes can name their base. */
  revisions: Record<string, number>;
  /** Snapshot labels by thread, hydrated from thread details. */
  labels: Record<string, ThreadSummary["assistant"]>;
  /** A new chat's choice, keyed by the local thread id until the server creates it. */
  drafts: Record<string, Selection | null | undefined>;
  /** Temporary chats hold the full validated snapshot in memory only. */
  temporary: Record<string, AssistantSnapshot | null | undefined>;
  loadMine: () => Promise<void>;
  loadPublished: (reset?: boolean) => Promise<void>;
  loadOptions: (threadId?: string | null) => Promise<PresetOptions>;
  rememberThread: (thread: Pick<ThreadSummary, "id" | "assistant" | "assistantRevision">) => void;
  setLabel: (threadId: string, label: ThreadSummary["assistant"]) => void;
  rememberRevision: (threadId: string, revision: number) => void;
  revisionOf: (threadId: string) => number | undefined;
  apply: (threadId: string, selection: Selection | null, expectedRevision: number) => Promise<ThreadAssistant>;
  setDraft: (localId: string, selection: Selection | null) => void;
  takeDraft: (localId: string) => Selection | null | undefined;
  setTemporary: (remoteId: string, snapshot: AssistantSnapshot | null) => void;
  clearThread: (threadId: string) => void;
}

let account = "";
let generation = 0;
let publishedRequest = 0;
let optionsRequest = 0;

export function startAssistantAccount(userId: string): void {
  if (account === userId) return;
  account = userId;
  generation++;
  useAssistantPresets.setState({
    mine: [],
    published: [],
    nextCursor: null,
    loading: false,
    publishedLoading: false,
    error: null,
    options: null,
    optionsKey: null,
    optionsLoading: false,
    revisions: {},
    labels: {},
    drafts: {},
    temporary: {},
  });
}

export const useAssistantPresets = create<AssistantPresetsState>((set, get) => ({
  mine: [],
  published: [],
  nextCursor: null,
  loading: false,
  publishedLoading: false,
  error: null,
  options: null,
  optionsKey: null,
  optionsLoading: false,
  revisions: {},
  labels: {},
  drafts: {},
  temporary: {},
  loadMine: async () => {
    const started = generation;
    set({ loading: true, error: null });
    try {
      const page = await api<{ items: AssistantPreset[]; nextCursor: string | null }>("/assistant-presets?scope=mine");
      if (started === generation) set({ mine: page.items, loading: false });
    } catch {
      if (started === generation) set({ loading: false, error: "assistants.loadFailed" });
    }
  },
  loadPublished: async (reset = true) => {
    const request = ++publishedRequest;
    const started = generation;
    const cursor = reset ? null : get().nextCursor;
    if (!reset && !cursor) return;
    set({ publishedLoading: true });
    try {
      const page = await api<{ items: AssistantPreset[]; nextCursor: string | null }>(
        `/assistant-presets?scope=published${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (request !== publishedRequest || started !== generation) return;
      set((state) => ({
        published: reset ? page.items : [...state.published, ...page.items.filter((item) => !state.published.some((old) => old.id === item.id))].slice(0, 500),
        nextCursor: page.nextCursor,
        publishedLoading: false,
      }));
    } catch {
      if (request === publishedRequest && started === generation) set({ publishedLoading: false });
    }
  },
  loadOptions: async (threadId) => {
    const key = threadId ?? "";
    const request = ++optionsRequest;
    set({ optionsLoading: true });
    const options = await api<PresetOptions>(`/assistant-presets/options${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`);
    if (request === optionsRequest) set({ options, optionsKey: key, optionsLoading: false });
    return options;
  },
  rememberThread: (thread) =>
    set((state) => ({
      revisions: { ...state.revisions, [thread.id]: thread.assistantRevision ?? 0 },
      labels: { ...state.labels, [thread.id]: thread.assistant ?? null },
    })),
  rememberRevision: (threadId, revision) => set((state) => ({ revisions: { ...state.revisions, [threadId]: revision } })),
  setLabel: (threadId, label) => set((state) => ({ labels: { ...state.labels, [threadId]: label } })),
  revisionOf: (threadId) => get().revisions[threadId],
  apply: async (threadId, selection, expectedRevision) => {
    const result = await api<ThreadAssistant>(`/threads/${threadId}/assistant`, {
      method: "PUT",
      json: { expectedRevision, selection },
    });
    set((state) => ({
      revisions: { ...state.revisions, [threadId]: result.revision },
      labels: {
        ...state.labels,
        [threadId]: result.snapshot
          ? { name: result.snapshot.name, icon: result.snapshot.icon, revision: result.snapshot.sourceRevision, modelRef: result.snapshot.modelRef }
          : null,
      },
    }));
    return result;
  },
  setDraft: (localId, selection) => set((state) => ({ drafts: { ...state.drafts, [localId]: selection } })),
  takeDraft: (localId) => {
    const selection = get().drafts[localId];
    set((state) => {
      const drafts = { ...state.drafts };
      delete drafts[localId];
      return { drafts };
    });
    return selection;
  },
  setTemporary: (remoteId, snapshot) => set((state) => ({ temporary: { ...state.temporary, [remoteId]: snapshot } })),
  clearThread: (threadId) =>
    set((state) => {
      const revisions = { ...state.revisions };
      const labels = { ...state.labels };
      const temporary = { ...state.temporary };
      delete revisions[threadId];
      delete labels[threadId];
      delete temporary[threadId];
      return { revisions, labels, temporary };
    }),
}));

/** The assistant label of a chat, from the last thread detail or local application. */
export const threadAssistantLabel = (threadId: string | null | undefined) =>
  threadId ? (useAssistantPresets.getState().labels[threadId] ?? null) : null;

/** Snapshot for a temporary chat's request, or undefined for a normal chat. */
export function temporaryAssistantOf(threadId: string | null | undefined): AssistantSnapshot | undefined {
  if (!threadId) return undefined;
  return useAssistantPresets.getState().temporary[threadId] ?? undefined;
}

/** Finds a preset in either loaded list, so the picker can show the selected row without a request. */
export function findPreset(id: string): AssistantPreset | undefined {
  const state = useAssistantPresets.getState();
  return state.mine.find((item) => item.id === id) ?? state.published.find((item) => item.id === id);
}

export function clearAssistantSelection(threadId: string): void {
  useAssistantPresets.getState().clearThread(threadId);
}

/** The last known snapshot revision of a chat, for model/knowledge PATCH compare-and-set. */
export const assistantRevisionOf = (threadId: string): number | undefined => useAssistantPresets.getState().revisionOf(threadId);
export const rememberAssistantRevision = (threadId: string, revision: number): void => useAssistantPresets.getState().rememberRevision(threadId, revision);
