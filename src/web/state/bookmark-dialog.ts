import { create } from "zustand";

// The bookmark list belongs to the open branch but its dialog lives above the message list, so the header menu
// and the command open one instance owned by ChatView.

interface BookmarkDialogState {
  open: boolean;
  show: () => void;
  hide: () => void;
}

export const useBookmarkDialog = create<BookmarkDialogState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

export const openBookmarks = () => useBookmarkDialog.getState().show();
export const closeBookmarks = () => useBookmarkDialog.getState().hide();
