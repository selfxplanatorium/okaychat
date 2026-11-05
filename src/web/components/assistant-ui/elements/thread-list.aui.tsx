"use client";

import { BranchIcon } from "@/components/chat/branch-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AuiIf,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileDownIcon,
  FileTextIcon,
  FolderInputIcon,
  ListChecksIcon,
  Loader2Icon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  ShareIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  SparklesIcon,
  TagIcon,
  TextCursorIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type FC,
  type ReactElement,
  type RefObject,
} from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { isTemporaryChat, useChatPrivacyStore } from "@/state/chat-privacy";
import { chatPath, getActiveModel, useData } from "@/state/data";
import { api } from "@/lib/api";
import { exportThread } from "@/lib/thread-export";
import type { ThreadCustom } from "@/runtime/RuntimeProvider";
import { SharePanel } from "@/components/share/ShareButton";
import { DeleteChatDialog } from "@/components/chat/DeleteChatDialog";
import { useServiceDown } from "@/components/chat/ServiceNotice";
import { ServiceAvailability } from "@/components/ServiceAvailability";
import { markUsedServices } from "@/state/services";
import { SelectionCheck, useSelectionKeys } from "@/components/ui/selection";
import { runBatch } from "@/lib/selection";
import { t, type PlainMessageKey } from "@/i18n";
import { useThreadSelection } from "@/state/thread-selection";
import { runCommand, useCommand } from "@/keyboard/registry";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ContextMenu } from "@base-ui/react/context-menu";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSubmenuRoot,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "@/components/ui/menu";
import { matchesTagFilter } from "@shared/tags";
import { useTagFilter } from "@/state/tag-filter";
import { TagEditorDialog } from "@/components/tags/TagEditorDialog";

type BatchVerb = "pin" | "unpin" | "move" | "archive" | "delete" | "tags";

const withReason = (message: string, error: unknown) =>
  error instanceof Error && error.message ? t("sidebar.withReason", { message, reason: error.message }) : message;

/** One line for a bulk action that partly or fully failed. */
function batchFailure(verb: BatchVerb, failed: number, total: number) {
  const p = { failed, total };
  const all = failed === total;
  switch (verb) {
    case "pin": return all ? t("sidebar.pinFailedAll") : t("sidebar.pinFailedSome", p);
    case "unpin": return all ? t("sidebar.unpinFailedAll") : t("sidebar.unpinFailedSome", p);
    case "move": return all ? t("sidebar.moveFailedAll") : t("sidebar.moveFailedSome", p);
    case "archive": return all ? t("sidebar.archiveFailedAll") : t("sidebar.archiveFailedSome", p);
    case "delete": return all ? t("sidebar.deleteFailedAll") : t("sidebar.deleteFailedSome", p);
    case "tags": return t("tags.tagSaveFailed");
  }
}

// One document listener for every row's quick action, which swaps pin for delete while Shift is held.
let shiftHeld = false;
const shiftListeners = new Set<() => void>();
const setShift = (held: boolean) => {
  if (held === shiftHeld) return;
  shiftHeld = held;
  shiftListeners.forEach((listener) => listener());
};
const onShiftKey = (event: KeyboardEvent) => setShift(event.shiftKey);
const onShiftBlur = () => setShift(false);
const subscribeShift = (listener: () => void) => {
  if (shiftListeners.size === 0) {
    window.addEventListener("keydown", onShiftKey);
    window.addEventListener("keyup", onShiftKey);
    window.addEventListener("blur", onShiftBlur);
  }
  shiftListeners.add(listener);
  return () => {
    shiftListeners.delete(listener);
    if (shiftListeners.size > 0) return;
    window.removeEventListener("keydown", onShiftKey);
    window.removeEventListener("keyup", onShiftKey);
    window.removeEventListener("blur", onShiftBlur);
  };
};
const useShiftHeld = () => useSyncExternalStore(subscribeShift, () => shiftHeld, () => false);

export const ThreadList: FC = () => (
  <ThreadListRoot>
    <ThreadListItems />
  </ThreadListRoot>
);

export const ThreadListSearch = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<typeof Input>, "value" | "onChange"> & {
    value: string;
    onValueChange: (value: string) => void;
  }
>(({ className, value, onValueChange, ...props }, ref) => {
  return (
    <div data-slot="aui_thread-list-search" className="relative px-0.5 py-1">
      <SearchIcon
        data-slot="aui_thread-list-search-icon"
        className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
      />
      <Input
        ref={ref}
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        aria-label={t("sidebar.searchChats")}
        placeholder={t("sidebar.searchChats")}
        className={cn("h-8 ps-8 text-sm", className)}
        {...props}
      />
    </div>
  );
});

ThreadListSearch.displayName = "ThreadListSearch";

export const ThreadListRoot: FC<
  ComponentPropsWithoutRef<typeof ThreadListPrimitive.Root>
> = ({ className, ...props }) => {
  return (
    <ThreadListPrimitive.Root
      data-slot="aui_thread-list-root"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    />
  );
};

export const ThreadListItems: FC<
  ComponentPropsWithoutRef<"div"> & { searchQuery?: string }
> = ({ className, searchQuery = "", ...props }) => {
  const isLoading = useAuiState((s) => s.threads.isLoading);
  return (
    <div
      data-slot="aui_thread-list-items"
      className={cn(
        // A reload (another project, an archive) fades the list instead of swapping it.
        "flex flex-col gap-0.5 transition-opacity duration-(--motion-fast) ease-out-quart",
        isLoading && "opacity-50",
        className,
      )}
      {...props}
    >
      <AuiIf condition={(s) => s.threads.isLoading}>
        <ThreadListSkeleton />
      </AuiIf>
      <AuiIf condition={(s) => !s.threads.isLoading}>
        <ThreadListItemGroups searchQuery={searchQuery} />
      </AuiIf>
    </div>
  );
};

type GroupLabel = Extract<PlainMessageKey, `sidebar.group${string}`>;

const dateGroupLabel = (
  date: Date | undefined,
  startOfToday: number,
  startOfYesterday: number,
  startOfLastWeek: number,
): GroupLabel => {
  if (!date || date.getTime() >= startOfToday) return "sidebar.groupToday";
  if (date.getTime() >= startOfYesterday) return "sidebar.groupYesterday";
  if (date.getTime() >= startOfLastWeek) return "sidebar.groupLast7Days";
  return "sidebar.groupOlder";
};

const startOfLocalDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

const subscribeToNextDay = (onDayChange: () => void) => {
  let timeout: number;
  const scheduleNextDay = () => {
    const now = new Date();
    const startOfTomorrow = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
    ).getTime();
    timeout = window.setTimeout(() => {
      onDayChange();
      scheduleNextDay();
    }, startOfTomorrow - now.getTime());
  };
  scheduleNextDay();
  return () => window.clearTimeout(timeout);
};

const getStartOfToday = () => startOfLocalDay(new Date());

// A server render and hydration see no day start, so a prerender never reads
// the clock; a client-only mount groups on its first render.
const getServerStartOfToday = () => undefined;

const useStartOfToday = () =>
  useSyncExternalStore<number | undefined>(
    subscribeToNextDay,
    getStartOfToday,
    getServerStartOfToday,
  );

export type ThreadListGroup = { label: GroupLabel; indices: number[] };

/**
 * Filters the thread list by title and buckets the matches: pinned chats
 * first, then by last activity (Today, Yesterday, Last 7 Days, Older). `groups` is null
 * when no thread carries a date or while the local day start is unknown
 * during server render and hydration, in which case `filteredIndices` keeps
 * the runtime order. With a project filter, chats moved out of that project
 * drop out until the next reload would omit them anyway.
 */
export const useThreadListGroups = (searchQuery = "") => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const activeProject = useData((s) => s.activeProject);
  const selectedTags = useTagFilter((s) => s.filter.tags);
  const tagMatch = useTagFilter((s) => s.filter.match);

  const query = searchQuery.trim().toLowerCase();
  const startOfToday = useStartOfToday();

  return useMemo(() => {
    const itemsById = new Map(threadItems.map((item) => [item.id, item]));
    const dates = threadIds.map((id) => itemsById.get(id)?.lastMessageAt);
    const custom = (id: string) =>
      itemsById.get(id)?.custom as Partial<ThreadCustom> | undefined;
    const filteredIndices = threadIds
      .map((id, index) => ({ id, index }))
      .filter(({ id }) => {
        const projectId = custom(id)?.projectId;
        const tags = custom(id)?.tags ?? [];
        return (
          !isTemporaryChat(itemsById.get(id)?.remoteId) &&
          // A chat created here has no custom metadata yet and belongs to this project.
          (!activeProject || projectId === undefined || projectId === activeProject) &&
          matchesTagFilter(tags, { tags: selectedTags, match: tagMatch }) &&
          (!query ||
            (itemsById.get(id)?.title || t("common.newChat")).toLowerCase().includes(query))
        );
      })
      .map(({ index }) => index);
    const pinned = filteredIndices.filter((index) => custom(threadIds[index]!)?.pinned);
    const pinnedSet = new Set(pinned);
    if (
      startOfToday === undefined ||
      !filteredIndices.some((index) => dates[index])
    ) {
      return { threadIds, filteredIndices, groups: null };
    }

    const lastWeek = new Date(startOfToday);
    lastWeek.setDate(lastWeek.getDate() - 7);
    const startOfLastWeek = lastWeek.getTime();
    const yesterday = new Date(startOfToday);
    yesterday.setDate(yesterday.getDate() - 1);
    const startOfYesterday = yesterday.getTime();
    const time = (index: number) =>
      dates[index]?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const sorted = filteredIndices
      .filter((index) => !pinnedSet.has(index))
      .sort((a, b) => time(b) - time(a));

    const result: ThreadListGroup[] = pinned.length
      ? [{ label: "sidebar.groupPinned", indices: [...pinned].sort((a, b) => time(b) - time(a)) }]
      : [];
    for (const index of sorted) {
      const label = dateGroupLabel(
        dates[index],
        startOfToday,
        startOfYesterday,
        startOfLastWeek,
      );
      const lastGroup = result[result.length - 1];
      if (lastGroup?.label === label) {
        lastGroup.indices.push(index);
      } else {
        result.push({ label, indices: [index] });
      }
    }
    return { threadIds, filteredIndices, groups: result };
  }, [threadIds, threadItems, activeProject, query, startOfToday, selectedTags, tagMatch]);
};

/**
 * Rows rise in with a short stagger when they mount; the delay is capped so long lists start fast.
 * The class is dropped once it has played, because moving the node (pinning) would restart it.
 */
const ThreadListItemRow: FC<{ index: number; flipKey: string }> = ({ index, flipKey }) => {
  const [entering, setEntering] = useState(true);
  return (
    <div
      data-flip={flipKey}
      className={cn("stagger", entering && "animate-rise-in")}
      style={{ "--i": Math.min(index, 7) } as CSSProperties}
      onAnimationEnd={(event) => event.target === event.currentTarget && setEntering(false)}
    >
      <ThreadListPrimitive.ItemByIndex
        index={index}
        components={{ ThreadListItem }}
      />
    </div>
  );
};

const ThreadListGroupLabel: FC<{ label: GroupLabel }> = ({ label }) => {
  const [entering, setEntering] = useState(true);
  return (
    <div
      data-flip={`group:${label}`}
      data-slot="aui_thread-list-group-label"
      className={cn("text-muted-foreground px-2.5 pt-3 pb-1 text-xs font-medium", entering && "animate-fade-in")}
      onAnimationEnd={(event) => event.target === event.currentTarget && setEntering(false)}
    >
      {t(label)}
    </div>
  );
};

type ListEntry = { key: string; index: number; label?: never } | { key: string; label: GroupLabel; index?: never };

/** Keep the current and last-interacted chat mounted for shortcuts, menus, dialogs, and focus. */
const VirtualThreadList: FC<{ entries: ListEntry[] }> = ({ entries }) => {
  const host = useRef<HTMLDivElement>(null);
  const activeId = useAuiState((s) => s.threads.mainThreadId);
  const [heldKey, setHeldKey] = useState<string | null>(null);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const positions = useMemo(() => new Map(entries.map((entry, index) => [entry.key, index])), [entries]);
  const activeIndex = positions.get(activeId);
  const heldIndex = heldKey === null ? undefined : positions.get(heldKey);
  const focusIndex = pendingFocus === null ? undefined : positions.get(pendingFocus);
  const getItemKey = useCallback((index: number) => entries[index]!.key, [entries]);
  const estimateSize = useCallback(() => window.matchMedia("(pointer: coarse)").matches ? 44 : 32, []);
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indices = new Set(defaultRangeExtractor(range));
    for (const index of [activeIndex, heldIndex, focusIndex]) if (index !== undefined) indices.add(index);
    return [...indices].sort((a, b) => a - b);
  }, [activeIndex, heldIndex, focusIndex]);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => host.current?.closest<HTMLElement>("#sidebar-chats") ?? null,
    getItemKey,
    estimateSize,
    gap: 2,
    overscan: 32,
    rangeExtractor,
  });

  useLayoutEffect(() => {
    if (pendingFocus === null) return;
    const index = positions.get(pendingFocus);
    if (index !== undefined) {
      host.current?.querySelector<HTMLElement>(`[data-virtual-index="${index}"] [data-slot=aui_thread-list-item-trigger], [data-virtual-index="${index}"] [data-slot=aui_thread-list-item-select]`)?.focus();
    }
    setPendingFocus(null);
  }, [pendingFocus, positions]);

  const hold = (target: EventTarget) => {
    const index = (target as HTMLElement).closest<HTMLElement>("[data-virtual-index]")?.dataset.virtualIndex;
    if (index !== undefined) setHeldKey(entries[Number(index)]!.key);
  };

  const items = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();

  return (
    <div
      ref={host}
      className="thread-list-virtual relative"
      style={{ height: totalHeight, overflowAnchor: "none" }}
      onFocusCapture={(event) => hold(event.target)}
      onPointerDownCapture={(event) => hold(event.target)}
      onKeyDownCapture={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (!(event.target as HTMLElement).matches("[data-slot=aui_thread-list-item-trigger], [data-slot=aui_thread-list-item-select]")) return;
        const index = Number((event.target as HTMLElement).closest<HTMLElement>("[data-virtual-index]")?.dataset.virtualIndex);
        const step = event.key === "ArrowUp" || event.key === "End" ? -1 : 1;
        let next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1
          : event.key === "ArrowDown" || event.key === "ArrowUp" ? index + step : -1;
        if (!["Home", "End", "ArrowDown", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        while (next >= 0 && next < entries.length && entries[next]!.label !== undefined) next += step;
        if (next < 0 || next >= entries.length) return;
        virtualizer.scrollToIndex(next, { align: "auto" });
        setPendingFocus(entries[next]!.key);
      }}
    >
      {items.map((item) => {
        const entry = entries[item.index]!;
        return (
          <div
            key={entry.key}
            data-index={item.index}
            data-virtual-index={item.index}
            ref={virtualizer.measureElement}
            className="thread-list-virtual-row absolute start-0 w-full"
            // Virtual rows are positioned with layout `top`, not transforms.
            style={{ top: item.start }}
          >
            {entry.label !== undefined ? <ThreadListGroupLabel label={entry.label} /> : (
              <ThreadListPrimitive.ItemByIndex index={entry.index} components={{ ThreadListItem }} />
            )}
          </div>
        );
      })}
    </div>
  );
};

/**
 * Slides rows and labels whose layout position changed since the last render from their old
 * place to the new one; anything that stayed put is left alone.
 */
const useFlip = (scope: RefObject<HTMLElement | null>, deps: unknown[]) => {
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const host = scope.current;
    if (!host) return;
    const next = new Map<string, number>();
    for (const element of host.querySelectorAll<HTMLElement>(":scope > [data-flip]")) {
      const key = element.dataset.flip!;
      const top = element.offsetTop;
      next.set(key, top);
      const before = positions.current.get(key);
      if (before === undefined || before === top) continue;
      element.style.transition = "none";
      element.style.transform = `translateY(${before - top}px)`;
      void element.offsetHeight;
      element.style.transition = "transform var(--motion-slow) var(--ease-out-expo)";
      element.style.transform = "";
      element.addEventListener(
        "transitionend",
        (event) => event.target === element && (element.style.transition = ""),
        { once: true },
      );
    }
    positions.current = next;
  }, deps);
};

const ThreadListItemGroups: FC<{ searchQuery?: string }> = ({
  searchQuery = "",
}) => {
  const { threadIds, filteredIndices, groups } =
    useThreadListGroups(searchQuery);
  const query = searchQuery.trim();
  const filteringTags = useTagFilter((s) => s.filter.tags.length > 0);
  const scope = useRef<HTMLDivElement>(null);
  useFlip(scope, [groups, filteredIndices]);

  // Selection follows what is on screen: Shift ranges and Select all use this order.
  const order = useMemo(
    () => (groups ? groups.flatMap((g) => g.indices) : filteredIndices).map((index) => threadIds[index]!),
    [groups, filteredIndices, threadIds],
  );
  useEffect(() => useThreadSelection.getState().setOrder(order), [order]);

  const entries = useMemo<ListEntry[]>(() => groups
    ? groups.flatMap((group) => [
      { key: `group:${group.label}`, label: group.label },
      ...group.indices.map((index) => ({ key: threadIds[index]!, index })),
    ])
    : filteredIndices.map((index) => ({ key: threadIds[index]!, index })), [groups, filteredIndices, threadIds]);

  // Message matches render below, so an empty title match is not a dead end.
  if ((query || filteringTags) && filteredIndices.length === 0) {
    return (
      <div
        data-slot="aui_thread-list-empty"
        className="text-muted-foreground animate-fade-in px-2.5 py-2 text-sm"
      >
        {query ? t("sidebar.noTitlesMatch") : t("tags.noTaggedChats")}
      </div>
    );
  }

  if (entries.length > 300) return <VirtualThreadList entries={entries} />;

  // Small lists keep their layout animations; large lists mount only a viewport of rows.
  return (
    <div ref={scope} className="contents">
      {groups
        ? groups.flatMap((group) => [
            <ThreadListGroupLabel key={`group:${group.label}`} label={group.label} />,
            ...group.indices.map((index) => (
              <ThreadListItemRow key={threadIds[index]} flipKey={threadIds[index]!} index={index} />
            )),
          ])
        : filteredIndices.map((index) => (
            <ThreadListItemRow key={threadIds[index]} flipKey={threadIds[index]!} index={index} />
          ))}
    </div>
  );
};

export const ThreadListNew = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof Button> & { labelClassName?: string }
>(({ className, labelClassName, children, onClick, ...props }, ref) => {
  const aui = useAui();
  return (
    <ThreadListPrimitive.New asChild>
      <Button
        ref={ref}
        onClick={(event) => {
          const item = aui.threadListItem.getState();
          if (!item.remoteId) useChatPrivacyStore.getState().set(item.id, { temporary: false, personalized: true });
          onClick?.(event);
        }}
        variant="default"
        data-slot="aui_thread-list-new"
        className={cn(
          "h-8 justify-center gap-2 rounded-lg px-2.5 text-sm font-medium",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <PlusIcon
              data-slot="aui_thread-list-new-icon"
              className="size-4 shrink-0"
            />
            <span
              data-slot="aui_thread-list-new-label"
              className={cn("whitespace-nowrap", labelClassName)}
            >
              {t("common.newChat")}
            </span>
          </>
        )}
      </Button>
    </ThreadListPrimitive.New>
  );
});

ThreadListNew.displayName = "ThreadListNew";

const ThreadListSkeleton: FC = () => {
  return (
    <div
      role="status"
      aria-label={t("sidebar.loadingChats")}
      className="flex flex-col gap-0.5"
    >
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          data-slot="aui_thread-list-skeleton-wrapper"
          className="flex h-8 items-center px-2.5"
        >
          <Skeleton
            data-slot="aui_thread-list-skeleton"
            className="h-3.5 w-full"
          />
        </div>
      ))}
    </div>
  );
};

/** Up to two chips on a fine pointer; touch rows show one icon and the count instead. */
const ThreadListItemTags: FC = () => {
  const tags = (useAuiState((s) => s.threadListItem.custom) as Partial<ThreadCustom> | undefined)?.tags ?? [];
  if (!tags.length) return null;
  return (
    <>
      <span className="pointer-coarse:hidden ms-1.5 flex shrink-0 items-center gap-1">
        {tags.slice(0, 2).map((tag) => (
          <span key={tag} data-slot="aui-thread-list-item-tag" className="bg-sidebar-row-hover text-sidebar-muted-foreground max-w-[4.5rem] truncate rounded px-1 py-0.5 text-[10px] leading-none">
            #{tag}
          </span>
        ))}
      </span>
      <span aria-label={t("tags.tags")} className="hidden pointer-coarse:inline-flex ms-1 shrink-0 items-center gap-0.5 text-[10px] text-sidebar-muted-foreground">
        <TagIcon aria-hidden className="size-3" />
        {tags.length}
      </span>
    </>
  );
};

/** Restricted chats carry a shared-knowledge dependency; a revoked one is locked (readable by its owner only). */
const ThreadKnowledgeFlag: FC = () => {
  const custom = useAuiState((s) => s.threadListItem.custom) as { sharedKnowledgeRestricted?: boolean; knowledgeAccess?: string } | undefined;
  if (!custom?.sharedKnowledgeRestricted) return null;
  const locked = custom.knowledgeAccess === "revoked";
  return (
    <span
      className={cn("shrink-0", locked ? "text-destructive" : "text-muted-foreground")}
      title={locked ? t("knowledge.revokedTitle") : t("knowledge.restrictedHelp")}
    >
      {locked ? <ShieldOffIcon aria-hidden className="size-3.5" /> : <ShieldCheckIcon aria-hidden className="size-3.5" />}
      <span className="sr-only">{t("knowledge.restrictedBadge")}</span>
    </span>
  );
};

export const ThreadListItem: FC = () => {
  const aui = useAui();
  const id = useAuiState((s) => s.threadListItem.id);
  const selecting = useThreadSelection((s) => s.active);
  const selected = useThreadSelection((s) => s.active && s.ids.has(id));
  const isRunning = useAuiState((s) => s.threadListItem.isRunning);
  // Regenerating a title or building an export reuses the running spinner, since the menu has closed.
  const [busy, setBusy] = useState(false);
  const title = useAuiState((s) => s.threadListItem.title) || t("common.newChat");
  const [isRenaming, setIsRenaming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  // Entering selection from this row's menu keeps keyboard focus on the row.
  useEffect(() => {
    if (selecting && useThreadSelection.getState().anchor === id) selectRef.current?.focus();
  }, [selecting, id]);

  useEffect(() => {
    if (isRenaming || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [isRenaming]);

  const row = (
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      data-selected={selected || undefined}
      className="group data-selected:bg-primary/10 hover:bg-sidebar-row-hover focus-visible:bg-sidebar-row-hover data-active:depth-row-active has-focus-visible:bg-sidebar-row-hover data-popup-open:bg-sidebar-row-hover active:bg-sidebar-row-hover relative flex h-8 pointer-coarse:h-11 pointer-coarse:select-none items-center rounded-lg focus-visible:outline-none"
    >
      {selecting ? (
        <button
          ref={selectRef}
          type="button"
          role="checkbox"
          aria-checked={selected}
          data-slot="aui_thread-list-item-select"
          // Shift+click extends the selection; without this it would also select the row text.
          onMouseDown={(event) => event.shiftKey && event.preventDefault()}
          onClick={(event) => useThreadSelection.getState().toggle(id, event.shiftKey)}
          className="focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 text-start text-sm outline-none focus-visible:ring-1"
        >
          <SelectionCheck checked={selected} />
          {(isRunning || busy) && (
            <Loader2Icon aria-hidden className="text-muted-foreground -ms-1 size-3.5 shrink-0 animate-spin" />
          )}
          <ThreadListItemBranchIcon />
          <ThreadListItemTitle fallback={t("common.newChat")} />
          <ThreadKnowledgeFlag />
          <ThreadListItemTags />
        </button>
      ) : isRenaming ? (
        <ThreadListItemRename
          onDone={(restoreFocus) => {
            restoreFocusRef.current = restoreFocus;
            setIsRenaming(false);
          }}
        />
      ) : (
        <TooltipTrigger delay={800} render={<ThreadListItemPrimitive.Trigger
          ref={triggerRef}
          data-slot="aui_thread-list-item-trigger"
          onClick={(event) => {
            // Keeps the primitive from switching a second time; this handler switches once.
            event.preventDefault();
            aui.threadListItem.switchTo();
          }}
          className="focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center rounded-md px-2.5 text-start text-sm outline-none pointer-fine:group-hover:pe-9 pointer-fine:group-has-focus-visible:pe-9 focus-visible:ring-1"
        />}>
          {(isRunning || busy) && (
            <Loader2Icon
              aria-hidden
              data-slot="aui_thread-list-item-running"
              className="text-muted-foreground me-1.5 size-3.5 shrink-0 animate-spin"
            />
          )}
          <ThreadListItemBranchIcon />
          <ThreadListItemTitle fallback={t("common.newChat")} />
          <ThreadListItemTags />
          {isRunning && <span className="sr-only">{t("sidebar.running")}</span>}
        </TooltipTrigger>
      )}
      {!selecting && !isRenaming && <ThreadListItemQuickAction />}
    </ThreadListItemPrimitive.Root>
  );

  return (
    <Tooltip onOpenChange={(open, details) => {
      if (!open) return;
      const label = triggerRef.current?.querySelector<HTMLElement>("[data-slot=aui-thread-list-item-title-text]");
      if (!label || label.scrollWidth <= label.clientWidth) details.cancel();
    }}>
    <ThreadListItemMenu
      row={row}
      disabled={selecting || isRenaming}
      onRename={() => setIsRenaming(true)}
      onBusy={setBusy}
    />
    <TooltipContent side="bottom" align="start">{title}</TooltipContent>
    </Tooltip>
  );
};

const ThreadListItemBranchIcon: FC = () => {
  const branched = useAuiState((s) => !!(s.threadListItem.custom as Partial<ThreadCustom> | undefined)?.branchedFrom);
  if (!branched) return null;
  return (
    <span className="text-muted-foreground me-1.5 inline-flex shrink-0">
      <BranchIcon className="size-3.5" />
      <span className="sr-only">{t("sidebar.branchedChat")}</span>
    </span>
  );
};

/**
 * The runtime can stream a generated title in pieces, so a change is crossfaded
 * only once it settles; a prefix update is treated as the same title growing.
 */
const ThreadListItemTitle: FC<{ fallback: string }> = ({ fallback }) => {
  const title = useAuiState((s) => s.threadListItem.title) || fallback;
  const [current, setCurrent] = useState(title);
  const [outgoing, setOutgoing] = useState<string | null>(null);
  const changedAt = useRef(0);

  useEffect(() => {
    if (title === current) return;
    const growing = title.startsWith(current) || current.startsWith(title);
    const settled = performance.now() - changedAt.current > 400;
    changedAt.current = performance.now();
    if (growing || !settled) {
      setOutgoing(null);
      setCurrent(title);
      return;
    }
    setOutgoing(current);
    setCurrent(title);
    const timer = window.setTimeout(() => setOutgoing(null), 240);
    return () => window.clearTimeout(timer);
  }, [title, current]);

  return (
    <span
      data-slot="aui-thread-list-item-title"
      className="relative block min-w-0 flex-1 truncate"
    >
      {outgoing !== null && (
        <span
          aria-hidden
          className="shell-title-out absolute inset-0 block truncate"
        >
          {outgoing}
        </span>
      )}
      <span
        key={current}
        data-slot="aui-thread-list-item-title-text"
        className={cn("block truncate", outgoing !== null && "shell-title-in")}
      >
        {current}
      </span>
    </span>
  );
};

const ThreadListItemRename: FC<{
  onDone: (restoreFocus: boolean) => void;
}> = ({ onDone }) => {
  const aui = useAui();
  const title = useAuiState((s) => s.threadListItem.title) ?? "";
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const commit = (restoreFocus: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;

    const next = value.trim();
    if (!next || next === title) {
      onDone(restoreFocus);
      return;
    }

    // Deferred so a synchronous throw lands on the rejection path too.
    Promise.resolve()
      .then(() => aui.threadListItem.rename(next))
      .then(
        () => onDone(restoreFocus),
        () => {
          settledRef.current = false;
          if (restoreFocus) inputRef.current?.focus();
        },
      );
  };

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onDone(true);
  };

  return (
    <Input
      ref={inputRef}
      autoFocus
      data-slot="aui_thread-list-item-rename"
      aria-label={t("sidebar.renameChat")}
      value={value}
      className="h-7 min-w-0 flex-1 ps-2.5 pe-9 text-sm"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => commit(false)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
          return;
        if (event.key === "Enter") {
          event.preventDefault();
          commit(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
};

/**
 * Desktop hover action: pin or unpin, or delete without confirmation while Shift is held.
 * Touch devices open the row menu with a long press instead.
 */
const ThreadListItemQuickAction: FC = () => {
  const aui = useAui();
  const custom = useAuiState((s) => s.threadListItem.custom) as
    | Partial<ThreadCustom>
    | undefined;
  const pinned = custom?.pinned === true;
  const deleting = useShiftHeld();
  const label = deleting ? t("sidebar.deleteChat") : pinned ? t("sidebar.unpinChat") : t("sidebar.pinChat");

  return (
    <Button
      variant="ghost"
      size="icon"
      data-slot="aui_thread-list-item-quick-action"
      className={cn(
        "absolute end-1.5 top-1/2 size-6 -translate-y-1/2 p-0 opacity-0 transition-[opacity,color,background-color] duration-(--motion-fast) ease-out-quart pointer-coarse:hidden group-hover:opacity-100 group-has-focus-visible:opacity-100",
        deleting && "text-destructive hover:bg-destructive/10 hover:text-destructive",
      )}
      onClick={() =>
        void Promise.resolve()
          .then(() =>
            deleting
              ? aui.threadListItem.delete()
              : aui.threadListItem.updateCustom({ ...custom, pinned: !pinned }),
          )
          .catch(() => {})
      }
    >
      {deleting ? (
        <Trash2Icon className="size-3.5" />
      ) : pinned ? (
        <PinOffIcon className="size-3.5" />
      ) : (
        <PinIcon className="size-3.5" />
      )}
      <span className="sr-only">{label}</span>
    </Button>
  );
};

/** Opens on right-click, or on long press for touch, anywhere on the row. */
const ThreadListItemMenu: FC<{
  row: ReactElement;
  disabled: boolean;
  onRename: () => void;
  onBusy: (busy: boolean) => void;
}> = ({ row, disabled, onRename, onBusy }) => {
  const aui = useAui();
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const title = useAuiState((s) => s.threadListItem.title);
  const custom = useAuiState((s) => s.threadListItem.custom) as
    | Partial<ThreadCustom>
    | undefined;
  const projects = useData((s) => s.projects);
  const activeProject = useData((s) => s.activeProject);
  const [sharing, setSharing] = useState(false);
  const [tagEditor, setTagEditor] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  // PDF export renders on the server, so it is the one export that needs the browser worker.
  const pdfDown = useServiceDown("browser");
  // Rename and the dialogs take focus themselves; returning it to the trigger would blur the rename field.
  const keepFocusRef = useRef(false);
  const rowRef = useRef<HTMLDivElement>(null);

  // A chat created in this session has no metadata yet; it lives in the project that was active then.
  const projectId =
    custom && "projectId" in custom ? (custom.projectId ?? null) : activeProject;
  const pinned = custom?.pinned === true;
  const rowTags = custom?.tags ?? [];
  const tagLibrary = useTagFilter((s) => s.tags);
  const loadTags = useTagFilter((s) => s.load);
  const refreshTags = useTagFilter((s) => s.refreshTags);
  const accountId = useData((s) => s.me?.id);
  useEffect(() => {
    if (accountId) void loadTags(accountId);
  }, [accountId, loadTags]);
  const update = (change: Partial<ThreadCustom>) =>
    Promise.resolve()
      .then(() => aui.threadListItem.updateCustom({ ...custom, ...change }))
      .catch(() => {});
  const toggleTag = (tag: string) => {
    const next = rowTags.includes(tag) ? rowTags.filter((item) => item !== tag) : [...rowTags, tag];
    void update({ tags: next }).then(() => void refreshTags());
  };

  const busyWhile = async (failure: string, task: () => Promise<void>) => {
    onBusy(true);
    setRowError(null);
    try {
      await task();
    } catch (cause) {
      // Inline on the row, not a browser alert: the message is already the safe ApiError text.
      setRowError(cause instanceof Error ? cause.message : failure);
    } finally {
      onBusy(false);
    }
  };

  const regenerateTitle = () =>
    busyWhile(t("sidebar.regenerateTitleFailed"), async () => {
      const { title } = await api<{ title: string }>(`/threads/${remoteId}/title`, {
        method: "POST",
        json: { modelRef: getActiveModel(remoteId)?.ref },
      });
      // Through the runtime, so the row and the chat header update together.
      if (title) await aui.threadListItem.rename(title);
    });

  const withFocus = (fn: () => void) => () => {
    keepFocusRef.current = true;
    fn();
  };

  // The current chat's row answers the chat commands, so they work from anywhere in the app.
  const isMain = useAuiState((s) => s.threads.mainThreadId === s.threadListItem.id);
  const reveal = () => {
    if (document.querySelector(".shell-sidebar")?.getAttribute("data-open") !== "true") runCommand("nav.chatList");
    rowRef.current?.scrollIntoView({ block: "nearest" });
  };
  useCommand("chat.rename", () => {
    reveal();
    requestAnimationFrame(withFocus(onRename));
  }, isMain && !disabled);
  useCommand("chat.pin", () => void update({ pinned: !pinned }), isMain);
  useCommand("chat.archive", () => void Promise.resolve().then(() => aui.threadListItem.archive()).catch(() => {}), isMain);
  useCommand("chat.delete", () => setConfirmDelete(true), isMain);
  useCommand("chat.menu", () => {
    reveal();
    // Base UI opens a context menu from the contextmenu event, the same one Shift+F10 sends.
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>("[data-slot=aui_thread-list-item][data-active]");
      if (!row) return;
      const rect = row.getBoundingClientRect();
      row.querySelector<HTMLElement>("[data-slot=aui_thread-list-item-trigger]")?.focus();
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 16, clientY: rect.bottom }));
    });
  }, isMain && !disabled);
  useCommand("chat.tags", () => {
    if (!remoteId) return false;
    reveal();
    requestAnimationFrame(withFocus(() => setTagEditor(true)));
    return true;
  }, isMain && !disabled && !!remoteId);

  return (
    <>
      <ContextMenu.Root disabled={disabled}>
        <ContextMenu.Trigger ref={rowRef} render={row} />
        <MenuContent
          side="bottom"
          align="start"
          sideOffset={2}
          data-slot="aui_thread-list-item-more-content"
          className="max-w-[calc(100vw-1rem)] min-w-48"
          finalFocus={(closeType) => {
            const keep = keepFocusRef.current;
            keepFocusRef.current = false;
            if (keep) return false;
            // A context menu has no trigger to return to; after a keyboard close the row takes focus back.
            return (closeType === "keyboard" && rowRef.current?.querySelector<HTMLElement>("[data-slot=aui_thread-list-item-trigger]")) || true;
          }}
        >
          <MenuItem onClick={withFocus(() => useThreadSelection.getState().start(aui.threadListItem.getState().id))}>
            <ListChecksIcon /> {t("common.select")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => void update({ pinned: !pinned })}>
            {pinned ? <PinOffIcon /> : <PinIcon />}
            {pinned ? t("sidebar.unpin") : t("sidebar.pin")}
          </MenuItem>
          <MenuSubmenuRoot>
            <MenuSubmenuTrigger disabled={!remoteId}>
              <TagIcon />
              <span className="flex-1">{t("tags.tags")}</span>
              <ChevronRightIcon className="text-muted-foreground ms-auto" />
            </MenuSubmenuTrigger>
            <MenuContent side="right" align="start" className="max-h-[min(24rem,var(--available-height))] max-w-[calc(100vw-1rem)]">
              {tagLibrary.length > 0 && <MenuLabel>{t("tags.tags")}</MenuLabel>}
              {tagLibrary.map((item) => (
                <MenuItem key={item.tag} closeOnClick={false} onClick={() => toggleTag(item.tag)}>
                  <CheckIcon className={cn("size-4", rowTags.includes(item.tag) ? "opacity-100" : "opacity-0")} />
                  <span className="min-w-0 flex-1 truncate">#{item.tag}</span>
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem onClick={withFocus(() => setTagEditor(true))}>
                <PlusIcon /> {t("tags.newTag")}
              </MenuItem>
            </MenuContent>
          </MenuSubmenuRoot>
          <MenuItem disabled={!remoteId} onClick={withFocus(() => setSharing(true))}>
            <ShareIcon /> {t("sidebar.share")}
          </MenuItem>
          <MenuSubmenuRoot>
            <MenuSubmenuTrigger>
              <FolderInputIcon />
              <span className="flex-1">{t("sidebar.moveTo")}</span>
              <ChevronRightIcon className="text-muted-foreground ms-auto" />
            </MenuSubmenuTrigger>
            <MenuContent side="right" align="start" className="max-h-[min(24rem,var(--available-height))] max-w-[calc(100vw-1rem)]">
              {[{ id: null, name: t("sidebar.noProject") }, ...projects].map((p) => (
                <MenuItem
                  key={p.id ?? ""}
                  disabled={p.id === projectId}
                  onClick={() => void update({ projectId: p.id })}
                >
                  <CheckIcon className={cn(p.id === projectId ? "opacity-100" : "opacity-0")} />
                  <span className="min-w-0 truncate">{p.name}</span>
                </MenuItem>
              ))}
            </MenuContent>
          </MenuSubmenuRoot>
          <MenuItem
            disabled={!remoteId}
            onClick={() =>
              window.open(chatPath(remoteId!), "_blank", "noopener")
            }
          >
            <ExternalLinkIcon /> {t("sidebar.openInNewTab")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={withFocus(onRename)}>
            <TextCursorIcon /> {t("common.rename")}
          </MenuItem>
          <MenuItem disabled={!remoteId} onClick={() => void regenerateTitle()}>
            <SparklesIcon /> {t("sidebar.regenerateTitle")}
          </MenuItem>
          <MenuSubmenuRoot>
            <MenuSubmenuTrigger disabled={!remoteId}>
              <DownloadIcon />
              <span className="flex-1">{t("common.export")}</span>
              <ChevronRightIcon className="text-muted-foreground ms-auto" />
            </MenuSubmenuTrigger>
            <MenuContent side="right" align="start">
              <MenuItem onClick={() => void busyWhile(t("sidebar.exportChatFailed"), () => exportThread(remoteId!, "markdown", title))}>
                <FileTextIcon /> {t("sidebar.markdown")}
              </MenuItem>
              <MenuItem
                aria-disabled={pdfDown || undefined}
                aria-describedby={pdfDown ? "pdf-export-availability" : undefined}
                onClick={pdfDown ? undefined : () => void busyWhile(t("sidebar.exportChatFailed"), () => { markUsedServices(["browser"]); return exportThread(remoteId!, "pdf", title); })}
                className={pdfDown ? "text-muted-foreground" : undefined}
              >
                <FileDownIcon /> {t("sidebar.pdf")}
              </MenuItem>
              {pdfDown && <ServiceAvailability id="browser" className="mx-1 mb-1" describeId="pdf-export-availability" messageKey="services.exportPdfNote" />}
            </MenuContent>
          </MenuSubmenuRoot>
          <MenuSeparator />
          <MenuItem onClick={() => void Promise.resolve().then(() => aui.threadListItem.archive()).catch(() => {})}>
            <ArchiveIcon /> {t("sidebar.archive")}
          </MenuItem>
          <MenuItem destructive onClick={withFocus(() => setConfirmDelete(true))}>
            <Trash2Icon /> {t("sidebar.deletePermanently")}
          </MenuItem>
        </MenuContent>
      </ContextMenu.Root>
      {rowError && <p role="alert" className="text-destructive px-3 pb-1 text-xs break-words">{rowError}</p>}

      {remoteId && (
        <TagEditorDialog
          open={tagEditor}
          onOpenChange={setTagEditor}
          threads={[{ id: remoteId, tags: rowTags, custom: { ...(custom ?? {}) } }]}
          onSave={async (updates) => {
            for (const entry of updates) await aui.threadListItem.updateCustom(entry.custom as Partial<ThreadCustom>);
            await refreshTags();
          }}
        />
      )}

      {remoteId && (
        <Dialog open={sharing} onOpenChange={setSharing}>
          <DialogContent className="gap-3 sm:max-w-sm">
            <DialogTitle className="truncate pe-6 text-base">{title || t("common.newChat")}</DialogTitle>
            <div>
              <SharePanel threadId={remoteId} title={null} />
            </div>
          </DialogContent>
        </Dialog>
      )}

      <DeleteChatDialog
        open={confirmDelete}
        title={title}
        onOpenChange={setConfirmDelete}
        onConfirm={async () => {
          await aui.threadListItem.delete();
        }}
      />
    </>
  );
};

/**
 * Actions for the chats selected in the sidebar. Pin and Move keep the selection for a follow-up;
 * Archive and Delete leave selection mode once every chat went through. Chats that failed stay
 * selected with the error shown.
 */
export const ThreadSelectionBar: FC<{ scope: RefObject<HTMLElement | null> }> = ({ scope }) => {
  const aui = useAui();
  const active = useThreadSelection((s) => s.active);
  const ids = useThreadSelection((s) => s.ids);
  const order = useThreadSelection((s) => s.order);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const projects = useData((s) => s.projects);
  const activeProject = useData((s) => s.activeProject);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tagEditor, setTagEditor] = useState(false);
  const refreshTags = useTagFilter((s) => s.refreshTags);
  // What the delete dialog names, frozen on open so its closing fade does not show the emptied selection.
  const [deleting, setDeleting] = useState<{ count: number; title: string | null | undefined }>({ count: 0, title: null });
  const { selectAll, clear, exit } = useThreadSelection.getState();

  useSelectionKeys(active, { onExit: exit, onSelectAll: selectAll, scope });
  useEffect(() => {
    if (!active) setError(null);
  }, [active]);

  const count = ids.size;
  const allSelected = order.length > 0 && order.every((id) => ids.has(id));
  const custom = (id: string) =>
    threadItems.find((item) => item.id === id)?.custom as Partial<ThreadCustom> | undefined;
  const allPinned = count > 0 && [...ids].every((id) => custom(id)?.pinned === true);
  // Same fallback as a row's menu: a chat created this session belongs to the project active then.
  const projectOf = (id: string) => {
    const c = custom(id);
    return c && "projectId" in c ? (c.projectId ?? null) : activeProject;
  };
  const sharedProject = count > 0 && new Set([...ids].map(projectOf)).size === 1 ? projectOf([...ids][0]!) : undefined;

  /** Runs `task` per selected chat; throws the summary when some failed, so callers can show it. */
  const apply = async (verb: BatchVerb, task: (id: string) => unknown, leave: boolean) => {
    const selection = [...useThreadSelection.getState().ids];
    setBusy(true);
    setError(null);
    try {
      const { failed, error } = await runBatch(selection, task);
      if (failed.length) {
        useThreadSelection.setState({ ids: new Set(failed) });
        throw new Error(withReason(batchFailure(verb, failed.length, selection.length), error));
      }
      if (leave) exit();
    } finally {
      setBusy(false);
    }
  };
  const run = (verb: BatchVerb, task: (id: string) => unknown, leave = false) =>
    void apply(verb, task, leave).catch((cause: Error) => setError(cause.message));

  const item = (id: string) => aui.threads.item({ id });
  const actionClass =
    "hover:bg-sidebar-row-hover focus-visible:ring-ring/50 data-popup-open:bg-sidebar-row-hover flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-[11px] leading-none outline-none transition-colors duration-(--motion-fast) ease-out-quart focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-40 pointer-coarse:py-2.5 [&_svg]:size-4";

  return (
    <>
    {active && (
    <div
      role="toolbar"
      aria-label={t("sidebar.selectedChats")}
      data-slot="aui_thread-selection-bar"
      className="border-sidebar-border animate-rise-in flex shrink-0 flex-col gap-1 border-t px-2 pt-1.5 pb-1"
    >
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium tabular-nums" aria-live="polite">
          {count === 0 ? t("sidebar.selectChats") : t("sidebar.selectedCount", { count })}
        </span>
        {busy && <Loader2Icon aria-label={t("sidebar.working")} className="text-muted-foreground size-4 shrink-0 animate-spin" />}
        <Button
          variant="ghost"
          size="sm"
          disabled={order.length === 0}
          onClick={allSelected ? clear : selectAll}
          className="text-sidebar-muted-foreground hover:bg-sidebar-row-hover px-2 pointer-coarse:h-10"
        >
          {allSelected ? t("sidebar.deselectAll") : t("common.selectAll")}
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("sidebar.doneSelecting")}
                onClick={exit}
                className="hover:bg-sidebar-row-hover pointer-coarse:size-10"
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipContent side="top">{t("sidebar.doneEsc")}</TooltipContent>
        </Tooltip>
      </div>
      {error && (
        <p role="alert" className="text-destructive px-1 text-xs">
          {error}
        </p>
      )}
      <div className="grid grid-cols-5 gap-0.5">
        <button
          type="button"
          disabled={busy || count === 0}
          className={actionClass}
          onClick={() =>
            run(allPinned ? "unpin" : "pin", (id) => item(id).updateCustom({ ...custom(id), pinned: !allPinned }))
          }
        >
          {allPinned ? <PinOffIcon /> : <PinIcon />}
          {allPinned ? t("sidebar.unpin") : t("sidebar.pin")}
        </button>
        <Menu>
          <MenuTrigger disabled={busy || count === 0} className={actionClass}>
            <FolderInputIcon /> {t("sidebar.move")}
          </MenuTrigger>
          <MenuContent
            side="top"
            align="center"
            className="max-h-[min(24rem,var(--available-height))] max-w-[calc(100vw-1rem)] min-w-48"
          >
            {[{ id: null, name: t("sidebar.noProject") }, ...projects].map((p) => (
              <MenuItem
                key={p.id ?? ""}
                disabled={p.id === sharedProject}
                onClick={() => run("move", (id) => item(id).updateCustom({ ...custom(id), projectId: p.id }))}
              >
                <CheckIcon className={cn(p.id === sharedProject ? "opacity-100" : "opacity-0")} />
                <span className="min-w-0 truncate">{p.name}</span>
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <button
          type="button"
          disabled={busy || count === 0}
          className={actionClass}
          onClick={() => setTagEditor(true)}
        >
          <TagIcon /> {t("tags.tags")}
        </button>
        <button
          type="button"
          disabled={busy || count === 0}
          className={actionClass}
          onClick={() => run("archive", (id) => item(id).archive(), true)}
        >
          <ArchiveIcon /> {t("sidebar.archive")}
        </button>
        <button
          type="button"
          disabled={busy || count === 0}
          className={cn(actionClass, "text-destructive hover:bg-destructive/10")}
          onClick={() => {
            setDeleting({ count, title: threadItems.find((t) => ids.has(t.id))?.title });
            setConfirmDelete(true);
          }}
        >
          <Trash2Icon /> {t("common.delete")}
        </button>
      </div>
    </div>
    )}
    <TagEditorDialog
      open={tagEditor && active}
      onOpenChange={setTagEditor}
      threads={[...ids].map((id) => ({ id, tags: custom(id)?.tags ?? [], custom: { ...(custom(id) ?? {}) } }))}
      onSave={async (updates) => {
        const byId = new Map(updates.map((entry) => [entry.id, entry.custom]));
        await apply("tags", (id) => item(id).updateCustom(byId.get(id) as Partial<ThreadCustom>), false);
        await refreshTags();
      }}
    />
    {/* Outside the bar, which unmounts when selection ends, so the dialog can fade out. */}
    <DeleteChatDialog
      open={confirmDelete}
      title={deleting.title}
      count={deleting.count}
      onOpenChange={setConfirmDelete}
      onConfirm={() =>
        apply("delete", (id) => item(id).delete(), true).catch((cause: unknown) => {
          setDeleting((prev) => ({ ...prev, count: useThreadSelection.getState().ids.size }));
          throw cause;
        })
      }
    />
    </>
  );
};
