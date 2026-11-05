import { create } from "zustand";
import type { ArchiveJob, ArchiveSummary } from "@shared/chat-archive";
import { api } from "@/lib/api";

/**
 * One archive dialog's job. Everything is dropped on sign-out or account change; a late answer for the
 * previous account can never paint the next one. No archive bytes or summary are persisted in the browser.
 */

interface ArchiveState {
  job: ArchiveJob | null;
  busy: boolean;
  error: string | null;
  startExport: (threads: Array<{ id: string; selectedLeaf?: string }>) => Promise<ArchiveJob | null>;
  startImport: (file: File) => Promise<ArchiveJob | null>;
  poll: (jobId: string) => Promise<ArchiveJob | null>;
  confirm: (jobId: string, chatKeys: string[]) => Promise<ArchiveJob["result"] | null>;
  cancel: (jobId: string) => Promise<void>;
  reset: () => void;
  setError: (error: string | null) => void;
}

let account = "";

export function startChatArchiveAccount(userId: string): void {
  if (account === userId) return;
  account = userId;
  useChatArchives.setState({ job: null, busy: false, error: null });
}

export const useChatArchives = create<ArchiveState>((set, get) => ({
  job: null,
  busy: false,
  error: null,
  startExport: async (threads) => {
    set({ busy: true, error: null });
    try {
      const created = await api<{ jobId: string }>("/chat-archives/exports", { method: "POST", json: { threads } });
      return get().poll(created.jobId);
    } catch (cause) {
      set({ busy: false, error: cause instanceof Error ? cause.message : "chatArchives.exportFailed" });
      return null;
    }
  },
  startImport: async (file) => {
    set({ busy: true, error: null });
    try {
      const created = await api<{ jobId: string }>("/chat-archives/imports", { method: "POST", body: file, headers: { "Content-Type": "application/zip" } });
      return get().poll(created.jobId);
    } catch (cause) {
      set({ busy: false, error: cause instanceof Error ? cause.message : "chatArchives.importFailed" });
      return null;
    }
  },
  poll: async (jobId) => {
    try {
      const job = await api<ArchiveJob>(`/chat-archives/${jobId}`);
      set({ job, busy: job.state === "preparing" || job.state === "committing" });
      return job;
    } catch (cause) {
      set({ busy: false, error: cause instanceof Error ? cause.message : "chatArchives.prepareFailed" });
      return null;
    }
  },
  confirm: async (jobId, chatKeys) => {
    set({ busy: true, error: null });
    try {
      const result = await api<NonNullable<ArchiveJob["result"]>>(`/chat-archives/${jobId}/confirm`, { method: "POST", json: { chatKeys } });
      set((state) => ({ busy: false, job: state.job ? { ...state.job, state: "done", result } : state.job }));
      return result;
    } catch (cause) {
      set({ busy: false, error: cause instanceof Error ? cause.message : "chatArchives.importFailed" });
      // A quota failure keeps the ready job; refresh it so the review remains usable.
      void get().poll(jobId);
      return null;
    }
  },
  cancel: async (jobId) => {
    try {
      await api(`/chat-archives/${jobId}`, { method: "DELETE" });
    } catch {
      // A completed import cannot be rolled back; the dialog reports completion instead.
    }
    set({ job: null, busy: false, error: null });
  },
  reset: () => set({ job: null, busy: false, error: null }),
  setError: (error) => set({ error }),
}));

export const archiveSummaryOf = (job: ArchiveJob | null): ArchiveSummary | undefined => job?.summary;
