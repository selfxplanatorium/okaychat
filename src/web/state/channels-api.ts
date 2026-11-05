import { api } from "@/lib/api";
import type {
  ChannelChangesPage,
  ChannelChangesReset,
  ChannelDirectoryEntry,
  ChannelInviteSummary,
  ChannelMemberSummary,
  ChannelMessage,
  ChannelMessagePage,
  ChannelSearchPage,
  ChannelSummary,
  ChannelSync,
  ChannelVisibility,
  ChannelIcon,
  ChannelRole,
  ChannelNotifyMode,
  ChannelMentionInput,
  ChannelRunProjection,
} from "@shared/channels";

/** Typed adapter over the channel REST API. All authorization stays server-side. */

const path = (channelId: string, suffix = "") => `/channels/${encodeURIComponent(channelId)}${suffix}`;

/** A binding request is resolved server-side; the client never supplies a label or instructions. */
export type ChannelBindingRequest =
  | { kind: "model"; modelRef: string }
  | { kind: "preset"; presetId: string; confirmReduced: boolean };

export const channelsApi = {
  sync: () => api<ChannelSync>("/channels/sync"),
  groups: () => api<{ items: Array<{ id: string; name: string }> }>("/channels/groups"),
  list: (scope: "joined" | "discover" | "invited", q = "", before?: string | null) =>
    api<{ items: Array<ChannelSummary | ChannelDirectoryEntry | ChannelInviteSummary>; nextCursor: string | null; cursor: string }>(
      `/channels?scope=${scope}&q=${encodeURIComponent(q)}${before ? `&before=${encodeURIComponent(before)}` : ""}`,
    ),
  get: (id: string) => api<{ channel: ChannelSummary | ChannelDirectoryEntry }>(path(id)),
  create: (input: {
    clientId: string;
    name: string;
    description?: string;
    icon: ChannelIcon;
    visibility: ChannelVisibility;
    groupIds?: string[];
    ai?: ChannelBindingRequest | null;
  }) => api<{ channel: ChannelSummary }>("/channels", { method: "POST", json: input }),
  update: (id: string, input: { revision: number; name?: string; description?: string; icon?: ChannelIcon; groupIds?: string[]; ai?: ChannelBindingRequest | null }) =>
    api<{ channel: ChannelSummary }>(path(id), { method: "PATCH", json: input }),
  join: (id: string) => api<{ channel: ChannelSummary }>(path(id, "/join"), { method: "POST", json: {} }),
  accept: (id: string) => api<{ channel: ChannelSummary }>(path(id, "/invite/accept"), { method: "POST", json: {} }),
  decline: (id: string) => api<{ ok: true }>(path(id, "/invite"), { method: "DELETE" }),
  leave: (id: string) => api<{ ok: true }>(path(id, "/leave"), { method: "POST", json: {} }),
  audience: (id: string) => api<{ groupIds: string[] }>(path(id, "/audience")),
  pendingInvites: (id: string) => api<{ items: Array<{ id: string; name: string; createdAt: number }> }>(path(id, "/invites")),
  exclusions: (id: string) => api<{ items: Array<{ id: string; name: string; createdAt: number }> }>(path(id, "/exclusions")),
  members: (id: string, after?: string | null) =>
    api<{ items: ChannelMemberSummary[]; nextCursor: string | null }>(path(id, `/members${after ? `?after=${encodeURIComponent(after)}` : ""}`)),
  candidates: (id: string, email: string) => api<{ items: Array<{ id: string; name: string }> }>(path(id, `/candidates?q=${encodeURIComponent(email)}`)),
  invite: (id: string, userIds: string[]) => api<{ added: string[]; pending: string[] }>(path(id, "/invites"), { method: "POST", json: { userIds } }),
  revokeInvite: (id: string, userId: string) => api<{ ok: true }>(path(id, `/invites/${encodeURIComponent(userId)}`), { method: "DELETE" }),
  removeMember: (id: string, userId: string) => api<{ ok: true }>(path(id, `/members/${encodeURIComponent(userId)}`), { method: "DELETE" }),
  unblock: (id: string, userId: string) => api<{ ok: true }>(path(id, `/exclusions/${encodeURIComponent(userId)}`), { method: "DELETE" }),
  setRole: (id: string, userId: string, revision: number, role: "moderator" | "member") =>
    api<{ ok: true }>(path(id, `/members/${encodeURIComponent(userId)}`), { method: "PATCH", json: { revision, role } }),
  transfer: (id: string, revision: number, userId: string) => api<{ channel: ChannelSummary }>(path(id, "/transfer"), { method: "POST", json: { revision, userId } }),
  archive: (id: string, revision: number, archived: boolean) => api<{ channel: ChannelSummary }>(path(id, "/archive"), { method: "POST", json: { revision, archived } }),
  remove: (id: string, revision: number, reason?: string) => api<{ ok: true }>(path(id), { method: "DELETE", json: { revision, reason } }),
  messages: (id: string, query: { beforeSeq?: number; afterSeq?: number; aroundId?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.beforeSeq !== undefined) params.set("beforeSeq", String(query.beforeSeq));
    if (query.afterSeq !== undefined) params.set("afterSeq", String(query.afterSeq));
    if (query.aroundId) params.set("aroundId", query.aroundId);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    return api<ChannelMessagePage>(path(id, `/messages${params.size ? `?${params}` : ""}`));
  },
  message: (id: string, messageId: string) => api<{ message: ChannelMessage; cursor: string }>(path(id, `/messages/${encodeURIComponent(messageId)}`)),
  post: (id: string, input: { clientId: string; body: string; replyTo?: string; mentions?: ChannelMentionInput[]; requestAi?: boolean }) =>
    api<{ message: ChannelMessage; messageId?: string; runId?: string | null; cursor?: string }>(path(id, "/messages"), { method: "POST", json: input }),
  editMessage: (id: string, messageId: string, input: { revision: number; body: string; mentions?: ChannelMentionInput[] }) =>
    api<{ message: ChannelMessage }>(path(id, `/messages/${encodeURIComponent(messageId)}`), { method: "PATCH", json: input }),
  deleteMessage: (id: string, messageId: string, revision: number, reason?: string) =>
    api<{ ok: true }>(path(id, `/messages/${encodeURIComponent(messageId)}`), { method: "DELETE", json: { revision, reason } }),
  react: (id: string, messageId: string, emoji: string, add: boolean) =>
    api<{ message: ChannelMessage; revision: number }>(path(id, `/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`), { method: add ? "PUT" : "DELETE" }),
  read: (id: string, throughSeq: number) => api<{ readSeq: number; unread: number; mentionsUnread: number }>(path(id, "/read"), { method: "POST", json: { throughSeq } }),
  preferences: (id: string, notifyMode: ChannelNotifyMode) => api<{ ok: true }>(path(id, "/preferences"), { method: "PATCH", json: { notifyMode } }),
  search: (id: string, q: string, before?: string | null) =>
    api<ChannelSearchPage>(`/channels/search?channelId=${encodeURIComponent(id)}&q=${encodeURIComponent(q)}${before ? `&before=${encodeURIComponent(before)}` : ""}`),
  aiRun: (id: string, clientId: string, sourceId: string) =>
    api<{ run: ChannelRunProjection; message: ChannelMessage }>(path(id, "/ai-runs"), { method: "POST", json: { clientId, sourceId } }),
  aiStatus: (id: string, runId: string) => api<{ run: ChannelRunProjection }>(path(id, `/ai-runs/${encodeURIComponent(runId)}`)),
  cancelAi: (id: string, runId: string) => api<{ run: ChannelRunProjection }>(path(id, `/ai-runs/${encodeURIComponent(runId)}/cancel`), { method: "POST", json: {} }),
  changes: (cursor: string) => api<ChannelChangesPage | ChannelChangesReset>(`/channels/changes?cursor=${encodeURIComponent(cursor)}`),
  adminList: (before?: string | null) =>
    api<{ items: Array<{ id: string; name: string; visibility: ChannelVisibility; archivedAt: number | null; ownerId: string; ownerName: string; memberCount: number; messageCount: number; revision: number; createdAt: number; updatedAt: number }>; nextCursor: string | null }>(
      `/admin/channels${before ? `?before=${encodeURIComponent(before)}` : ""}`,
    ),
  adminMessages: (id: string, reason: string, beforeSeq?: number) =>
    api<ChannelMessagePage>(`/admin/channels/${encodeURIComponent(id)}/messages?reason=${encodeURIComponent(reason)}${beforeSeq ? `&beforeSeq=${beforeSeq}` : ""}`),
  adminModerate: (id: string, input: { action: string; targetId?: string; role?: ChannelRole; archived?: boolean; revision: number; reason: string }) =>
    api<{ ok: true }>(`/admin/channels/${encodeURIComponent(id)}/moderate`, { method: "POST", json: input }),
  adminRemove: (id: string, revision: number, reason: string) =>
    api<{ ok: true }>(`/admin/channels/${encodeURIComponent(id)}`, { method: "DELETE", json: { revision, reason } }),
};
