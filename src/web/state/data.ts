import { create } from "zustand";
import type { McpPromptInfo, McpServerInfo, Me, ModelInfo, Project, ProviderInfo, StorageInfo, UserSettings } from "@shared/types";
import { api, prefetch } from "@/lib/api";
import { setLibraryAccount } from "./library-cache";
import { clearMessageEdits } from "./message-edits";
import { useServices } from "./services";
import { warmThreadCache } from "@/runtime/threadCache";

interface DataState {
  me: Me | null;
  settings: UserSettings | null;
  providers: ProviderInfo[];
  models: ModelInfo[];
  mcp: Array<McpServerInfo & { authorizationUrl?: string }>;
  mcpPrompts: McpPromptInfo[];
  loaded: boolean;
  /** Model chosen in the composer of a chat that has no thread yet. Falls back to the project/account default. */
  selectedModel: string | null;
  /** Model of each stored chat, by thread id: picked in its composer or last used, as saved on the thread. */
  threadModels: Record<string, string>;
  projects: Project[];
  /** Sidebar filter and home of new chats. Null shows every chat. */
  activeProject: string | null;
  setActiveProject: (id: string | null) => void;
  refreshProjects: () => Promise<void>;
  /** How much of the storage quota the account has used. Refreshed by the screens that show it. */
  storage: StorageInfo | null;
  load: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  refreshMcp: () => Promise<void>;
  refreshMcpPrompts: () => Promise<void>;
  refreshStorage: () => Promise<void>;
  updateSettings: (patch: Partial<UserSettings>) => Promise<void>;
  /** Picks the model for a chat. Without a thread id it applies to the new chat being written. */
  selectModel: (ref: string, threadId?: string | null) => void;
  /** Records models saved on threads without overriding a choice made in this page. */
  rememberThreadModels: (models: Record<string, string>) => void;
  resetModel: () => void;
}

const SELECTED_KEY = "okaychat:selected-model";
const PROJECT_KEY = "okaychat:active-project";
let promptRequest = 0;

export const useData = create<DataState>((set, get) => ({
  me: null,
  settings: null,
  providers: [],
  models: [],
  mcp: [],
  mcpPrompts: [],
  loaded: false,
  storage: null,
  // A previous chat's composer choice must not override the account default on reload.
  selectedModel: null,
  threadModels: {},
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
    set({ mcpPrompts: [] });
    // Discovery connects MCP servers, so it must not hold up the chat's startup data.
    void get().refreshMcpPrompts();
    const [me, settings, providers, models, mcp, projects, storage] = await Promise.all([
      api<Me>("/me"),
      api<UserSettings>("/settings"),
      api<ProviderInfo[]>("/providers"),
      api<ModelInfo[]>("/models"),
      api<McpServerInfo[]>("/mcp"),
      api<Project[]>("/projects"),
      api<StorageInfo>("/storage"),
    ]);
    const active = get().activeProject;
    set({ me, settings, providers, models, mcp, projects, storage, loaded: true, ...(active && !projects.some((p) => p.id === active) ? { activeProject: null } : {}) });
  },
  refreshProviders: async () => {
    const [providers, models] = await Promise.all([api<ProviderInfo[]>("/providers"), api<ModelInfo[]>("/models")]);
    set({ providers, models });
  },
  refreshMcp: async () => {
    set({ mcp: await api<McpServerInfo[]>("/mcp"), mcpPrompts: [] });
    void get().refreshMcpPrompts();
  },
  refreshMcpPrompts: async () => {
    const request = ++promptRequest;
    const mcpPrompts = await api<McpPromptInfo[]>("/mcp/prompts").catch(() => []);
    // A settings change or account switch can supersede an in-flight discovery.
    if (request === promptRequest) set({ mcpPrompts });
  },
  refreshStorage: async () => set({ storage: await api<StorageInfo>("/storage") }),
  updateSettings: async (patch) => {
    set({ settings: { ...get().settings!, ...patch } });
    set({ settings: await api<UserSettings>("/settings", { method: "PATCH", json: patch }) });
    if (Object.hasOwn(patch, "defaultModel")) get().resetModel();
  },
  selectModel: (ref, threadId) => {
    if (!threadId) return set({ selectedModel: ref });
    set((s) => ({ threadModels: { ...s.threadModels, [threadId]: ref } }));
    if (!isTemporaryThread(threadId)) void api(`/threads/${threadId}`, { method: "PATCH", json: { modelRef: ref } }).catch(() => {});
  },
  rememberThreadModels: (models) => set((s) => ({ threadModels: { ...models, ...s.threadModels } })),
  resetModel: () => {
    localStorage.removeItem(SELECTED_KEY);
    set({ selectedModel: null });
  },
}));

// Same test as isTemporaryChat, which lives with assistant-ui code this module must not import.
const isTemporaryThread = (id: string) => id.startsWith("tmp_");

/** The model the next message of a chat will use. Without a thread id: the new chat being written. */
export function useActiveModel(threadId?: string | null): ModelInfo | undefined {
  return useData((s) => resolveActiveModel(s, threadId));
}

function resolveActiveModel({ models, selectedModel, threadModels, settings, projects, activeProject }: DataState, threadId?: string | null): ModelInfo | undefined {
  const selected = threadId ? threadModels[threadId] : selectedModel;
  const fallback = settings?.defaultModel;
  const projectModel = projects.find((p) => p.id === activeProject)?.defaultModel;
  return models.find((m) => m.ref === selected) ?? models.find((m) => m.ref === projectModel) ?? models.find((m) => m.ref === fallback) ?? models[0];
}

export const getActiveModel = (threadId?: string | null) => resolveActiveModel(useData.getState(), threadId);

export const selectedThreadKey = (userId: string | undefined) => `okaychat:thread:${userId}`;

/** Every stored chat has its own address. */
export const chatPath = (threadId: string) => `/c/${encodeURIComponent(threadId)}`;
export function chatIdFromPath(path: string): string | undefined {
  const match = path.match(/^\/c\/([^/]+)\/?$/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
}
/** The chat view is "/" (a new chat) or a chat's own URL. */
export const isChatRoute = (path: string) => path === "/" || chatIdFromPath(path) !== undefined;
/**
 * Shows the chat view from another page. Inside it the URL already follows the open chat, and pushing "/" there
 * would add a history entry for the same chat.
 */
export function showChat(navigate: (to: string) => void) {
  if (!isChatRoute(location.pathname)) navigate("/");
}
export const threadsPath = (project: string | null) => (project ? `/threads?project=${encodeURIComponent(project)}` : "/threads");

let preloaded: { userId: string; promise?: Promise<void> } | undefined;

/** Starts the shell's data requests as soon as the session is known, alongside the shell chunk and appearance. */
export function preloadData(userId: string) {
  setLibraryAccount(userId);
  // A new account must not inherit the previous one's edited-reply badges or open editor.
  if (preloaded?.userId !== userId) clearMessageEdits();
  // The service registry is optional data: it starts alongside the rest and never holds up the chat.
  useServices.getState().start(userId);
  // Once per signed-in user: a later status check for the same session must not refetch under a mounted shell.
  if (preloaded?.userId === userId) return;
  const promise = useData.getState().load();
  promise.catch(() => {});
  prefetch(threadsPath(useData.getState().activeProject));
  // The composer's call button appears only when the server can run a call; the check downloads no model.
  prefetch("/voice");
  // RuntimeProvider opens the chat in the URL (or this tab's selected chat); its messages are needed for the first paint.
  try {
    const saved = chatIdFromPath(location.pathname) || new URLSearchParams(location.search).get("thread") || sessionStorage.getItem(selectedThreadKey(userId));
    // Same test as isTemporaryChat, which lives with assistant-ui code this entry module must not import.
    if (saved && !saved.startsWith("tmp_")) {
      prefetch(`/threads/${saved}/messages`);
      warmThreadCache();
    }
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
