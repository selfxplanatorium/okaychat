import { create } from "zustand";
import type { RoomArchiveInspectResult, RoomArchiveJob, RoomArchiveRosterPage, RoomArchiveSelection } from "@shared/room-archive";
import { api } from "@/lib/api";
import { t } from "@/i18n";

/**
 * One account-bound room archive job. Nothing is persisted in browser storage: a reload recovers the
 * durable server job through `resume()`, and a late answer for the previous account can never paint the
 * next account's dialog. The upload is abortable so Cancel stops reading the file immediately.
 */

interface RoomArchiveState {
  job: RoomArchiveJob | null;
  busy: boolean;
  error: string | null;
  startExport: (channelId: string, selection: RoomArchiveSelection, includeEmails: boolean) => Promise<RoomArchiveJob | null>;
  startImport: (file: File) => Promise<RoomArchiveJob | null>;
  poll: (jobId: string) => Promise<RoomArchiveJob | null>;
  resume: () => Promise<RoomArchiveJob | null>;
  inspect: (jobId: string, name?: string) => Promise<RoomArchiveInspectResult | null>;
  roster: (jobId: string, after?: string | null) => Promise<RoomArchiveRosterPage | null>;
  confirm: (jobId: string, name: string, reviewDigest: string) => Promise<RoomArchiveJob | null>;
  cancel: (jobId: string) => Promise<void>;
  reset: () => void;
  setError: (error: string | null) => void;
}

let account = "";
let accountEpoch = 0;
let upload: AbortController | null = null;

export function startRoomArchiveAccount(userId: string): void {
  if (account === userId) return;
  account = userId;
  accountEpoch++;
  upload?.abort();
  upload = null;
  useRoomArchives.setState({ job: null, busy: false, error: null });
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : t("roomArchives.failed"));

export const useRoomArchives = create<RoomArchiveState>((set, get) => ({
  job: null,
  busy: false,
  error: null,
  startExport: async (channelId, selection, includeEmails) => {
    const epoch = accountEpoch;
    set({ busy: true, error: null });
    try {
      const created = await api<{ jobId: string }>(`/channels/${encodeURIComponent(channelId)}/archive-exports`, {
        method: "POST",
        json: { selection, includeEmails },
      });
      if (epoch !== accountEpoch) return null;
      return get().poll(created.jobId);
    } catch (cause) {
      if (epoch !== accountEpoch) return null;
      set({ busy: false, error: message(cause) });
      return null;
    }
  },
  startImport: async (file) => {
    const epoch = accountEpoch;
    set({ busy: true, error: null });
    upload?.abort();
    const controller = new AbortController();
    upload = controller;
    try {
      const created = await api<{ jobId: string; uploadUrl: string }>("/room-archives/imports", { method: "POST", json: {} });
      if (epoch !== accountEpoch) return null;
      await api(created.uploadUrl.replace(/^\/api/, ""), {
        method: "PUT",
        body: file,
        headers: { "Content-Type": "application/zip" },
        signal: controller.signal,
      });
      if (epoch !== accountEpoch) return null;
      upload = null;
      return get().poll(created.jobId);
    } catch (cause) {
      if (epoch !== accountEpoch) return null;
      upload = null;
      set({ busy: false, error: message(cause) });
      return null;
    }
  },
  poll: async (jobId) => {
    const epoch = accountEpoch;
    try {
      const { job } = await api<{ job: RoomArchiveJob | null }>(`/room-archives/${encodeURIComponent(jobId)}`);
      if (epoch !== accountEpoch) return null;
      set({ job, busy: job?.state === "queued" || job?.state === "preparing" || job?.state === "committing" });
      return job;
    } catch (cause) {
      if (epoch !== accountEpoch) return null;
      set({ busy: false, error: message(cause) });
      return null;
    }
  },
  resume: async () => {
    const epoch = accountEpoch;
    try {
      const { job } = await api<{ job: RoomArchiveJob | null }>("/room-archives");
      if (epoch !== accountEpoch) return null;
      set({ job, busy: job?.state === "queued" || job?.state === "preparing" || job?.state === "committing", error: null });
      return job;
    } catch (cause) {
      if (epoch !== accountEpoch) return null;
      set({ busy: false, error: message(cause) });
      return null;
    }
  },
  inspect: async (jobId, name) => {
    const epoch = accountEpoch;
    try {
      const result = await api<RoomArchiveInspectResult>(`/room-archives/${encodeURIComponent(jobId)}/inspect`, {
        method: "POST",
        json: name === undefined ? {} : { name },
      });
      if (epoch !== accountEpoch) return null;
      set((state) => ({
        busy: false,
        job: state.job ? { ...state.job, summary: result.summary } : state.job,
      }));
      return result;
    } catch (cause) {
      if (epoch !== accountEpoch) return null;
      set({ busy: false, error: message(cause) });
      return null;
    }
  },
  roster: async (jobId, after) => {
    const epoch = accountEpoch;
    try {
      const query = after ? `?after=${encodeURIComponent(after)}` : "";
      const page = await api<RoomArchiveRosterPage>(`/room-archives/${encodeURIComponent(jobId)}/identities${query}`);
      return epoch === accountEpoch ? page : null;
    } catch (cause) {
      if (epoch !== accountEpoch) return null;
      set({ error: message(cause) });
      return null;
    }
  },
  confirm: async (jobId, name, reviewDigest) => {
    const epoch = accountEpoch;
    set({ busy: true, error: null });
    try {
      await api<{ jobId: string }>(`/room-archives/${encodeURIComponent(jobId)}/confirm`, {
        method: "POST",
        json: { name, reviewDigest, acceptWarnings: true },
      });
      if (epoch !== accountEpoch) return null;
      return get().poll(jobId);
    } catch (cause) {
      if (epoch !== accountEpoch) return null;
      set({ busy: false, error: message(cause) });
      // A changed review or quota failure keeps the ready job usable.
      void get().poll(jobId);
      return null;
    }
  },
  cancel: async (jobId) => {
    const epoch = accountEpoch;
    upload?.abort();
    upload = null;
    try {
      await api(`/room-archives/${encodeURIComponent(jobId)}`, { method: "DELETE" });
    } catch {
      // A completed import cannot be undone; the next poll reports the result instead.
    }
    if (epoch !== accountEpoch) return;
    await get().poll(jobId);
  },
  reset: () => {
    upload?.abort();
    upload = null;
    set({ job: null, busy: false, error: null });
  },
  setError: (error) => set({ error }),
}));
