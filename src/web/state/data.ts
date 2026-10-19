import { create } from "zustand";
import type { McpServerInfo, Me, ModelInfo, ProviderInfo, UserSettings } from "@shared/types";
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
  /** Plan mode: the model investigates read-only and proposes a plan instead of acting. */
  planMode: boolean;
  setPlanMode: (on: boolean) => void;
  load: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  refreshMcp: () => Promise<void>;
  updateSettings: (patch: Partial<UserSettings>) => Promise<void>;
  selectModel: (ref: string) => void;
}

const SELECTED_KEY = "okaychat:selected-model";
const PLAN_KEY = "okaychat:plan-mode";

export const useData = create<DataState>((set, get) => ({
  me: null,
  settings: null,
  providers: [],
  models: [],
  mcp: [],
  loaded: false,
  selectedModel: localStorage.getItem(SELECTED_KEY),
  planMode: localStorage.getItem(PLAN_KEY) === "true",
  setPlanMode: (on) => {
    localStorage.setItem(PLAN_KEY, String(on));
    set({ planMode: on });
  },
  load: async () => {
    const [me, settings, providers, models, mcp] = await Promise.all([
      api<Me>("/me"),
      api<UserSettings>("/settings"),
      api<ProviderInfo[]>("/providers"),
      api<ModelInfo[]>("/models"),
      api<McpServerInfo[]>("/mcp"),
    ]);
    set({ me, settings, providers, models, mcp, loaded: true });
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
