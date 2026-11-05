import { create } from "zustand";

// One translate dialog for the open chat. The menu items live in every message, so the target is kept here
// and switching chats closes it rather than leaving a picker aimed at an old reply.

export interface TranslationTarget {
  threadId: string;
  messageId: string;
}

interface TranslationDialogState {
  target: TranslationTarget | null;
  open: (target: TranslationTarget) => void;
  close: () => void;
}

export const useTranslationDialog = create<TranslationDialogState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

export const openTranslationDialog = (threadId: string, messageId: string) => useTranslationDialog.getState().open({ threadId, messageId });
export const closeTranslationDialog = () => useTranslationDialog.getState().close();
