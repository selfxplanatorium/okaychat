import { create } from "zustand";

/** One dialog for the composer picker and the manage editor, like the saved-prompt picker. */
interface AssistantPickerState {
  open: boolean;
  /** Opens directly in the library view. */
  manage: boolean;
  openPicker: (options?: { manage?: boolean }) => void;
  close: () => void;
}

export const useAssistantPicker = create<AssistantPickerState>((set) => ({
  open: false,
  manage: false,
  openPicker: (options) => set({ open: true, manage: options?.manage === true }),
  close: () => set({ open: false, manage: false }),
}));

export const openAssistantPicker = (options?: { manage?: boolean }) => useAssistantPicker.getState().openPicker(options);
export const closeAssistantPicker = () => useAssistantPicker.getState().close();
