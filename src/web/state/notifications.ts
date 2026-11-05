import { create } from "zustand";
import { interpolate, t, template, type MessageKey } from "@/i18n";
import { api } from "@/lib/api";
import type {
  AppNotification,
  NotificationBodyKey,
  NotificationTitleKey,
} from "@shared/notifications";
import { useData } from "./data";

/**
 * Durable notices for the signed-in account. The server writes them, so a scheduled run or archive job
 * that finished with no tab open is still here on the next visit. System notifications are opt-in,
 * need permission, and are only shown for notices created while this page has been open.
 */

export const NOTIFIED_LIMIT = 200;
const NOTIFIED_PREFIX = "okaychat:notified:";
const PAGE = 30;
const POLL_MS = 60_000;
const FRESH_MS = 5 * 60_000;
// Notices older than this at page load are not news: showing them would re-announce the whole backlog.
const sessionStartedAt = Date.now();

export const NOTIFICATION_TITLE_MESSAGES: Record<NotificationTitleKey, MessageKey> = {
  "schedule.ok": "notifications.scheduleOk",
  "schedule.error": "notifications.scheduleError",
  "schedule.skipped": "notifications.scheduleSkipped",
  "export.ready": "notifications.exportReady",
  "export.failed": "notifications.exportFailed",
  "import.done": "notifications.importDone",
  "import.failed": "notifications.importFailed",
  "channel.invited": "notifications.channelInvited",
  "channel.mention": "notifications.channelMention",
  "channel.message": "notifications.channelMessage",
  "channel.aiFinished": "notifications.channelAiFinished",
  "calendar.reminder": "notifications.calendarReminder",
};

export const NOTIFICATION_BODY_MESSAGES: Record<NotificationBodyKey, MessageKey> = {
  "schedule.okBody": "notifications.scheduleOkBody",
  "schedule.errorBody": "notifications.scheduleErrorBody",
  "schedule.skippedBody": "notifications.scheduleSkippedBody",
  "export.readyBody": "notifications.exportReadyBody",
  "export.failedBody": "notifications.exportFailedBody",
  "import.doneBody": "notifications.importDoneBody",
  "import.failedBody": "notifications.importFailedBody",
  "channel.openRoom": "notifications.channelOpenRoom",
  "channel.openMessage": "notifications.channelOpenMessage",
  "calendar.openEvent": "notifications.calendarOpenEvent",
};

const text = (key: MessageKey, params: Record<string, string | number>): string =>
  interpolate(template(key), { ...params, thread: params.thread || t("notifications.unknownChat") });

export const notificationTitle = (item: AppNotification): string => text(NOTIFICATION_TITLE_MESSAGES[item.titleKey], item.params);
export const notificationBody = (item: AppNotification): string | null =>
  item.bodyKey ? text(NOTIFICATION_BODY_MESSAGES[item.bodyKey], item.params) : null;

/** Ids already announced to this account, oldest first, bounded. */
export function readNotifiedIds(accountId: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${NOTIFIED_PREFIX}${accountId}`) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(-NOTIFIED_LIMIT) : [];
  } catch {
    return [];
  }
}

export function rememberNotifiedIds(accountId: string, ids: readonly string[]): void {
  if (!ids.length) return;
  const next = [...readNotifiedIds(accountId).filter((id) => !ids.includes(id)), ...ids].slice(-NOTIFIED_LIMIT);
  try {
    localStorage.setItem(`${NOTIFIED_PREFIX}${accountId}`, JSON.stringify(next));
  } catch {
    // Storage may be off; the in-app badge still works.
  }
}

/** Notices created while this page was open and not announced before. */
export function unseenNotices(items: readonly AppNotification[], notified: ReadonlySet<string>, since: number): AppNotification[] {
  return items.filter((item) => item.createdAt >= since && !notified.has(item.id));
}

type Navigator = (path: string) => void;
let navigateTo: Navigator | null = null;
export const setNotificationNavigator = (fn: Navigator | null): void => {
  navigateTo = fn;
};

interface NotificationsState {
  accountId: string | null;
  items: AppNotification[];
  unread: number;
  loaded: boolean;
  error: boolean;
  cursor: string | null;
  busyId: string | null;
  centerOpen: boolean;
  start: (accountId: string) => void;
  stop: () => void;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markUnread: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  clearRead: () => Promise<void>;
  open: (item: AppNotification) => void;
  openCenter: () => void;
  closeCenter: () => void;
}

let generation = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;
let listenersOn = false;

const dropListeners = () => {
  if (!listenersOn || typeof window === "undefined") return;
  window.removeEventListener("online", onWake);
  document.removeEventListener("visibilitychange", onVisibility);
  listenersOn = false;
};

function onWake() {
  void useNotifications.getState().refresh();
}

function onVisibility() {
  if (document.visibilityState === "visible") void useNotifications.getState().refresh();
}

function showSystem(items: AppNotification[], accountId: string): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  const settings = useData.getState().settings?.notifications;
  if (!settings?.browser || Notification.permission !== "granted") return;
  const notified = new Set(readNotifiedIds(accountId));
  const fresh = unseenNotices(items, notified, sessionStartedAt - FRESH_MS).filter(
    (item) => item.level !== "success" || item.kind !== "schedule" || settings.scheduleSuccess,
  );
  if (!fresh.length) return;
  // Marked before showing, so a failing provider cannot make the next poll announce them again.
  rememberNotifiedIds(accountId, fresh.map((item) => item.id));
  const newest = fresh[0]!;
  const title = fresh.length === 1 ? notificationTitle(newest) : t("notifications.newCount", { count: fresh.length });
  const body = fresh.length === 1 ? (notificationBody(newest) ?? undefined) : notificationTitle(newest);
  const options: NotificationOptions = { body, tag: newest.id, icon: "/icon-192.png", data: { url: newest.actionPath ?? "/" } };
  const show = (registration: ServiceWorkerRegistration | undefined) => {
    if (registration) {
      void registration.showNotification(title, options);
      return;
    }
    const notice = new Notification(title, options);
    notice.onclick = () => {
      window.focus();
      useNotifications.getState().open(newest);
    };
  };
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.getRegistration().then(show, () => show(undefined));
  } else show(undefined);
}

export const useNotifications = create<NotificationsState>((set, get) => {
  const apply = (result: { items: AppNotification[]; unread: number; nextCursor: string | null }, append: boolean) => {
    set((state) => ({
      items: append ? [...state.items, ...result.items] : result.items,
      unread: result.unread,
      cursor: result.nextCursor,
      loaded: true,
      error: false,
    }));
  };

  const refresh = async (): Promise<void> => {
    const accountId = get().accountId;
    if (!accountId) return;
    if (inflight) return inflight;
    const token = generation;
    let run: Promise<void>;
    run = api<{ items: AppNotification[]; unread: number; nextCursor: string | null }>(`/notifications?limit=${PAGE}`)
      .then((result) => {
        if (token !== generation) return;
        apply(result, false);
        showSystem(result.items, accountId);
      })
      .catch(() => {
        if (token === generation) set({ error: true, loaded: true });
      })
      .finally(() => {
        if (inflight === run) inflight = null;
      });
    inflight = run;
    return run;
  };

  const mutate = async (id: string, task: () => Promise<{ unread: number }>, change: (item: AppNotification) => AppNotification | null) => {
    set({ busyId: id });
    try {
      const result = await task();
      set((state) => ({
        unread: result.unread,
        busyId: null,
        items: state.items.flatMap((item) => {
          if (item.id !== id) return [item];
          const next = change(item);
          return next ? [next] : [];
        }),
      }));
    } catch {
      set({ busyId: null, error: true });
    }
  };

  return {
    accountId: null,
    items: [],
    unread: 0,
    loaded: false,
    error: false,
    cursor: null,
    busyId: null,
    centerOpen: false,
    start(accountId) {
      if (get().accountId === accountId) return;
      generation++;
      get().stop();
      set({ accountId, items: [], unread: 0, loaded: false, error: false, cursor: null, busyId: null });
      void get().refresh();
      timer = setInterval(() => void get().refresh(), POLL_MS);
      if (typeof window !== "undefined" && !listenersOn) {
        window.addEventListener("online", onWake);
        document.addEventListener("visibilitychange", onVisibility);
        listenersOn = true;
      }
    },
    stop() {
      generation++;
      if (timer) clearInterval(timer);
      timer = null;
      inflight = null;
      dropListeners();
      set({ accountId: null, items: [], unread: 0, loaded: false, error: false, cursor: null, busyId: null, centerOpen: false });
    },
    refresh,
    async loadMore() {
      const { cursor, accountId } = get();
      if (!cursor || !accountId) return;
      const token = generation;
      try {
        const result = await api<{ items: AppNotification[]; unread: number; nextCursor: string | null }>(
          `/notifications?limit=${PAGE}&before=${encodeURIComponent(cursor)}`,
        );
        if (token === generation) apply(result, true);
      } catch {
        if (token === generation) set({ error: true });
      }
    },
    markRead: (id) =>
      mutate(id, () => api<{ unread: number }>(`/notifications/${id}/read`, { method: "POST" }), (item) => ({ ...item, readAt: item.readAt ?? Date.now() })),
    markUnread: (id) =>
      mutate(id, () => api<{ unread: number }>(`/notifications/${id}/unread`, { method: "POST" }), (item) => ({ ...item, readAt: null })),
    markAllRead: async () => {
      const token = generation;
      try {
        const result = await api<{ unread: number }>("/notifications/read-all", { method: "POST" });
        if (token === generation) set((state) => ({ unread: result.unread, items: state.items.map((item) => ({ ...item, readAt: item.readAt ?? Date.now() })) }));
      } catch {
        set({ error: true });
      }
    },
    dismiss: (id) => mutate(id, () => api<{ unread: number }>(`/notifications/${id}`, { method: "DELETE" }), () => null),
    clearRead: async () => {
      const token = generation;
      try {
        const result = await api<{ unread: number }>("/notifications/read", { method: "DELETE" });
        if (token === generation) set((state) => ({ unread: result.unread, items: state.items.filter((item) => item.readAt === null) }));
      } catch {
        set({ error: true });
      }
    },
    open(item) {
      if (!item.readAt) void get().markRead(item.id);
      set({ centerOpen: false });
      navigateTo?.(item.actionPath ?? "/");
    },
    openCenter: () => set({ centerOpen: true }),
    closeCenter: () => set({ centerOpen: false }),
  };
});

export const openNotificationCenter = () => useNotifications.getState().openCenter();
export const resetNotifications = () => useNotifications.getState().stop();
