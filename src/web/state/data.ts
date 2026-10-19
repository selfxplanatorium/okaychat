import { create } from "zustand";
import type { McpServerInfo, Me, ModelInfo, Project, ProviderInfo, UserSettings } from "@shared/types";
import { api } from "@/lib/api";

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
  selectedModel: localStorage.getItem(SELECTED_KEY),
  projects: [],
  activeProject: localStorage.getItem(PROJECT_KEY),
  setActiveProject: (id) => {
    if (id) localStorage.setItem(PROJECT_KEY, id);
    else localStorage.removeItem(PROJECT_KEY);
    set({ activeProject: id });
    const model = get().projects.find((p) => p.id === id)?.defaultModel;
    if (model) get().selectModel(model);
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
  },
  selectModel: (ref) => {
    localStorage.setItem(SELECTED_KEY, ref);
    set({ selectedModel: ref });
  },
}));

/** The model the next message will use. */
export function useActiveModel(): ModelInfo | undefined {
  const models = useData((s) => s.models);
  const selected = useData((s) => s.selectedModel);
  const fallback = useData((s) => s.settings?.defaultModel);
  return models.find((m) => m.ref === selected) ?? models.find((m) => m.ref === fallback) ?? models[0];
}
