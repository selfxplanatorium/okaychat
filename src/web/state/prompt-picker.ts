import { create } from "zustand";
import type { McpPromptInfo } from "@shared/types";
import type { SavedPrompt } from "@shared/saved-prompts";

// One prompt dialog for the whole chat: the toolbar button, the plus menu, the slash menu, and the command all
// open this same instance. The target records where the expanded text goes, so a replaced slash token is never
// applied to another chat or to text the user changed meanwhile.

export type PromptInsertTarget =
  | { kind: "append" }
  | { kind: "replace"; threadKey: string; text: string; accountId?: string };

export type PromptPickerView = "picker" | "manage" | "fill" | "external";

interface PromptPickerState {
  open: boolean;
  view: PromptPickerView;
  fill: SavedPrompt | null;
  external: McpPromptInfo | null;
  target: PromptInsertTarget;
  openPicker: (target?: PromptInsertTarget) => void;
  openManager: () => void;
  openFill: (prompt: SavedPrompt, target: PromptInsertTarget) => void;
  openExternal: (prompt: McpPromptInfo, target: PromptInsertTarget) => void;
  showPicker: () => void;
  showManager: () => void;
  close: () => void;
}

const APPEND: PromptInsertTarget = { kind: "append" };

export const usePromptPicker = create<PromptPickerState>((set) => ({
  open: false,
  view: "picker",
  fill: null,
  external: null,
  target: APPEND,
  openPicker: (target = APPEND) => set({ open: true, view: "picker", fill: null, external: null, target }),
  openManager: () => set({ open: true, view: "manage", fill: null, external: null, target: APPEND }),
  openFill: (prompt, target) => set({ open: true, view: "fill", fill: prompt, external: null, target }),
  openExternal: (prompt, target) => set({ open: true, view: "external", fill: null, external: prompt, target }),
  showPicker: () => set({ view: "picker", fill: null, external: null }),
  showManager: () => set({ view: "manage", fill: null, external: null }),
  // Closing discards unsubmitted variable values and any pending replacement.
  close: () => set({ open: false, view: "picker", fill: null, external: null, target: APPEND }),
}));

export const closePromptPicker = () => usePromptPicker.getState().close();

export const openPromptPicker = (target?: PromptInsertTarget) => usePromptPicker.getState().openPicker(target);
export const openPromptManager = () => usePromptPicker.getState().openManager();
export const openFill = (prompt: SavedPrompt, target: PromptInsertTarget) => usePromptPicker.getState().openFill(prompt, target);
export const openExternal = (prompt: McpPromptInfo, target: PromptInsertTarget) => usePromptPicker.getState().openExternal(prompt, target);
