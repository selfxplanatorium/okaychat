import type { ChannelMessage, ChannelSummary, ChannelThreadPage, ChannelThreadSummary } from "@shared/channels";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

/** Pure channel list and timeline helpers, tested without React or the network. */

export const MAX_CACHED_MESSAGES = 300;
export const MAX_ROOMS_IN_MEMORY = 5;
export const MAX_THREADS_IN_MEMORY = 3;
export const MAX_THREAD_MESSAGES = 200;

export interface ChannelThreadState {
  root: ChannelMessage | null;
  items: ChannelMessage[];
  nextBeforeSeq: number | null;
  hasMore: boolean;
  readSeq: number;
  replyCount: number;
  /** Least-recently-opened eviction order; never rendered. */
  openedAt: number;
}

export const roomsOf = (items: ChannelSummary[]): ChannelSummary[] => items.filter((room) => room.kind === "room");
export const dmsOf = (items: ChannelSummary[]): ChannelSummary[] => items.filter((room) => room.kind === "dm");

/** The other accounts in a DM, never the viewer. A gone member leaves a readable fallback. */
export function dmTitle(room: Pick<ChannelSummary, "dmMembers">, meId: string | null): string {
  const others = (room.dmMembers ?? []).filter((member) => member.id !== meId);
  if (!others.length) return t("channels.deletedAccount");
  if (others.length === 1) return others[0]!.name;
  return t("channels.dmTitle", { names: formatList(others.map((member) => member.name), { type: "conjunction", style: "short" }) });
}

export function threadLabel(thread: ChannelThreadSummary | null): "none" | "unread" | "replies" {
  if (!thread || thread.replyCount === 0) return "none";
  return thread.unread > 0 ? "unread" : "replies";
}

/** Applies a page without dropping replies already loaded, and never moves a read cursor back. */
export function mergeThread(current: ChannelThreadState | undefined, page: ChannelThreadPage): ChannelThreadState {
  const items = capMessages(mergeMessages(current?.items ?? [], page.items), MAX_THREAD_MESSAGES);
  return {
    root: page.root,
    items,
    nextBeforeSeq: page.nextBeforeSeq,
    hasMore: page.hasMore,
    readSeq: Math.max(current?.readSeq ?? 0, page.readSeq),
    replyCount: page.replyCount,
    openedAt: current?.openedAt ?? Date.now(),
  };
}

export function sortMessages(items: ChannelMessage[]): ChannelMessage[] {
  return [...items].sort((a, b) => a.seq - b.seq);
}

/** Applies a newer projection only when it is at least as new; deleted text can never be resurrected. */
export function mergeMessage(current: ChannelMessage | undefined, incoming: ChannelMessage): ChannelMessage {
  if (!current) return incoming;
  if (incoming.revision < current.revision) return current;
  if (incoming.deletedAt !== null && current.deletedAt !== null && incoming.revision === current.revision) return current;
  return incoming;
}

export function mergeMessages(current: ChannelMessage[], incoming: ChannelMessage[]): ChannelMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, mergeMessage(byId.get(message.id), message));
  return capMessages(sortMessages([...byId.values()]));
}

export function capMessages(items: ChannelMessage[], max = MAX_CACHED_MESSAGES): ChannelMessage[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

export function newestSeq(items: ChannelMessage[]): number {
  return items.reduce((max, message) => Math.max(max, message.seq), 0);
}

/** Total unread across joined rooms, capped by the caller for display. */
export function totalUnread(rooms: ChannelSummary[]): number {
  return rooms.reduce((sum, room) => sum + (room.membership ? room.unread : 0), 0);
}

export function totalMentions(rooms: ChannelSummary[]): number {
  return rooms.reduce((sum, room) => sum + (room.membership ? room.mentionsUnread : 0), 0);
}

export function nextUnreadRoom(rooms: ChannelSummary[], currentId: string | null): ChannelSummary | null {
  const joined = rooms.filter((room) => room.membership && !room.membership.readSeq && room.unread > 0);
  if (!joined.length) return null;
  const index = joined.findIndex((room) => room.id === currentId);
  return joined[(index + 1) % joined.length] ?? null;
}

export function nextUnreadAfter(rooms: ChannelSummary[], currentId: string | null): ChannelSummary | null {
  const unread = rooms.filter((room) => room.membership && room.unread > 0);
  if (!unread.length) return null;
  const index = unread.findIndex((room) => room.id === currentId);
  return unread[(index + 1) % unread.length] ?? null;
}

/** Drops an unavailable room and its cached text after a sync/revocation. */
export function reconcileRooms(rooms: ChannelSummary[], available: ChannelSummary[]): ChannelSummary[] {
  const byId = new Map(available.map((room) => [room.id, room]));
  return rooms.flatMap((room) => {
    const next = byId.get(room.id);
    return next ? [next] : [];
  });
}

export function formatUnreadBadge(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function excerpt(text: string, max = 160): string {
  const plain = text.replace(/\s+/gu, " ").trim();
  return [...plain].slice(0, max).join("");
}

export function isArchived(room: Pick<ChannelSummary, "archivedAt">): boolean {
  return room.archivedAt !== null;
}
