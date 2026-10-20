import { create } from "zustand";
import type { McpServerInfo, Me, ModelInfo, Project, ProviderInfo, UserSettings } from "@shared/types";
import { api, prefetch } from "@/lib/api";

interface DataState {
  me: Me | null;
  settings: UserSettings | null;
  providers: ProviderInfo[];
  models: ModelInfo[];
  mcp: Array<McpServerInfo & { authorizationUrl?: string }>;
  loaded: boolean;
  /** Model chosen in the composer. Falls back to settings.defaultModel. */
  selectedModel: string | null;
  projects: Project[];
  /** Sidebar filter and home of new chats. Null shows every chat. */
  activeProject: string | null;
  setActiveProject: (id: string | null) => void;
  refreshProjects: () => Promise<void>;
  load: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  refreshMcp: () => Promise<void>;
  updateSettings: (patch: Partial<UserSettings>) => Promise<void>;
  selectModel: (ref: string) => void;
  resetModel: () => void;
}

const SELECTED_KEY = "okaychat:selected-model";
const PROJECT_KEY = "okaychat:active-project";

export const useData = create<DataState>((set, get) => ({
  me: null,
  settings: null,
  providers: [],
  models: [],
  mcp: [],
  loaded: false,
  // A previous chat's composer choice must not override the account default on reload.
  selectedModel: null,
  projects: [],
  activeProject: localStorage.getItem(PROJECT_KEY),
  setActiveProject: (id) => {
    if (id) localStorage.setItem(PROJECT_KEY, id);
    else localStorage.removeItem(PROJECT_KEY);
    set({ activeProject: id, selectedModel: null });
  },
  refreshProjects: async () => {
    const projects = await api<Project[]>("/projects");
    // A deleted project must not keep filtering the sidebar.
    const active = get().activeProject;
    set({ projects, ...(active && !projects.some((p) => p.id === active) ? { activeProject: null } : {}) });
  },
  load: async () => {
    const [me, settings, providers, models, mcp, projects] = await Promise.all([
      api<Me>("/me"),
      api<UserSettings>("/settings"),
      api<ProviderInfo[]>("/providers"),
      api<ModelInfo[]>("/models"),
      api<McpServerInfo[]>("/mcp"),
      api<Project[]>("/projects"),
    ]);
    const active = get().activeProject;
    set({ me, settings, providers, models, mcp, projects, loaded: true, ...(active && !projects.some((p) => p.id === active) ? { activeProject: null } : {}) });
  },
  refreshProviders: async () => {
    const [providers, models] = await Promise.all([api<ProviderInfo[]>("/providers"), api<ModelInfo[]>("/models")]);
    set({ providers, models });
  },
  refreshMcp: async () => set({ mcp: await api<McpServerInfo[]>("/mcp") }),
  updateSettings: async (patch) => {
    set({ settings: { ...get().settings!, ...patch } });
    set({ settings: await api<UserSettings>("/settings", { method: "PATCH", json: patch }) });
    if (Object.hasOwn(patch, "defaultModel")) get().resetModel();
  },
  selectModel: (ref) => {
    set({ selectedModel: ref });
  },
  resetModel: () => {
    localStorage.removeItem(SELECTED_KEY);
    set({ selectedModel: null });
  },
}));

/** The model the next message will use. */
export function useActiveModel(): ModelInfo | undefined {
  return useData(resolveActiveModel);
}

function resolveActiveModel({ models, selectedModel: selected, settings, projects, activeProject }: DataState): ModelInfo | undefined {
  const fallback = settings?.defaultModel;
  const projectModel = projects.find((p) => p.id === activeProject)?.defaultModel;
  return models.find((m) => m.ref === selected) ?? models.find((m) => m.ref === projectModel) ?? models.find((m) => m.ref === fallback) ?? models[0];
}

export const getActiveModel = () => resolveActiveModel(useData.getState());

export const selectedThreadKey = (userId: string | undefined) => `okaychat:thread:${userId}`;
export const threadsPath = (project: string | null) => (project ? `/threads?project=${encodeURIComponent(project)}` : "/threads");

let preloaded: { userId: string; promise?: Promise<void> } | undefined;

/** Starts the shell's data requests as soon as the session is known, alongside the shell chunk and appearance. */
export function preloadData(userId: string) {
  // Once per signed-in user: a later status check for the same session must not refetch under a mounted shell.
  if (preloaded?.userId === userId) return;
  const promise = useData.getState().load();
  promise.catch(() => {});
  prefetch(threadsPath(useData.getState().activeProject));
  // RuntimeProvider restores this tab's selected chat; its messages are needed for the first paint.
  try {
    const saved = sessionStorage.getItem(selectedThreadKey(userId));
    // Same test as isAnonymousChat, which lives with assistant-ui code this entry module must not import.
    if (saved && !saved.startsWith("tmp_")) prefetch(`/threads/${saved}/messages`);
  } catch {
    // Session storage may be disabled.
  }
  preloaded = { userId, promise };
}

/** The preloaded request for this user, handed out once so a retry fetches again. */
export function takePreloadedData(userId: string): Promise<void> | undefined {
  if (preloaded?.userId !== userId) return undefined;
  const { promise } = preloaded;
  preloaded.promise = undefined;
  return promise;
}
