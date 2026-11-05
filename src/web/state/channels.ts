import { create } from "zustand";
import { generateId } from "ai";
import type {
  ChannelAttachment,
  ChannelDmBlock,
  ChannelDirectoryEntry,
  ChannelEventFrame,
  ChannelIcon,
  ChannelInviteSummary,
  ChannelMemberSummary,
  ChannelMessage,
  ChannelMessagePage,
  ChannelMentionInput,
  ChannelNotifyMode,
  ChannelSummary,
  ChannelThreadPage,
  ChannelVisibility,
} from "@shared/channels";
import { CHANNEL_LIMITS } from "@shared/channels";
import { t } from "@/i18n";
import { channelError } from "@/lib/channel-error";
import { channelsApi, type ChannelBindingRequest } from "./channels-api";
import { startChannelTransport, type TransportState } from "./channels-events";
import { capMessages, mergeMessages, mergeMessage, mergeThread, newestSeq, reconcileRooms, sortMessages, totalUnread, MAX_THREADS_IN_MEMORY, type ChannelThreadState } from "./channels-derive";

/** In-memory channel workspace state. No room text, drafts, or history may touch browser storage. */

type RoomView = ChannelSummary | ChannelDirectoryEntry | null;
type RoomStatus = "idle" | "loading" | "ready" | "directory" | "notFound" | "error";

interface PendingSend {
  clientId: string;
  body: string;
  replyTo?: string;
  threadRootId?: string;
  attachmentIds?: string[];
  mentions?: ChannelMentionInput[];
  requestAi: boolean;
}

export interface PendingAttachment {
  localId: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "failed";
  attachment?: ChannelAttachment;
  /** Kept in memory only, so a failed chip can retry without asking for the file again. */
  file?: File;
  /** A translated reason for a failed upload; never a server body. */
  error?: string;
}

interface ChannelsState {
  accountId: string | null;
  generation: number;
  joined: ChannelSummary[];
  discover: ChannelDirectoryEntry[];
  invites: ChannelInviteSummary[];
  discoverCursor: string | null;
  discoverQuery: string;
  cursor: string | null;
  lastSync: number | null;
  connection: TransportState;
  disabled: boolean;
  error: string | null;
  loading: boolean;
  activeRoomId: string | null;
  room: RoomView;
  roomStatus: RoomStatus;
  messages: Record<string, ChannelMessage[]>;
  pages: Record<string, { nextBeforeSeq: number | null; nextAfterSeq: number | null; hasMore: boolean }>;
  members: ChannelMemberSummary[];
  drafts: Record<string, string>;
  replyTo: Record<string, ChannelMessage | null>;
  aiArmed: Record<string, boolean>;
  pending: Record<string, PendingSend | null>;
  pendingAttachments: Record<string, PendingAttachment[]>;
  uploading: Record<string, number>;
  activeThreadId: string | null;
  threadStatus: "idle" | "loading" | "ready" | "error";
  threadFocusId: string | null;
  threads: Record<string, ChannelThreadState>;
  blocks: ChannelDmBlock[];
  sending: boolean;
  notice: string | null;
  start: (accountId: string) => Promise<void>;
  stop: () => void;
  loadSync: () => Promise<void>;
  loadDiscover: (q?: string, more?: boolean) => Promise<void>;
  selectRoom: (id: string) => Promise<void>;
  refreshRoom: () => Promise<void>;
  loadHistory: (beforeSeq?: number) => Promise<void>;
  loadMembers: () => Promise<void>;
  refreshMessage: (id: string) => Promise<void>;
  jumpToMessage: (id: string) => Promise<void>;
  setDraft: (text: string) => void;
  setReply: (message: ChannelMessage | null) => void;
  setAiArmed: (armed: boolean) => void;
  send: (input: { body: string; mentions?: ChannelMentionInput[]; requestAi: boolean }) => Promise<void>;
  attachFiles: (composerKey: string, files: File[]) => Promise<void>;
  removePendingAttachment: (composerKey: string, localId: string) => void;
  clearPendingAttachments: (composerKey: string) => void;
  openThread: (rootId: string) => Promise<void>;
  closeThread: () => void;
  loadThread: (rootId: string, beforeSeq?: number) => Promise<void>;
  sendToThread: (rootId: string, input: { body: string; mentions?: ChannelMentionInput[]; replyTo?: string }) => Promise<void>;
  markThreadRead: (rootId: string, seq?: number) => Promise<void>;
  loadBlocks: () => Promise<void>;
  blockUser: (userId: string) => Promise<void>;
  unblockUser: (userId: string) => Promise<void>;
  createDm: (userIds: string[]) => Promise<string | null>;
  addDmMembers: (userIds: string[]) => Promise<boolean>;
  lookupPeople: (email: string) => Promise<Array<{ id: string; name: string }>>;
  setThreadFocus: (messageId: string | null) => void;
  edit: (messageId: string, body: string, mentions?: ChannelMentionInput[]) => Promise<boolean>;
  removeMessage: (messageId: string) => Promise<void>;
  react: (messageId: string, emoji: string, add: boolean) => Promise<void>;
  markRead: (throughSeq?: number) => Promise<void>;
  setNotify: (mode: ChannelNotifyMode) => Promise<void>;
  join: (id?: string) => Promise<void>;
  accept: (id: string) => Promise<void>;
  decline: (id: string) => Promise<void>;
  leave: () => Promise<void>;
  create: (input: { name: string; description?: string; icon: ChannelIcon; visibility: ChannelVisibility; groupIds?: string[]; ai?: ChannelBindingRequest | null }) => Promise<string | null>;
  update: (input: { revision: number; name?: string; description?: string; icon?: ChannelIcon; groupIds?: string[]; ai?: ChannelBindingRequest | null }) => Promise<boolean>;
  archive: (archived: boolean) => Promise<void>;
  removeRoom: (revision: number) => Promise<void>;
  invite: (userIds: string[]) => Promise<Array<{ id: string; name: string }>>;
  removeMember: (userId: string) => Promise<void>;
  unblock: (userId: string) => Promise<void>;
  setRole: (userId: string, role: "moderator" | "member") => Promise<void>;
  transfer: (userId: string) => Promise<void>;
  cancelAi: (runId: string) => Promise<void>;
  resetForAccount: (accountId: string | null) => void;
}

let stopTransport: (() => void) | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let messageTimer: ReturnType<typeof setTimeout> | null = null;
const roomRefreshes = new Set<string>();
const messageRefreshes = new Set<string>();
const pendingMessageIds = new Map<string, Set<string>>();

const unreadOf = (rooms: ChannelSummary[]) => totalUnread(rooms);

export const useChannels = create<ChannelsState>((set, get) => {
  const safeError = (error: unknown, fallback: Parameters<typeof channelError>[1]) => {
    const room = get().room;
    const owner = !!room && "ownerId" in room && room.ownerId === get().accountId;
    return channelError(error, fallback, { owner });
  };
  const updateRoomSummary = (room: ChannelSummary) => {
    set((state) => {
      const joined = state.joined.map((item) => (item.id === room.id ? room : item));
      const roomView = state.room && state.room.id === room.id && !("joinable" in state.room) ? room : state.room;
      return { joined, room: roomView };
    });
  };

  /** A message can be the root of one thread or a reply in another; keep both projections fresh. */
  const mergeIntoThreads = (threads: Record<string, ChannelThreadState>, message: ChannelMessage): Record<string, ChannelThreadState> => {
    let changed = false;
    const next = { ...threads };
    for (const [rootId, thread] of Object.entries(threads)) {
      const isRoot = thread.root?.id === message.id;
      const isReply = thread.items.some((item) => item.id === message.id);
      if (!isRoot && !isReply) continue;
      changed = true;
      next[rootId] = {
        ...thread,
        root: isRoot && thread.root ? mergeMessage(thread.root, message) : thread.root,
        items: isReply ? mergeMessages(thread.items, [message]) : thread.items,
      };
    }
    return changed ? next : threads;
  };

  const findMessage = (state: ChannelsState, roomId: string, messageId: string): ChannelMessage | undefined => {
    const direct = (state.messages[roomId] ?? []).find((message) => message.id === messageId);
    if (direct) return direct;
    for (const thread of Object.values(state.threads)) {
      if (thread.root?.id === messageId) return thread.root;
      const reply = thread.items.find((message) => message.id === messageId);
      if (reply) return reply;
    }
    return undefined;
  };

  const updateChip = (composerKey: string, localId: string, patch: Partial<PendingAttachment>) => {
    set((state) => ({
      pendingAttachments: {
        ...state.pendingAttachments,
        [composerKey]: (state.pendingAttachments[composerKey] ?? []).map((chip) => (chip.localId === localId ? { ...chip, ...patch } : chip)),
      },
    }));
  };

  const clearRoomText = (roomId: string) => {    set((state) => {
      const messages = { ...state.messages };
      const pages = { ...state.pages };
      delete messages[roomId];
      delete pages[roomId];
      const drafts = { ...state.drafts };
      const replyTo = { ...state.replyTo };
      const aiArmed = { ...state.aiArmed };
      const pending = { ...state.pending };
      delete drafts[roomId];
      delete replyTo[roomId];
      delete aiArmed[roomId];
      delete pending[roomId];
      // Pending chips and open thread panels belong to the room that just went away.
      const pendingAttachments = { ...state.pendingAttachments };
      const uploading = { ...state.uploading };
      for (const key of Object.keys(pendingAttachments)) if (key === `room:${roomId}` || key.startsWith("thread:")) delete pendingAttachments[key];
      for (const key of Object.keys(uploading)) if (key === `room:${roomId}` || key.startsWith("thread:")) delete uploading[key];
      return {
        messages,
        pages,
        drafts,
        replyTo,
        aiArmed,
        pending,
        pendingAttachments,
        uploading,
        activeThreadId: null,
        threadStatus: "idle" as const,
        threadFocusId: null,
        threads: {},
      };
    });
  };

  const scheduleSync = () => {
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      void get().loadSync();
    }, 150);
  };

  const scheduleRoomRefresh = (roomId: string) => {
    if (roomRefreshes.has(roomId)) return;
    roomRefreshes.add(roomId);
    setTimeout(() => {
      roomRefreshes.delete(roomId);
      const state = get();
      if (!state.joined.some((room) => room.id === roomId)) return;
      void channelsApi
        .get(roomId)
        .then(({ channel }) => {
          if (!("membership" in channel)) return;
          updateRoomSummary(channel as ChannelSummary);
        })
        .catch(() => {});
    }, 200);
  };

  const flushMessageRefreshes = (roomId: string) => {
    if (messageTimer) return;
    messageTimer = setTimeout(() => {
      messageTimer = null;
      const ids = [...(pendingMessageIds.get(roomId) ?? [])];
      pendingMessageIds.delete(roomId);
      if (!ids.length) return;
      if (ids.length > 20) {
        void get().loadHistory();
        return;
      }
      if (messageRefreshes.has(roomId)) {
        const waiting = pendingMessageIds.get(roomId) ?? new Set<string>();
        for (const id of ids) waiting.add(id);
        pendingMessageIds.set(roomId, waiting);
        messageTimer = setTimeout(() => {
          messageTimer = null;
          flushMessageRefreshes(roomId);
        }, 150);
        return;
      }
      void (async () => {
        messageRefreshes.add(roomId);
        try {
          for (const id of ids) {
            if (get().activeRoomId !== roomId) return;
            try {
              const { message } = await channelsApi.message(roomId, id);
              const current = get().messages[roomId] ?? [];
              set({ messages: { ...get().messages, [roomId]: mergeMessages(current, [message]) } });
            } catch {
              // A deleted/inaccessible message is refreshed from the latest page below.
              void get().loadHistory();
              return;
            }
          }
        } finally {
          messageRefreshes.delete(roomId);
        }
      })();
    }, 100);
  };

  const handleFrames = (frames: ChannelEventFrame[]) => {
    for (const frame of frames) {
      const event = frame.event;
      if (event.type === "sync") {
        scheduleSync();
        continue;
      }
      if (event.type === "channel.changed" && event.channelId) {
        scheduleRoomRefresh(event.channelId);
        const active = get().room;
        if (active && "kind" in active && active.id === event.channelId && active.kind === "dm") void get().refreshRoom();
        continue;
      }
      if (event.type === "message.changed" && event.channelId && event.entityId) {
        if (get().activeRoomId !== event.channelId) continue;
        if (event.rootId) {
          void get().refreshMessage(event.rootId);
          if (get().activeThreadId === event.rootId) void mergeThreadReplies(event.rootId);
        }
        const ids = pendingMessageIds.get(event.channelId) ?? new Set<string>();
        ids.add(event.entityId);
        // A changed quote target invalidates every cached reply preview that points at it.
        for (const message of get().messages[event.channelId] ?? []) {
          if (message.replyTo?.id === event.entityId) ids.add(message.id);
        }
        pendingMessageIds.set(event.channelId, ids);
        flushMessageRefreshes(event.channelId);
        continue;
      }
      if (event.type === "members.changed" && event.channelId) {
        if (get().activeRoomId === event.channelId) void get().loadMembers();
        scheduleRoomRefresh(event.channelId);
        continue;
      }
      if (event.type === "read.changed" && event.channelId) {
        const active = get().activeRoomId === event.channelId;
        if (active) scheduleRoomRefresh(event.channelId);
        if (event.rootId && event.version !== undefined) {
          set((state) => {
            const thread = state.threads[event.rootId!];
            if (!thread || event.version! <= thread.readSeq) return {};
            return { threads: { ...state.threads, [event.rootId!]: { ...thread, readSeq: event.version! } } };
          });
        }
      }
    }
  };

  const mergeThreadReplies = async (rootId: string) => {
    const roomId = get().activeRoomId;
    if (!roomId) return;
    const thread = get().threads[rootId];
    const afterSeq = thread?.items.at(-1)?.seq;
    try {
      const page = await channelsApi.thread(roomId, rootId, afterSeq === undefined ? {} : { afterSeq });
      if (get().activeRoomId !== roomId) return;
      set((state) => ({ threads: { ...state.threads, [rootId]: mergeThread(state.threads[rootId], page) } }));
    } catch {
      if (get().activeRoomId === roomId) void get().loadThread(rootId);
    }
  };

  const resetData = (accountId: string | null) => {
    stopTransport?.();
    stopTransport = null;
    if (syncTimer) clearTimeout(syncTimer);
    if (messageTimer) clearTimeout(messageTimer);
    syncTimer = null;
    messageTimer = null;
    roomRefreshes.clear();
    messageRefreshes.clear();
    pendingMessageIds.clear();
    set({
      accountId,
      generation: get().generation + 1,
      joined: [],
      discover: [],
      invites: [],
      discoverCursor: null,
      discoverQuery: "",
      cursor: null,
      lastSync: null,
      connection: accountId ? "reconnecting" : "offline",
      disabled: false,
      error: null,
      loading: false,
      activeRoomId: null,
      room: null,
      roomStatus: "idle",
      messages: {},
      pages: {},
      members: [],
      drafts: {},
      replyTo: {},
      aiArmed: {},
      pending: {},
      pendingAttachments: {},
      uploading: {},
      activeThreadId: null,
      threadStatus: "idle",
      threadFocusId: null,
      threads: {},
      blocks: [],
      sending: false,
      notice: null,
    });
  };

  const beginTransport = () => {
    stopTransport?.();
    stopTransport = startChannelTransport({
      getCursor: () => get().cursor ?? undefined,
      onFrames: handleFrames,
      onReset: () => {
        // Clear cached text first; sync decides which rooms still exist before anything is reloaded.
        set((state) => ({
          messages: {},
          pages: {},
          members: [],
          room: null,
          roomStatus: "idle",
          notice: null,
          generation: state.generation + 1,
          threads: {},
          activeThreadId: null,
          threadStatus: "idle",
          threadFocusId: null,
          pendingAttachments: {},
          uploading: {},
        }));
      },
      onRevoked: () => {
        resetData(get().accountId);
        set({ disabled: true });
      },
      onState: (connection) => set({ connection }),
      onSyncRequested: () => {
        void get().loadSync().then(() => {
          const state = get();
          if (state.activeRoomId) void state.selectRoom(state.activeRoomId);
        });
      },
    });
  };

  return {
    accountId: null,
    generation: 0,
    joined: [],
    discover: [],
    invites: [],
    discoverCursor: null,
    discoverQuery: "",
    cursor: null,
    lastSync: null,
    connection: "offline",
    disabled: false,
    error: null,
    loading: false,
    activeRoomId: null,
    room: null,
    roomStatus: "idle",
    messages: {},
    pages: {},
    members: [],
    drafts: {},
    replyTo: {},
    aiArmed: {},
    pending: {},
    pendingAttachments: {},
    uploading: {},
    activeThreadId: null,
    threadStatus: "idle",
    threadFocusId: null,
    threads: {},
    blocks: [],
    sending: false,
    notice: null,

    start: async (accountId) => {
      if (get().accountId === accountId) return;
      resetData(accountId);
      await get().loadSync();
    },

    stop: () => resetData(null),
    resetForAccount: (accountId) => resetData(accountId),

    loadSync: async () => {
      const generation = get().generation;
      try {
        const sync = await channelsApi.sync();
        if (generation !== get().generation) return;
        set((state) => {
          const joined = sync.items;
          const activeStill = state.activeRoomId ? joined.find((room) => room.id === state.activeRoomId) : undefined;
          const lost = !!state.activeRoomId && !activeStill;
          const messages = lost ? { ...state.messages } : state.messages;
          const pages = lost ? { ...state.pages } : state.pages;
          const drafts = lost ? { ...state.drafts } : state.drafts;
          const replyTo = lost ? { ...state.replyTo } : state.replyTo;
          const aiArmed = lost ? { ...state.aiArmed } : state.aiArmed;
          if (lost && state.activeRoomId) {
            delete messages[state.activeRoomId];
            delete pages[state.activeRoomId];
            delete drafts[state.activeRoomId];
            delete replyTo[state.activeRoomId];
            delete aiArmed[state.activeRoomId];
          }
          return {
            joined,
            invites: sync.invites,
            cursor: sync.cursor,
            lastSync: Date.now(),
            disabled: false,
            error: null,
            loading: false,
            messages,
            pages,
            drafts,
            replyTo,
            aiArmed,
            ...(lost ? {
              activeRoomId: null,
              room: null,
              roomStatus: "idle" as const,
              activeThreadId: null,
              threadStatus: "idle" as const,
              threadFocusId: null,
              threads: {},
              pendingAttachments: {},
              uploading: {},
            } : {}),
            ...(activeStill && state.room && !("joinable" in state.room) ? { room: activeStill } : {}),
          };
        });
        if (!stopTransport && get().accountId) beginTransport();
      } catch (error) {
        if (generation !== get().generation) return;
        const message = safeError(error, "channels.notFound");
        const forbidden = (error as { code?: string }).code === "forbidden";
        set({ loading: false, error: message, ...(forbidden ? { disabled: true } : {}) });
      }
    },

    loadDiscover: async (q = get().discoverQuery, more = false) => {
      const generation = get().generation;
      try {
        const result = await channelsApi.list("discover", q, more ? get().discoverCursor : null);
        if (generation !== get().generation) return;
        const items = result.items.filter((item): item is ChannelDirectoryEntry => "joinable" in item);
        set((state) => ({
          discover: more ? [...state.discover, ...items] : items,
          discoverCursor: result.nextCursor,
          discoverQuery: q,
          cursor: result.cursor,
        }));
      } catch (error) {
        if (generation === get().generation) set({ error: safeError(error, "channels.notFound") });
      }
    },

    selectRoom: async (id) => {
      const generation = get().generation;
      if (get().activeRoomId !== id) {
        // A different room owns its own chips, drafts, and thread panels.
        set({ activeThreadId: null, threadStatus: "idle", threadFocusId: null, threads: {}, pendingAttachments: {}, uploading: {} });
      }
      set({ activeRoomId: id, roomStatus: "loading", error: null, notice: null });
      try {
        const { channel } = await channelsApi.get(id);
        if (generation !== get().generation || get().activeRoomId !== id) return;
        if ("membership" in channel) {
          const summary = channel as ChannelSummary;
          set((state) => ({
            room: summary,
            roomStatus: "ready",
            joined: state.joined.some((room) => room.id === id) ? state.joined.map((room) => (room.id === id ? summary : room)) : [...state.joined, summary],
          }));
          await Promise.all([get().loadHistory(), get().loadMembers()]);
        } else {
          set({ room: channel as ChannelDirectoryEntry, roomStatus: "directory" });
        }
      } catch (error) {
        if (generation === get().generation) set({ room: null, roomStatus: "notFound", error: safeError(error, "channels.notFound") });
      }
    },

    refreshRoom: async () => {
      const id = get().activeRoomId;
      if (!id) return;
      try {
        const { channel } = await channelsApi.get(id);
        if (get().activeRoomId !== id) return;
        if ("membership" in channel) updateRoomSummary(channel as ChannelSummary);
      } catch {
        // A lost room is cleared by the next sync.
      }
    },

    loadHistory: async (beforeSeq) => {
      const id = get().activeRoomId;
      if (!id) return;
      const generation = get().generation;
      try {
        const page: ChannelMessagePage = await channelsApi.messages(id, beforeSeq === undefined ? {} : { beforeSeq });
        if (generation !== get().generation || get().activeRoomId !== id) return;
        set((state) => {
          const current = state.messages[id] ?? [];
          const merged = mergeMessages(current, page.items);
          return {
            messages: { ...state.messages, [id]: merged },
            pages: {
              ...state.pages,
              [id]: { nextBeforeSeq: page.nextBeforeSeq, nextAfterSeq: page.nextAfterSeq, hasMore: page.hasMore },
            },
          };
        });
      } catch (error) {
        if (generation === get().generation) set({ error: safeError(error, "channels.notFound") });
      }
    },

    loadMembers: async () => {
      const id = get().activeRoomId;
      if (!id) return;
      try {
        const result = await channelsApi.members(id);
        if (get().activeRoomId === id) set({ members: result.items });
      } catch {
        // Membership panel failure leaves the timeline usable.
      }
    },

    refreshMessage: async (messageId) => {
      const id = get().activeRoomId;
      if (!id) return;
      try {
        const { message } = await channelsApi.message(id, messageId);
        set((state) => ({
          messages: { ...state.messages, [id]: mergeMessages(state.messages[id] ?? [], [message]) },
          threads: mergeIntoThreads(state.threads, message),
        }));
      } catch {
        void get().loadHistory();
      }
    },

    jumpToMessage: async (messageId) => {
      const id = get().activeRoomId;
      if (!id) return;
      try {
        const { message } = await channelsApi.message(id, messageId);
        if (message.threadRootId) {
          // A reply opens its thread panel; the room timeline never anchors on it.
          await get().openThread(message.threadRootId);
          set({ threadFocusId: message.id });
          return;
        }
        const page = await channelsApi.messages(id, { aroundId: messageId });
        set((state) => ({
          messages: { ...state.messages, [id]: mergeMessages(state.messages[id] ?? [], page.items) },
          pages: { ...state.pages, [id]: { nextBeforeSeq: page.nextBeforeSeq, nextAfterSeq: page.nextAfterSeq, hasMore: page.hasMore } },
        }));
      } catch {
        await get().refreshMessage(messageId);
      }
    },

    setDraft: (text) => {
      const id = get().activeRoomId;
      if (!id) return;
      set((state) => ({ drafts: { ...state.drafts, [id]: text } }));
    },

    setReply: (message) => {
      const id = get().activeRoomId;
      if (!id) return;
      set((state) => ({ replyTo: { ...state.replyTo, [id]: message } }));
    },

    setAiArmed: (armed) => {
      const id = get().activeRoomId;
      if (!id) return;
      set((state) => ({ aiArmed: { ...state.aiArmed, [id]: armed } }));
    },

    send: async ({ body, mentions, requestAi }) => {
      const id = get().activeRoomId;
      const room = get().room;
      if (!id || !room || !("capabilities" in room) || !room.capabilities.post) return;
      const composerKey = `room:${id}`;
      const chips = get().pendingAttachments[composerKey] ?? [];
      if (chips.some((chip) => chip.status === "uploading")) {
        set({ error: t("channels.attachmentUploading") });
        return;
      }
      const attachmentIds = chips.flatMap((chip) => (chip.status === "ready" && chip.attachment ? [chip.attachment.id] : []));
      const text = body.replace(/\r\n/g, "\n");
      if (!text.trim() && !attachmentIds.length) return;
      const prior = get().pending[id];
      const same =
        prior &&
        prior.body === text &&
        prior.requestAi === requestAi &&
        (prior.replyTo ?? null) === (get().replyTo[id]?.id ?? null) &&
        JSON.stringify(prior.attachmentIds ?? []) === JSON.stringify(attachmentIds);
      const clientId = same ? prior.clientId : generateId();
      const pending: PendingSend = {
        clientId,
        body: text,
        requestAi,
        ...(get().replyTo[id]?.id ? { replyTo: get().replyTo[id]!.id } : {}),
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(mentions?.length ? { mentions } : {}),
      };
      set((state) => ({ pending: { ...state.pending, [id]: pending }, sending: true, error: null, notice: null }));
      try {
        const result = await channelsApi.post(id, pending);
        if (get().activeRoomId !== id) {
          set((state) => ({ sending: false, pending: { ...state.pending, [id]: null } }));
          return;
        }
        set((state) => {
          const messages = result.message ? mergeMessages(state.messages[id] ?? [], [result.message]) : state.messages[id] ?? [];
          const pendingAttachments = { ...state.pendingAttachments };
          delete pendingAttachments[composerKey];
          return {
            messages: { ...state.messages, [id]: messages },
            drafts: { ...state.drafts, [id]: "" },
            replyTo: { ...state.replyTo, [id]: null },
            aiArmed: { ...state.aiArmed, [id]: false },
            pending: { ...state.pending, [id]: null },
            pendingAttachments,
            sending: false,
          };
        });
        void get().refreshRoom();
      } catch (error) {
        if (get().activeRoomId === id) set({ sending: false, error: safeError(error, "channels.sendingFailed") });
        else set({ sending: false });
      }
    },

    attachFiles: async (composerKey, files) => {
      const id = get().activeRoomId;
      const room = get().room;
      if (!id || !room || !("capabilities" in room) || !room.capabilities.attach) return;
      const existing = get().pendingAttachments[composerKey] ?? [];
      let count = existing.length;
      const accepted: Array<{ localId: string; file: File }> = [];
      const rejected: PendingAttachment[] = [];
      for (const file of files) {
        if (count >= CHANNEL_LIMITS.attachmentsPerMessage) {
          rejected.push({ localId: generateId(), name: file.name, size: file.size, status: "failed", error: t("channels.attachmentTooMany") });
          continue;
        }
        if (file.size > CHANNEL_LIMITS.attachmentBytes) {
          rejected.push({ localId: generateId(), name: file.name, size: file.size, status: "failed", error: t("channels.attachmentTooLarge") });
          continue;
        }
        if (/\.svg$/i.test(file.name) || file.type === "image/svg+xml") {
          rejected.push({ localId: generateId(), name: file.name, size: file.size, status: "failed", error: t("channels.attachmentTypeBlocked") });
          continue;
        }
        count++;
        accepted.push({ localId: generateId(), file });
      }
      if (!accepted.length) {
        set((state) => ({ pendingAttachments: { ...state.pendingAttachments, [composerKey]: [...existing, ...rejected] } }));
        return;
      }
      const chips: PendingAttachment[] = accepted.map(({ localId, file }) => ({ localId, name: file.name, size: file.size, status: "uploading", file }));
      set((state) => ({
        pendingAttachments: { ...state.pendingAttachments, [composerKey]: [...existing, ...chips, ...rejected] },
        uploading: { ...state.uploading, [composerKey]: (state.uploading[composerKey] ?? 0) + accepted.length },
      }));
      await Promise.all(
        accepted.map(async ({ localId, file }) => {
          try {
            const { attachment } = await channelsApi.uploadAttachment(id, file);
            updateChip(composerKey, localId, { status: "ready", attachment });
          } catch (error) {
            updateChip(composerKey, localId, { status: "failed", error: channelError(error, "channels.attachmentFailed", { owner: room.ownerId === get().accountId }) });
          } finally {
            set((state) => ({ uploading: { ...state.uploading, [composerKey]: Math.max(0, (state.uploading[composerKey] ?? 1) - 1) } }));
          }
        }),
      );
    },

    removePendingAttachment: (composerKey, localId) => {
      const chip = (get().pendingAttachments[composerKey] ?? []).find((item) => item.localId === localId);
      const id = get().activeRoomId;
      if (chip?.status === "ready" && chip.attachment && id) void channelsApi.deleteAttachment(id, chip.attachment.id).catch(() => {});
      set((state) => ({
        pendingAttachments: { ...state.pendingAttachments, [composerKey]: (state.pendingAttachments[composerKey] ?? []).filter((item) => item.localId !== localId) },
      }));
    },

    clearPendingAttachments: (composerKey) => {
      const id = get().activeRoomId;
      for (const chip of get().pendingAttachments[composerKey] ?? []) {
        if (chip.status === "ready" && chip.attachment && id) void channelsApi.deleteAttachment(id, chip.attachment.id).catch(() => {});
      }
      set((state) => ({ pendingAttachments: { ...state.pendingAttachments, [composerKey]: [] } }));
    },

    openThread: async (rootId) => {
      if (!get().activeRoomId) return;
      set({ activeThreadId: rootId, threadStatus: "loading", threadFocusId: null });
      await get().loadThread(rootId);
    },

    closeThread: () => set({ activeThreadId: null, threadStatus: "idle", threadFocusId: null }),

    loadThread: async (rootId, beforeSeq) => {
      const id = get().activeRoomId;
      if (!id) return;
      const generation = get().generation;
      try {
        const page = await channelsApi.thread(id, rootId, beforeSeq === undefined ? {} : { beforeSeq });
        if (generation !== get().generation || get().activeRoomId !== id) return;
        set((state) => {
          const threads = { ...state.threads, [rootId]: mergeThread(state.threads[rootId], page) };
          // At most three open threads keep their replies; the least recently opened goes first.
          const keys = Object.keys(threads);
          if (keys.length > MAX_THREADS_IN_MEMORY) {
            const oldest = keys.filter((key) => key !== rootId).sort((a, b) => threads[a]!.openedAt - threads[b]!.openedAt)[0];
            if (oldest) delete threads[oldest];
          }
          const messages = mergeMessages(state.messages[id] ?? [], [page.root]);
          return {
            threads,
            threadStatus: state.activeThreadId === rootId ? "ready" : state.threadStatus,
            messages: { ...state.messages, [id]: messages },
          };
        });
      } catch (error) {
        if (generation === get().generation && get().activeRoomId === id) {
          set({ threadStatus: "error", error: safeError(error, "channels.notFound") });
        }
      }
    },

    sendToThread: async (rootId, { body, mentions, replyTo }) => {
      const id = get().activeRoomId;
      const room = get().room;
      if (!id || !room || !("capabilities" in room) || !room.capabilities.thread) return;
      const composerKey = `thread:${rootId}`;
      const chips = get().pendingAttachments[composerKey] ?? [];
      if (chips.some((chip) => chip.status === "uploading")) {
        set({ error: t("channels.attachmentUploading") });
        return;
      }
      const attachmentIds = chips.flatMap((chip) => (chip.status === "ready" && chip.attachment ? [chip.attachment.id] : []));
      const text = body.replace(/\r\n/g, "\n");
      if (!text.trim() && !attachmentIds.length) return;
      const prior = get().pending[composerKey];
      const same = prior && prior.body === text && prior.threadRootId === rootId && JSON.stringify(prior.attachmentIds ?? []) === JSON.stringify(attachmentIds);
      const clientId = same ? prior.clientId : generateId();
      const pending: PendingSend = {
        clientId,
        body: text,
        requestAi: false,
        threadRootId: rootId,
        ...(replyTo ? { replyTo } : {}),
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(mentions?.length ? { mentions } : {}),
      };
      set((state) => ({ pending: { ...state.pending, [composerKey]: pending }, sending: true, error: null }));
      try {
        const result = await channelsApi.post(id, pending);
        if (get().activeRoomId !== id) {
          set((state) => ({ sending: false, pending: { ...state.pending, [composerKey]: null } }));
          return;
        }
        set((state) => {
          const thread = state.threads[rootId];
          const threads = thread && result.message
            ? { ...state.threads, [rootId]: { ...thread, items: mergeMessages(thread.items, [result.message]), replyCount: thread.replyCount + 1 } }
            : state.threads;
          const pendingAttachments = { ...state.pendingAttachments };
          delete pendingAttachments[composerKey];
          return {
            threads,
            drafts: { ...state.drafts, [composerKey]: "" },
            pending: { ...state.pending, [composerKey]: null },
            pendingAttachments,
            sending: false,
          };
        });
        void get().refreshMessage(rootId);
      } catch (error) {
        if (get().activeRoomId === id) set({ sending: false, error: safeError(error, "channels.sendingFailed") });
        else set({ sending: false });
      }
    },

    markThreadRead: async (rootId, seq) => {
      const id = get().activeRoomId;
      const thread = get().threads[rootId];
      if (!id || !thread) return;
      const target = seq ?? newestSeq(thread.items);
      if (target <= thread.readSeq) return;
      try {
        const result = await channelsApi.threadRead(id, rootId, target);
        set((state) => {
          const current = state.threads[rootId];
          if (!current) return {};
          const messages = (state.messages[id] ?? []).map((message) =>
            message.id === rootId && message.thread ? { ...message, thread: { ...message.thread, unread: result.unread } } : message,
          );
          return {
            threads: { ...state.threads, [rootId]: { ...current, readSeq: result.readSeq } },
            messages: { ...state.messages, [id]: messages },
          };
        });
      } catch {
        // A cursor race is harmless: the next event or sync is authoritative.
      }
    },

    loadBlocks: async () => {
      try {
        const result = await channelsApi.blocks();
        set({ blocks: result.items });
      } catch {
        // The blocked list is optional context for the DM dialog.
      }
    },

    blockUser: async (userId) => {
      try {
        await channelsApi.block(userId);
        await get().loadBlocks();
        await get().loadSync();
      } catch (error) {
        set({ error: safeError(error, "channels.notFound") });
      }
    },

    unblockUser: async (userId) => {
      try {
        await channelsApi.unblockDm(userId);
        await get().loadBlocks();
      } catch (error) {
        set({ error: safeError(error, "channels.notFound") });
      }
    },

    createDm: async (userIds) => {
      try {
        const { channel } = await channelsApi.createDm({ clientId: generateId(), userIds });
        set((state) => ({ joined: [channel, ...state.joined.filter((room) => room.id !== channel.id)] }));
        await get().selectRoom(channel.id);
        return channel.id;
      } catch (error) {
        set({ error: safeError(error, "channels.dmUnavailable") });
        return null;
      }
    },

    addDmMembers: async (userIds) => {
      const id = get().activeRoomId;
      if (!id) return false;
      try {
        const { channel } = await channelsApi.addDmMembers(id, userIds);
        updateRoomSummary(channel);
        set((state) => ({ joined: state.joined.map((room) => (room.id === channel.id ? channel : room)) }));
        return true;
      } catch (error) {
        set({ error: safeError(error, "channels.dmUnavailable") });
        return false;
      }
    },

    lookupPeople: async (email) => {
      try {
        const result = await channelsApi.people(email);
        return result.items;
      } catch (error) {
        set({ error: safeError(error, "channels.dmUnavailable") });
        return [];
      }
    },

    setThreadFocus: (messageId) => set({ threadFocusId: messageId }),

    edit: async (messageId, body, mentions) => {
      const id = get().activeRoomId;
      if (!id) return false;
      const current = findMessage(get(), id, messageId);
      if (!current) return false;
      try {
        const { message } = await channelsApi.editMessage(id, messageId, { revision: current.revision, body: body.replace(/\r\n/g, "\n"), mentions });
        set((state) => ({
          messages: { ...state.messages, [id]: mergeMessages(state.messages[id] ?? [], [message]) },
          threads: mergeIntoThreads(state.threads, message),
          error: null,
        }));
        return true;
      } catch (error) {
        set({ error: safeError(error, "channels.invalidMessage") });
        return false;
      }
    },

    removeMessage: async (messageId) => {
      const id = get().activeRoomId;
      if (!id) return;
      const current = findMessage(get(), id, messageId);
      if (!current) return;
      try {
        await channelsApi.deleteMessage(id, messageId, current.revision);
        await get().refreshMessage(messageId);
      } catch (error) {
        set({ error: safeError(error, "channels.invalidMessage") });
      }
    },

    react: async (messageId, emoji, add) => {
      const id = get().activeRoomId;
      if (!id) return;
      try {
        const { message } = await channelsApi.react(id, messageId, emoji, add);
        set((state) => ({
          messages: { ...state.messages, [id]: mergeMessages(state.messages[id] ?? [], [message]) },
          threads: mergeIntoThreads(state.threads, message),
        }));
      } catch (error) {
        set({ error: safeError(error, "channels.notFound") });
      }
    },

    markRead: async (throughSeq) => {
      const id = get().activeRoomId;
      const room = get().room;
      if (!id || !room || !("membership" in room) || !room.membership) return;
      const seq = throughSeq ?? newestSeq(get().messages[id] ?? []);
      if (seq <= room.membership.readSeq) return;
      try {
        const result = await channelsApi.read(id, seq);
        set((state) => ({
          joined: state.joined.map((item) =>
            item.id === id && item.membership
              ? { ...item, membership: { ...item.membership, readSeq: result.readSeq }, unread: result.unread, mentionsUnread: result.mentionsUnread }
              : item,
          ),
          ...(state.room && "membership" in state.room && state.room.id === id && state.room.membership
            ? { room: { ...state.room, membership: { ...state.room.membership, readSeq: result.readSeq }, unread: result.unread, mentionsUnread: result.mentionsUnread } }
            : {}),
        }));
      } catch {
        // A cursor race is harmless: the next sync is authoritative.
      }
    },

    setNotify: async (mode) => {
      const id = get().activeRoomId;
      if (!id) return;
      try {
        await channelsApi.preferences(id, mode);
        set((state) => ({
          joined: state.joined.map((room) => (room.id === id && room.membership ? { ...room, membership: { ...room.membership, notifyMode: mode } } : room)),
          ...(state.room && "membership" in state.room && state.room.id === id && state.room.membership
            ? { room: { ...state.room, membership: { ...state.room.membership, notifyMode: mode } } }
            : {}),
        }));
      } catch (error) {
        set({ error: safeError(error, "channels.notFound") });
      }
    },

    join: async (id) => {
      const target = id ?? get().activeRoomId;
      if (!target) return;
      try {
        const { channel } = await channelsApi.join(target);
        set((state) => ({ joined: [...state.joined.filter((room) => room.id !== channel.id), channel], room: channel, roomStatus: "ready", discover: state.discover.filter((room) => room.id !== channel.id) }));
        await Promise.all([get().loadHistory(), get().loadMembers()]);
      } catch (error) {
        set({ error: safeError(error, "channels.notFound") });
      }
    },

    accept: async (id) => {
      try {
        const { channel } = await channelsApi.accept(id);
        set((state) => ({ joined: [...state.joined.filter((room) => room.id !== channel.id), channel], invites: state.invites.filter((invite) => invite.channelId !== id), room: channel, roomStatus: "ready" }));
        await get().loadHistory();
      } catch (error) {
        set({ error: safeError(error, "channels.notFound") });
      }
    },

    decline: async (id) => {
      try {
        await channelsApi.decline(id);
        set((state) => ({ invites: state.invites.filter((invite) => invite.channelId !== id) }));
      } catch (error) {
        set({ error: safeError(error, "channels.notFound") });
      }
    },

    leave: async () => {
      const id = get().activeRoomId;
      if (!id) return;
      try {
        await channelsApi.leave(id);
        clearRoomText(id);
        set((state) => ({ joined: state.joined.filter((room) => room.id !== id), activeRoomId: null, room: null, roomStatus: "idle" }));
      } catch (error) {
        set({ error: safeError(error, "channels.transferRequired") });
      }
    },

    create: async (input) => {
      try {
        const { channel } = await channelsApi.create({ ...input, clientId: generateId() });
        set((state) => ({ joined: [channel, ...state.joined.filter((room) => room.id !== channel.id)] }));
        await get().selectRoom(channel.id);
        return channel.id;
      } catch (error) {
        set({ error: safeError(error, "channels.invalidMessage") });
        return null;
      }
    },

    update: async (input) => {
      const id = get().activeRoomId;
      if (!id) return false;
      try {
        const { channel } = await channelsApi.update(id, input);
        updateRoomSummary(channel);
        set({ error: null });
        return true;
      } catch (error) {
        set({ error: safeError(error, "channels.revisionConflict") });
        return false;
      }
    },

    archive: async (archived) => {
      const id = get().activeRoomId;
      const room = get().room;
      if (!id || !room || !("revision" in room)) return;
      try {
        const { channel } = await channelsApi.archive(id, room.revision, archived);
        updateRoomSummary(channel);
      } catch (error) {
        set({ error: safeError(error, "channels.revisionConflict") });
      }
    },

    removeRoom: async (revision) => {
      const id = get().activeRoomId;
      if (!id) return;
      try {
        await channelsApi.remove(id, revision);
        clearRoomText(id);
        set((state) => ({ joined: state.joined.filter((room) => room.id !== id), activeRoomId: null, room: null, roomStatus: "idle" }));
      } catch (error) {
        set({ error: safeError(error, "channels.revisionConflict") });
      }
    },

    invite: async (userIds) => {
      const id = get().activeRoomId;
      if (!id) return [];
      try {
        const result = await channelsApi.invite(id, userIds);
        return result.added.map((userId) => ({ id: userId, name: "" }));
      } catch (error) {
        set({ error: safeError(error, "channels.inviteNoMatch") });
        return [];
      }
    },

    removeMember: async (userId) => {
      const id = get().activeRoomId;
      if (!id) return;
      try {
        await channelsApi.removeMember(id, userId);
        await get().loadMembers();
      } catch (error) {
        set({ error: safeError(error, "channels.notFound") });
      }
    },

    unblock: async (userId) => {
      const id = get().activeRoomId;
      if (!id) return;
      try {
        await channelsApi.unblock(id, userId);
      } catch (error) {
        set({ error: safeError(error, "channels.notFound") });
      }
    },

    setRole: async (userId, role) => {
      const id = get().activeRoomId;
      const room = get().room;
      if (!id || !room || !("revision" in room)) return;
      try {
        await channelsApi.setRole(id, userId, room.revision, role);
        await get().refreshRoom();
        await get().loadMembers();
      } catch (error) {
        set({ error: safeError(error, "channels.revisionConflict") });
      }
    },

    transfer: async (userId) => {
      const id = get().activeRoomId;
      const room = get().room;
      if (!id || !room || !("revision" in room)) return;
      try {
        const { channel } = await channelsApi.transfer(id, room.revision, userId);
        updateRoomSummary(channel);
        await get().loadMembers();
      } catch (error) {
        set({ error: safeError(error, "channels.storageTransfer") });
      }
    },

    cancelAi: async (runId) => {
      const id = get().activeRoomId;
      if (!id) return;
      try {
        await channelsApi.cancelAi(id, runId);
        await get().loadHistory();
      } catch (error) {
        set({ error: safeError(error, "channels.aiFailed") });
      }
    },
  };
});

export const channelUnreadTotal = () => unreadOf(useChannels.getState().joined);
export const channelMentionsTotal = () => useChannels.getState().joined.reduce((sum, room) => sum + (room.membership ? room.mentionsUnread : 0), 0);

export const channelMessageBySeq = (roomId: string, seq: number) => (useChannels.getState().messages[roomId] ?? []).find((message) => message.seq === seq);

export { sortMessages, mergeMessage, capMessages };
