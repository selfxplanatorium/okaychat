import { create } from "zustand";

// Feedback is one dialog for the chat. Keeping the target here means every message footer and menu opens the
// same form, and switching chats can close it without leaving a draft aimed at an old reply.

export interface FeedbackTarget {
  threadId: string;
  messageId: string;
}

interface FeedbackDialogState {
  target: FeedbackTarget | null;
  open: (target: FeedbackTarget) => void;
  close: () => void;
}

export const useFeedbackDialog = create<FeedbackDialogState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

export const openFeedback = (threadId: string, messageId: string) => useFeedbackDialog.getState().open({ threadId, messageId });
export const closeFeedback = () => useFeedbackDialog.getState().close();
