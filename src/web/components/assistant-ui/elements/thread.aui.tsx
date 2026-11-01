"use client";

import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/elements/attachment.aui";
import { File, getFileHref } from "@/components/assistant-ui/elements/file";
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/elements/follow-up-suggestions.aui";
import { Image } from "@/components/assistant-ui/elements/image";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import { draftResultKey, emailResultKey } from "@/components/assistant-ui/elements/fold-key";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSmoothHeight } from "@/components/ui/smooth-height";
import { cn } from "@/lib/utils";
import { toolInjection } from "@/lib/tool-injection";
import { useData } from "@/state/data";
import { currentLocale, t } from "@/i18n";
import { formatDuration, formatList } from "@/i18n/format";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  groupPartByType,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
  type TextMessagePartComponent,
  type ToolCallMessagePartComponent,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CloudOffIcon,
  AudioLinesIcon,
  BrainIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  MicIcon,
  MoreHorizontalIcon,
  SquarePenIcon,
  PhoneIcon,
  RefreshCwIcon,
  SquareIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type FC,
  type FocusEvent,
  type PropsWithChildren,
  type RefObject,
} from "react";
import { CopyFeedbackIcon } from "@/components/assistant-ui/elements/surfaces";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useLongPaste } from "@/components/chat/long-paste";
import { parseAttachmentText, splitUserMessage, typedText } from "@/runtime/message-attachments";
import { mcpAppOf } from "@/components/chat/McpApp";
import { ReplyFiles } from "@/components/chat/reply-files";
import { TurnServiceNote } from "@/components/chat/ServiceNotice";
import { RetryWithModel } from "@/components/chat/retry-model";
import { ChatErrorMessage } from "@/components/chat/message-error";
import { EditableReplyTexts, EditedReplyBadge, ReplyEditAction, ReplyEditorFooter, ReplyEditorShell } from "@/components/chat/AssistantMessageEditor";
import { editKey, useMessageEdits } from "@/state/message-edits";
import { RetryStatus } from "@/components/chat/retry-status";
import { ShortcutHints } from "@/components/chat/ShortcutHints";
import { DictationSend, ReadAloudAutoPlay, SpeechServiceHint, useDictateLabel, useSendDictation, VoiceNotice } from "@/speech/ChatVoice";
import { useLocalSpeechUnavailable } from "@/speech/adapters";
import { useSpeech } from "@/speech/store";
import { useThreadSync, type ThreadSync } from "@/state/thread-sync";
import { useChatResearch } from "@/state/chat-research";
import { DictationWaveform } from "@/speech/Waveform";
import { CallButton } from "@/speech/call/CallButton";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

const reasoningDuration = (timing: ThreadGroupPart["timing"]) =>
  timing?.completedAt === undefined
    ? undefined
    : Math.round((timing.completedAt - timing.startedAt) / 1000);

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`. When `TaskGroup` is set, tool calls that carry a nested
 * conversation and have no registered UI render through it instead of the
 * tool group; without it they render like any other tool call.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  TaskGroup?: ComponentType<{ group: ThreadGroupPart }> | undefined;
  /** okaychat: controls left of the send button (model picker, effort, context meter). */
  ComposerToolbar?: ComponentType | undefined;
  /** okaychat: shown in the assistant message footer (model, tokens, cost). */
  MessageMeta?: ComponentType | undefined;
  /** okaychat: rendered after every message (compaction markers). */
  AfterMessage?: ComponentType | undefined;
  /** okaychat: rendered above the first message (fork origin). */
  BeforeMessages?: ComponentType | undefined;
  /** okaychat: branch action in both message action bars. */
  BranchAction?: ComponentType | undefined;
};

const messageGroupBy = groupPartByType({
  // Reasoning and the tool calls between it form one work log.
  reasoning: ["group-chainOfThought"],
  "tool-call": ["group-chainOfThought"],
  "standalone-tool-call": [],
  // Artifact cards stay visible so they can be clicked and auto-open the panel.
  "tool-call:create_artifact": [],
  "tool-call:update_artifact": [],
  "tool-call:create_document": [],
  "tool-call:edit_document": [],
  "tool-call:import_document": [],
  "tool-call:show_widget": [],
  "tool-call:edit_widget": [],
  "tool-call:render_spec": [],
  "tool-call:generate_image": [],
  "tool-call:delegate_task": [],
  "tool-call:deep_research": [],
  "tool-call:run_code": [],
  "tool-call:email_read": [],
  "tool-call:email_send": [],
  "tool-call:email_reply": [],
  // The draft is the result: it must stay editable after the reply finishes.
  "tool-call:draft_email": [],
  "tool-call:draft_text": [],
  // Citation cards stay visible: their sources are clickable.
  "tool-call:search_knowledge": [],
});

type ThreadGroupKey =
  | "group-work"
  | "group-chainOfThought"
  | "group-reasoning"
  | "group-tool"
  | "group-task";

const TASK_GROUP_PATH: readonly ThreadGroupKey[] = [
  "group-chainOfThought",
  "group-task",
];

const taskAwareGroupBy = (
  part: Parameters<typeof messageGroupBy>[0],
  context?: Parameters<typeof messageGroupBy>[1],
): readonly ThreadGroupKey[] => {
  const path = messageGroupBy(part, context);
  return part.type === "tool-call" &&
    part.messages !== undefined &&
    path.length > 0 &&
    !context?.toolUIs?.[part.toolName]?.length
    ? TASK_GROUP_PATH
    : path;
};

type GroupablePart = Parameters<typeof messageGroupBy>[0];
type GroupBy = typeof taskAwareGroupBy;

/**
 * Which result a card shows. Within one reply only the last card per key stays
 * visible; earlier calls with the same key were drafts. Tools without a key
 * (searches, reads, screenshots, sub-agents, runs) are work, not results. A run's files are shown once
 * for the whole reply by `ReplyFiles`.
 */
const resultKey = (part: GroupablePart): string | undefined => {
  if (part.type !== "tool-call" || part.status.type === "incomplete") return undefined;
  const args = (part.args ?? {}) as { id?: unknown; title?: unknown };
  switch (part.toolName) {
    case "create_artifact":
    case "update_artifact":
    case "create_document":
    case "edit_document":
    case "import_document": {
      if (typeof part.result !== "object" || part.result === null) return undefined;
      const id = (part.result as { id?: unknown }).id ?? args.id;
      return `artifact:${String(id)}`;
    }
    case "show_widget":
    case "edit_widget":
      return `widget:${String(args.title ?? "")}`;
    case "render_spec":
      return "spec";
    case "generate_image":
      return `image:${part.toolCallId}`;
    // The research card stays above its report: it holds the questions and the pages read.
    case "deep_research":
      return `research:${part.toolCallId}`;
    case "email_read":
    case "email_send":
    case "email_reply":
      return emailResultKey(part.toolName, part.toolCallId, part.args);
    case "draft_text":
    case "draft_email":
      return draftResultKey(part.args, part.result);
    // Each knowledge search keeps its citation list, like an image or an app card.
    case "search_knowledge":
      return `knowledge:${part.toolCallId}`;
    default:
      // Each MCP App call is its own result, like a generated image.
      return mcpAppOf(part.result) ? `app:${part.toolCallId}` : undefined;
  }
};

/** MCP App cards stay out of the work log, like artifact cards. Tool names are dynamic, so this checks the result. */
const withMcpApps =
  (base: GroupBy): GroupBy =>
  (part, context) =>
    part.type === "tool-call" && mcpAppOf(part.result) ? [] : base(part, context);

// Built once: a new grouping function on every render made each message regroup its parts whenever it rendered.
const taskAwareMcpGroupBy = withMcpApps(taskAwareGroupBy);
const messageMcpGroupBy = withMcpApps(messageGroupBy);

/**
 * Folds a finished reply's work into one collapsed group: reasoning, tool
 * calls, text written between calls, and superseded drafts. What stays is the
 * outcome: the last card per result and the text after the last tool call.
 */
function foldWork(base: GroupBy, parts: readonly GroupablePart[]): GroupBy {
  const lastTool = parts.findLastIndex((p) => p.type === "tool-call");
  if (lastTool < 0) return base;
  const keep = new Set<GroupablePart>();
  const seen = new Set<string>();
  for (const part of parts.slice(lastTool + 1)) keep.add(part);
  // A reply that ends on a tool call still keeps its last text.
  if (!parts.some((p, i) => i > lastTool && p.type === "text")) {
    const lastText = parts.findLast((p) => p.type === "text");
    if (lastText) keep.add(lastText);
  }
  for (let i = lastTool; i >= 0; i--) {
    const key = resultKey(parts[i]!);
    if (key && !seen.has(key)) {
      seen.add(key);
      keep.add(parts[i]!);
    }
  }
  return (part, context) => {
    const path = base(part, context);
    // The work group is itself the log, so its rows are not grouped again.
    return keep.has(part)
      ? path
      : ["group-work", ...path.filter((key) => key !== "group-chainOfThought")];
  };
}

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  autoFocus?: boolean | undefined;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

/**
 * Index of the first message that is not loaded history. Messages at or above
 * it arrived while the reader was watching, so only they animate in. A ref
 * keeps the context value stable: streaming re-renders the thread on every
 * token and must not re-render every message through a changing context value.
 */
const MessageBaselineContext = createContext<{ current: number | null }>({
  current: null,
});

const MessageEnteringContext = createContext(false);

/**
 * Messages are focus stops for keyboard navigation (`message.*` commands). The action bar of an older
 * message only mounts on hover, so focus counts as hovering, also when the pointer leaves meanwhile.
 */
const useMessageFocus = () => {
  const aui = useAui();
  const hovering = useAuiState((s) => s.message.isHovering);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hovering && ref.current?.contains(document.activeElement)) aui.message().setIsHovering(true);
  }, [hovering, aui]);
  return {
    ref,
    tabIndex: -1,
    "data-message-root": "",
    onFocus: () => aui.message().setIsHovering(true),
    // Menus opened from the bar are portaled, but hold the bar open themselves (its interaction lock).
    onBlur: (event: FocusEvent<HTMLDivElement>) => {
      const el = event.currentTarget;
      if (!el.contains(event.relatedTarget as Node | null) && !el.matches(":hover")) aui.message().setIsHovering(false);
    },
  };
};

const CopyActionButton: FC<{ className?: string }> = ({ className }) => {
  const copied = useAuiState((s) => s.message.isCopied);
  return (
    <ActionBarPrimitive.Copy asChild>
      <TooltipIconButton tooltip={t("common.copy")} command="message.copy" className={className}>
        <CopyFeedbackIcon copied={copied} />
      </TooltipIconButton>
    </ActionBarPrimitive.Copy>
  );
};

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

// A switched thread that is still fetching its history: skeleton, not welcome.
const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

const ThreadHistorySkeleton: FC = () => (
  <div
    data-slot="aui_thread-history-skeleton"
    role="status"
    className="animate-in fade-in fill-mode-both flex flex-col gap-y-6 [animation-delay:150ms] [animation-duration:200ms]"
  >
    <span className="sr-only">{t("thread.loadingConversation")}</span>
    <Skeleton className="ml-auto h-9 w-2/5 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
    </div>
    <Skeleton className="ml-auto h-9 w-1/3 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-10/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
    </div>
  </div>
);

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  autoFocus = true,
}) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot isEmpty={isEmpty} autoFocus={autoFocus} />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{ isEmpty: boolean; autoFocus: boolean }> = ({
  isEmpty,
  autoFocus,
}) => {
  const { Welcome = ThreadWelcome, BeforeMessages } = useContext(ThreadComponentsContext);

  // History arrives as one batch after a switch, marked by `isLoading` (the
  // skeleton relies on the same flag). Everything from the batch back is
  // history; a message appended after it is new and animates. A different
  // first message means another thread or branch, which is history as well.
  const messageCount = useAuiState((s) => s.thread.messages.length);
  const firstMessageId = useAuiState((s) => s.thread.messages[0]?.id);
  const loadingHistory = useAuiState((s) => s.thread.isLoading);
  const baseline = useRef<number | null>(null);
  const batch = useRef<{
    firstId: string | undefined;
    pending: boolean;
    generation: number;
  }>({ firstId: undefined, pending: false, generation: 0 });
  const seen = batch.current;

  // The composer sits outside the scroller (see the footer below), so the
  // content keeps an equal spacer and the composer skips the scrollbar.
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const viewport = viewportRef.current;
    const footer = footerRef.current;
    if (!root || !viewport || !footer) return;
    const measure = () => {
      root.style.setProperty("--composer-inset", `${footer.offsetHeight}px`);
      root.style.setProperty("--thread-scrollbar", `${viewport.offsetWidth - viewport.clientWidth}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(footer);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  if (loadingHistory) {
    seen.pending = true;
    baseline.current = null;
  }
  // A changed first message is another branch (or an earlier page prepended):
  // that is history too, but it landed in place, so it does not fade.
  if (seen.firstId !== firstMessageId && seen.firstId !== undefined) {
    baseline.current = null;
  }
  seen.firstId = firstMessageId;
  if (baseline.current === null && !loadingHistory) {
    baseline.current = messageCount;
    // Only a loaded batch remounts the list for the one fade. A prepend keeps
    // the existing nodes so scroll anchoring survives.
    if (seen.pending && messageCount > 0) seen.generation += 1;
    seen.pending = false;
  }

  return (
    <ThreadPrimitive.Root
      ref={rootRef}
      className="aui-root aui-thread-root @container relative flex h-full flex-col"
      style={{
        ["--thread-max-width" as string]: "var(--chat-content-max-width, 46rem)",
        // The card surface, thinned by the glass opacity setting so content
        // scrolling under the composer shows through. It stays more opaque than
        // the glass setting alone because it floats on a layered shadow.
        ["--composer-bg" as string]:
          "color-mix(in oklab, var(--card) min(100%, calc(var(--glass-opacity) + 30%)), transparent)",
        ["--composer-radius" as string]: "1.25rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        topAnchorMessageClamp={{ tallerThan: "13em", visibleHeight: "9em" }}
        ref={viewportRef}
        data-slot="aui_thread-viewport"
        className="flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4",
            isEmpty ? "pt-24 md:justify-center md:pt-4" : "pt-24 md:pt-[3em]",
          )}
        >
          <AuiIf condition={isNewChatView}>
            <Welcome />
            <ShortcutHints />
          </AuiIf>
          <AuiIf condition={isHistoryLoadingView}>
            <ThreadHistorySkeleton />
          </AuiIf>

          <ThreadLoadEarlier />
          {BeforeMessages && <BeforeMessages />}

          <MessageBaselineContext.Provider value={baseline}>
            <div
              key={`messages-${seen.generation}`}
              data-slot="aui_message-group"
              className={cn(
                "mb-14 flex flex-col gap-y-6 empty:hidden",
                // One quick fade for the whole batch, never one per message.
                seen.generation > 0 && "chat-history-in",
              )}
            >
              <WindowedMessages viewportRef={viewportRef} />
            </div>
          </MessageBaselineContext.Provider>

          {!isEmpty && <div aria-hidden className="mt-auto h-(--composer-inset) shrink-0" />}

          {/* Positioned against the root rather than the scroller, so the
              overscroll bounce moves only the messages. */}
          <ThreadPrimitive.ViewportFooter
            ref={footerRef}
            className={cn(
              "aui-thread-viewport-footer flex flex-col gap-4 overflow-visible pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-6",
              isEmpty
                ? "relative"
                : "absolute bottom-0 left-0 right-(--thread-scrollbar) mx-auto w-auto max-w-(--thread-max-width) px-4 rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            <RetryStatus />
            <ThreadFollowupSuggestions />
            <Composer autoFocus={autoFocus} />
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);
  const isSpoken = useAuiState((s) => s.message.metadata.modality === "voice");
  const { AfterMessage } = useContext(ThreadComponentsContext);

  const baseline = useContext(MessageBaselineContext);
  const index = useAuiState((s) => s.message.index);
  // Captured at mount: a message never starts animating later when the
  // baseline moves during a load.
  const [entering] = useState(
    () => baseline.current !== null && index >= baseline.current,
  );

  const body = isEditing ? (
    <EditComposer />
  ) : isSpoken ? (
    <SpokenMessage />
  ) : role === "user" ? (
    <UserMessage />
  ) : (
    <AssistantMessageComponent />
  );
  return (
    <>
      <MessageEnteringContext.Provider value={entering}>
        {body}
      </MessageEnteringContext.Provider>
      {AfterMessage && <AfterMessage />}
    </>
  );
};

// Long chats mount their newest messages first, so opening one paints at once. Older messages follow in
// small slices after that paint, up to AUTO_REVEAL; anything older waits for "Show earlier messages".
// Only rendering is windowed: the runtime holds every message, so requests, branching, and export still
// see the whole history.
const FIRST_PAINT = 16;
const REVEAL_STEP = 8;
const AUTO_REVEAL = 80;
const MANUAL_REVEAL = 50;
const MESSAGE_COMPONENTS = { Message: ThreadMessage };

/**
 * Message ids in order, with a stable identity while only message content changes (streaming), and a
 * React key per message. A sent message first shows assistant-ui's optimistic reply placeholder, which
 * the streamed reply replaces under the server's id. The reply inherits the placeholder's key, or it
 * remounts mid-send: its fade replays and the top-anchor reserve collapses and regrows.
 */
const useMessageIds = (): { ids: readonly string[]; keys: readonly string[] } => {
  const messages = useAuiState((s) => s.thread.messages);
  const state = useRef<{
    ids: readonly string[];
    keys: readonly string[];
    aliases: Map<string, string>;
    optimisticTail: boolean;
  }>({ ids: [], keys: [], aliases: new Map(), optimisticTail: false });
  const prev = state.current;
  if (prev.ids.length !== messages.length || messages.some((m, i) => m.id !== prev.ids[i])) {
    const ids = messages.map((m) => m.id);
    const tail = ids.length - 1;
    const replacesPlaceholder =
      prev.optimisticTail &&
      prev.ids.length === ids.length &&
      messages[tail]?.role === "assistant" &&
      ids.every((id, i) => i === tail || id === prev.ids[i]);
    // Kept for the reply's lifetime: dropping the alias later would remount it on the next send.
    const aliases = new Map<string, string>();
    for (const id of ids) {
      const key = prev.aliases.get(id);
      if (key) aliases.set(id, key);
    }
    if (replacesPlaceholder) aliases.set(ids[tail]!, prev.keys[tail]!);
    state.current = { ids, keys: ids.map((id) => aliases.get(id) ?? id), aliases, optimisticTail: false };
  }
  state.current.optimisticTail = messages.at(-1)?.metadata.isOptimistic === true;
  return state.current;
};

/** `start`: first rendered index. `floor`: how far back slices reveal without a click. */
type MessageWindow = { firstId: string | undefined; length: number; start: number; floor: number };
const openWindow = (ids: readonly string[]): MessageWindow => ({
  firstId: ids[0],
  length: ids.length,
  start: Math.max(0, ids.length - FIRST_PAINT),
  floor: Math.max(0, ids.length - AUTO_REVEAL),
});

const WindowedMessages: FC<{ viewportRef: RefObject<HTMLDivElement | null> }> = ({ viewportRef }) => {
  const { ids, keys } = useMessageIds();
  const [stored, setWindow] = useState(() => openWindow(ids));
  // Another thread or branch: start over from its newest messages. New messages at the end keep the window.
  // A shorter list with the same first id is another branch too (a fork keeps its source's message ids),
  // and its indices would otherwise point past its end.
  let win = stored;
  if (stored.firstId !== ids[0] || ids.length < stored.length) {
    win = openWindow(ids);
    setWindow(win);
  } else if (ids.length !== stored.length) {
    win = { ...stored, length: ids.length };
    setWindow(win);
  }
  const { start, floor } = win;

  // Distance from the bottom, taken just before older messages mount and restored after, so the
  // messages being read do not move. Browsers without scroll anchoring would otherwise jump.
  const fromBottom = useRef<number | null>(null);
  // User scrolling only: the restore below and the viewport's own autoscroll also fire scroll events.
  // Scroll events count while a finger or mouse button is down (scrollbar drags) or shortly after a
  // finger lifts (a fling keeps scrolling).
  const lastInput = useRef(0);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let touching = false;
    let touchEnded = 0;
    const input = () => {
      lastInput.current = performance.now();
    };
    const touchStart = () => {
      touching = true;
      input();
    };
    const touchEnd = () => {
      touching = false;
      touchEnded = performance.now();
      input();
    };
    let pressed = false;
    const pointerDown = (event: Event) => {
      if ((event as PointerEvent).pointerType !== "mouse") return;
      pressed = true;
      input();
    };
    const pointerUp = () => {
      if (pressed) input();
      pressed = false;
    };
    const scroll = () => {
      if (touching || pressed || performance.now() - touchEnded < 1000) input();
    };
    const listeners: Array<[string, (event: Event) => void]> = [
      ["pointerdown", pointerDown],
      ["wheel", input],
      ["keydown", input],
      ["touchstart", touchStart],
      ["touchmove", input],
      ["touchend", touchEnd],
      ["touchcancel", touchEnd],
      ["scroll", scroll],
    ];
    for (const [type, listener] of listeners) viewport.addEventListener(type, listener, { passive: true });
    window.addEventListener("pointerup", pointerUp, { passive: true });
    return () => {
      for (const [type, listener] of listeners) viewport.removeEventListener(type, listener);
      window.removeEventListener("pointerup", pointerUp);
    };
  }, [viewportRef]);

  useEffect(() => {
    if (start <= floor) return;
    let timer = 0;
    const reveal = () => {
      // Setting scrollTop mid-gesture would stop a touch fling, so wait for scrolling to settle.
      if (performance.now() - lastInput.current < 150) {
        timer = window.setTimeout(reveal, 150);
        return;
      }
      const viewport = viewportRef.current;
      fromBottom.current = viewport ? viewport.scrollHeight - viewport.scrollTop : null;
      setWindow((w) => ({ ...w, start: Math.max(w.floor, w.start - REVEAL_STEP) }));
    };
    // After the next paint, so each slice follows a frame the user already sees.
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(reveal, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [start, floor, viewportRef]);

  // The last reveal removes the button; keyboard focus continues at the next control, not the body.
  const slotRef = useRef<HTMLSpanElement>(null);
  const focusedRef = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const distance = fromBottom.current;
    fromBottom.current = null;
    if (viewport && distance !== null) viewport.scrollTo({ top: viewport.scrollHeight - distance, behavior: "instant" });
    const slot = slotRef.current;
    const focused = focusedRef.current;
    if (start > 0 || !focused || focused.isConnected || !slot) return;
    focusedRef.current = null;
    const active = document.activeElement;
    if (!active || active === document.body) nextFocusable(slot)?.focus();
  }, [start, viewportRef]);

  // Nothing at all for a new chat, so the group's `empty:hidden` drops its margin under the welcome line.
  if (!ids.length) return null;
  return (
    <>
      <span
        ref={slotRef}
        className="contents"
        onFocus={(event) => {
          focusedRef.current = event.target;
        }}
      >
        {start > 0 && (
          <ShowEarlierMessages
            loading={start > floor}
            hidden={start}
            onShow={() => setWindow((w) => ({ ...w, floor: Math.max(0, w.floor - MANUAL_REVEAL) }))}
          />
        )}
      </span>
      {keys.slice(start).map((key, i) => (
        <ThreadPrimitive.MessageByIndex key={key} index={start + i} components={MESSAGE_COMPONENTS} />
      ))}
    </>
  );
};

const ShowEarlierMessages: FC<{ loading: boolean; hidden: number; onShow: () => void }> = ({ loading, hidden, onShow }) => (
  <Button
    variant="ghost"
    size="sm"
    data-slot="aui_thread-show-earlier"
    aria-disabled={loading}
    className="text-muted-foreground self-center rounded-full"
    onClick={() => {
      if (!loading) onShow();
    }}
  >
    <span className={cn(loading && "shimmer motion-reduce:animate-none")}>
      {loading ? t("thread.loadingEarlier") : t("thread.showEarlier", { count: hidden })}
    </span>
  </Button>
);

type VoiceRunPosition = "single" | "start" | "middle" | "end";

const useVoiceRunPosition = (): VoiceRunPosition =>
  useAuiState((s) => {
    const before =
      s.thread.messages[s.message.index - 1]?.metadata.modality === "voice";
    const after =
      s.thread.messages[s.message.index + 1]?.metadata.modality === "voice";
    if (before) return after ? "middle" : "end";
    return after ? "start" : "single";
  });

const SpokenText: TextMessagePartComponent = ({ text }) => (
  <p className="aui-spoken-message-text m-0">{text}</p>
);

const SpokenMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const position = useVoiceRunPosition();
  const isSpeaking = useAuiState(
    (s) =>
      s.message.role === "assistant" && s.message.status?.type === "running",
  );
  const opensExchange = position === "start" || position === "single";

  return (
    <MessagePrimitive.Root
      data-slot="aui_spoken-message-root"
      data-role={role}
      data-voice-run={position}
      className={cn(
        "aui-spoken-message bg-muted/40 mx-2 px-3 py-1.5 [contain-intrinsic-size:auto_48px] [content-visibility:auto]",
        position === "single" && "rounded-xl py-2",
        position === "start" && "rounded-t-xl pt-2",
        position === "middle" && "-mt-6",
        position === "end" && "-mt-6 rounded-b-xl pb-2",
      )}
    >
      {opensExchange && (
        <div
          data-slot="aui_spoken-exchange-header"
          className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs"
        >
          <PhoneIcon className="size-3" aria-hidden />
          <span>{t("thread.voiceConversation")}</span>
        </div>
      )}
      <div
        data-slot="aui_spoken-message-content"
        className="text-foreground flex items-start gap-2 text-sm leading-relaxed"
      >
        <span className="text-muted-foreground mt-1 shrink-0" aria-hidden>
          {role === "user" ? (
            <MicIcon className="size-3.5" />
          ) : (
            <AudioLinesIcon className="size-3.5" />
          )}
        </span>
        <span className="sr-only">
          {role === "user" ? t("thread.youSaid") : t("thread.assistantSaid")}
        </span>
        <div className="min-w-0 flex-1 wrap-break-word">
          <MessagePrimitive.Parts components={{ Text: SpokenText }} />
          {isSpeaking && (
            <span
              data-slot="aui_spoken-message-indicator"
              role="status"
              className="text-muted-foreground ms-1 animate-pulse font-sans"
              aria-label={t("thread.assistantSpeaking")}
            >
              ●
            </span>
          )}
        </div>
        <SpokenActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const SpokenActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="always"
      className="aui-spoken-action-bar text-muted-foreground animate-fade-in flex shrink-0 gap-1 [animation-delay:80ms]"
    >
      <CopyActionButton className="size-6" />
    </ActionBarPrimitive.Root>
  );
};

const FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1']):not([disabled])";

const nextFocusable = (start: Element) => {
  for (
    let element = start.nextElementSibling;
    element;
    element = element.nextElementSibling
  ) {
    const target = element.matches(FOCUSABLE_SELECTOR)
      ? element
      : element.querySelector(FOCUSABLE_SELECTOR);
    if (target instanceof HTMLElement) return target;
  }
  return null;
};

const ThreadLoadEarlier: FC = () => {
  const visible = useAuiState(
    (s) => s.thread.hasEarlier || s.thread.isLoadingEarlier,
  );
  const loading = useAuiState((s) => s.thread.isLoadingEarlier);
  const slotRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef<Element | null>(null);

  // The last page removes the button; a keyboard user on it continues from the
  // next control in tab order rather than from the document body.
  useLayoutEffect(() => {
    const focused = focusedRef.current;
    const slot = slotRef.current;
    if (visible || !focused || focused.isConnected || !slot) return;
    focusedRef.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    nextFocusable(slot)?.focus();
  }, [visible]);

  return (
    <div
      ref={slotRef}
      className="contents"
      onFocus={(event) => {
        focusedRef.current = event.target;
      }}
    >
      <span role="status" className="sr-only">
        {loading ? t("thread.loadingEarlier") : ""}
      </span>
      {visible && (
        <ThreadPrimitive.LoadEarlier asChild>
          <Button
            variant="ghost"
            size="sm"
            data-slot="aui_thread-load-earlier"
            className="aui-thread-load-earlier text-muted-foreground mb-6 self-center rounded-full"
          >
            <span
              className={cn(loading && "shimmer motion-reduce:animate-none")}
            >
              {loading ? t("thread.loadingEarlier") : t("thread.loadEarlier")}
            </span>
          </Button>
        </ThreadPrimitive.LoadEarlier>
      )}
    </div>
  );
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip={t("thread.scrollToBottom")}
        command="chat.scrollBottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 transition-[opacity,translate] duration-(--motion-base) ease-out-quart disabled:pointer-events-none disabled:translate-y-2 disabled:opacity-0 disabled:duration-(--motion-fast) disabled:ease-in-quart"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col px-2">
      <p className="aui-thread-welcome-message-inner animate-rise-in text-2xl font-medium tracking-tight">
        {t("thread.welcome")}
      </p>
    </div>
  );
};

const ThreadSuggestions: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-col">
      <ThreadPrimitive.Suggestions>
        {() => <ThreadSuggestionItem />}
      </ThreadPrimitive.Suggestions>
    </div>
  );
};

const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display animate-rise-in">
      <SuggestionPrimitive.Trigger send asChild>
        <button
          type="button"
          className="aui-thread-welcome-suggestion group hover:bg-foreground/[0.03] focus-visible:ring-ring/50 flex w-full items-baseline gap-2.5 rounded-md px-2 py-2 text-start text-sm transition-[color,background-color,scale] duration-(--motion-fast) ease-out-quart outline-none focus-visible:ring-1 active:scale-[0.98] motion-reduce:transition-none"
        >
          <span
            aria-hidden
            className="text-muted-foreground/60 group-hover:text-foreground font-mono text-xs transition-colors motion-reduce:transition-none"
          >
            {">"}
          </span>
          <span className="min-w-0 flex-1 truncate">
            <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1 text-foreground" />{" "}
            <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 text-muted-foreground empty:hidden" />
          </span>
        </button>
      </SuggestionPrimitive.Trigger>
    </div>
  );
};

// Touch devices open the keyboard on focus, which would cover half the screen on every chat switch.
const finePointer = typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches;

/** Keyboard settings choose Enter or Ctrl/⌘+Enter to send; the other key types a new line. */
const useSubmitMode = () =>
  useData((s) => s.settings?.keyboard?.sendWith) === "modEnter" ? "ctrlEnter" : "enter";

/** Shown while a cached copy stays on screen because the server's rows could not replace it; sending stays off until a reload. */
const SyncNotice: FC<{ sync: ThreadSync | undefined }> = ({ sync }) =>
  sync === "stale" ? (
    <div role="status" className="text-muted-foreground flex items-center gap-1.5 px-2.5 text-xs">
      <CloudOffIcon className="size-3.5 shrink-0" />
      <span className="truncate">{t("thread.syncStale")}</span>
    </div>
  ) : null;

const Composer: FC<{ autoFocus: boolean }> = ({ autoFocus }) => {
  // Until the server's rows replace a cached paint, a send would attach the reply to whatever the cache showed.
  const sync = useThreadSync();
  const submitMode = useSubmitMode();
  const researching = useChatResearch().enabled;
  // The composer sits on the bottom edge, so it grows upward with the typed line held in place.
  const smoothHeight = useSmoothHeight({ pin: "bottom" });
  const longPaste = useLongPaste();
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          ref={smoothHeight}
          data-slot="aui_composer-shell"
          className="depth-composer data-[dragging=true]:border-ring flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) [backdrop-filter:blur(var(--glass-blur))_saturate(var(--glass-saturation))] transition-[border-color,box-shadow] duration-(--motion-base) ease-out-quart data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
        >
          <ComposerAttachments />
          {longPaste.notice}
          <ComposerPrimitive.Input
            {...longPaste.inputProps}
            placeholder={researching ? t("thread.researchPlaceholder") : t("thread.messagePlaceholder")}
            className="aui-composer-input caret-primary placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none"
            rows={1}
            submitMode={sync ? "none" : submitMode}
            autoFocus={autoFocus && finePointer}
            enterKeyHint="send"
            aria-label={t("thread.messageInput")}
          />
          <SyncNotice sync={sync} />
          <VoiceNotice />
          <SpeechServiceHint />
          <ComposerAction blocked={!!sync} />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
      <DictationSend />
      <ReadAloudAutoPlay />
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC<{ blocked: boolean }> = ({ blocked }) => {
  // The stop control only cancels the send while no run it could stop is going.
  const isSending = useAuiState(
    (s) =>
      s.composer.submission !== undefined &&
      !(s.thread.isRunning && s.thread.capabilities.cancel),
  );
  const canCancel = useAuiState((s) => s.composer.canCancel);
  const hasVoice = useAuiState((s) => s.thread.voice !== undefined);
  const submitting = useAuiState((s) => s.composer.submission !== undefined);
  const showSend = !canCancel || (hasVoice && !submitting);
  const showStop = canCancel && (!hasVoice || submitting);

  const dictating = useAuiState((s) => s.composer.dictation != null);
  // While dictating, send stays available even with an empty composer: it stops, then sends the transcript.
  const canSendDictation = useAuiState(
    (s) => !s.thread.isDisabled && s.composer.submission === undefined && !(s.thread.isRunning && !s.thread.capabilities.queue),
  );
  const sendPending = useSpeech((s) => s.sendAfterDictation);
  const sendDictation = useSendDictation();

  const { ComposerToolbar } = useContext(ThreadComponentsContext);
  const dictateLabel = useDictateLabel();
  // The local engine needs the speech worker. The button stays visible and disabled with the note below
  // the composer, so the user sees why and can pick another engine.
  const dictationUnavailable = useLocalSpeechUnavailable("stt");

  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <ComposerAddAttachment className="max-sm:hidden pointer-coarse:hidden" />
        {ComposerToolbar && <ComposerToolbar />}
      </div>
      <div className="flex items-center gap-1.5">
        <CallButton />
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip={dictationUnavailable ? t("services.dictationUnavailable") : dictateLabel}
                command="composer.dictate"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                disabled={dictationUnavailable}
                aria-describedby={dictationUnavailable ? "speech-service-availability" : undefined}
                className="aui-composer-dictate text-muted-foreground hover:text-foreground size-7 pointer-coarse:size-9 rounded-full"
                aria-label={t("thread.startVoiceInput")}
              >
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <DictationWaveform className="h-6 w-20 sm:w-28" />
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton
                tooltip={t("thread.stopDictation")}
                command="composer.dictate"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-stop-dictation text-destructive size-7 pointer-coarse:size-9 rounded-full"
                aria-label={t("thread.stopVoiceInput")}
              >
                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
              </TooltipIconButton>
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        {/* One slot for both controls: they swap with a crossfade and a scale
            rather than the button cutting in place. */}
        <span className="relative size-7 pointer-coarse:size-9 shrink-0">
          <span
            inert={!showSend}
            className={cn(
              "absolute inset-0 transition-[opacity,scale]",
              showSend
                ? "scale-100 opacity-100 duration-(--motion-base) ease-out-quart"
                : // Held for a beat so the arrow's launch (icons.css) is seen before the stop control takes over.
                  "pointer-events-none scale-50 opacity-0 delay-150 duration-(--motion-fast) ease-in-quart",
            )}
          >
            {dictating ? (
              <TooltipIconButton
                tooltip={t("thread.sendRecording")}
                side="bottom"
                type="button"
                variant="default"
                size="icon"
                disabled={!canSendDictation || sendPending || blocked}
                onClick={sendDictation}
                className="aui-composer-send size-7 pointer-coarse:size-9 rounded-[0.6rem] pointer-coarse:rounded-xl disabled:scale-[0.86] disabled:saturate-[0.4]"
                aria-label={t("thread.stopRecordingAndSend")}
              >
                <ArrowUpIcon className="aui-composer-send-icon size-4" />
              </TooltipIconButton>
            ) : blocked ? (
              <TooltipIconButton
                tooltip={t("thread.loadingLatest")}
                side="bottom"
                type="button"
                variant="default"
                size="icon"
                disabled
                className="aui-composer-send size-7 pointer-coarse:size-9 rounded-[0.6rem] pointer-coarse:rounded-xl disabled:scale-[0.86] disabled:saturate-[0.4]"
                aria-label={t("thread.sendMessage")}
              >
                <ArrowUpIcon className="aui-composer-send-icon size-4" />
              </TooltipIconButton>
            ) : (
              <ComposerPrimitive.Send asChild>
                <TooltipIconButton
                  tooltip={t("thread.sendMessage")}
                  side="bottom"
                  type="button"
                  variant="default"
                  size="icon"
                  // Empty composer: the button sits back, then springs forward once there is something to send.
                  className="aui-composer-send size-7 pointer-coarse:size-9 rounded-[0.6rem] pointer-coarse:rounded-xl disabled:scale-[0.86] disabled:saturate-[0.4]"
                  aria-label={t("thread.sendMessage")}
                >
                  <ArrowUpIcon className="aui-composer-send-icon size-4" />
                </TooltipIconButton>
              </ComposerPrimitive.Send>
            )}
          </span>
          <span
            inert={!showStop}
            className={cn(
              "absolute inset-0 transition-[opacity,scale]",
              showStop
                ? "scale-100 opacity-100 duration-(--motion-base) ease-out-quart"
                : "pointer-events-none scale-50 opacity-0 duration-(--motion-fast) ease-in-quart",
            )}
          >
            <ComposerPrimitive.Cancel asChild>
              <Button
                type="button"
                variant="default"
                size="icon"
                className="aui-composer-cancel size-7 pointer-coarse:size-9 rounded-[0.6rem] pointer-coarse:rounded-xl"
                aria-label={isSending ? t("thread.cancelSending") : t("thread.stopGenerating")}
              >
                <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
              </Button>
            </ComposerPrimitive.Cancel>
          </span>
        </span>
      </div>
    </div>
  );
};

const MessageError: FC = () => <ChatErrorMessage />;

/**
 * Waiting for the first token, and any gap after a tool call: the dots fade in
 * and out around the text instead of appearing and vanishing between frames.
 */
const StreamingIndicator: FC<{ waiting: boolean }> = ({ waiting }) => {
  const [visible, setVisible] = useState(waiting);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (waiting) {
      setVisible(true);
      setLeaving(false);
      return undefined;
    }
    if (!visible) return undefined;
    setLeaving(true);
    const timeout = setTimeout(() => {
      setVisible(false);
      setLeaving(false);
    }, 120);
    return () => clearTimeout(timeout);
  }, [waiting, visible]);

  if (!visible) return null;
  return (
    <span
      data-slot="aui_assistant-message-indicator"
      role="status"
      aria-label={t("thread.assistantWorking")}
      className={cn(
        // Out of flow: removing it would shrink a short reply at the bottom of the scroller, which clamps
        // the scroll position before the top-anchor reserve can grow, so the whole chat drops for a moment.
        "absolute mt-1 ms-1 inline-flex items-center gap-1",
        leaving ? "chat-wait-out" : "chat-wait-in",
      )}
    >
      <span className="bg-muted-foreground/70 size-1.5 animate-pulse-soft rounded-full" />
      <span className="bg-muted-foreground/70 size-1.5 animate-pulse-soft rounded-full [animation-delay:160ms]" />
      <span className="bg-muted-foreground/70 size-1.5 animate-pulse-soft rounded-full [animation-delay:320ms]" />
    </span>
  );
};

/** A folded work-log row still shows the advisory when any result in it was flagged. */
const groupHasInjection = (parts: readonly GroupablePart[], indices: readonly number[]) =>
  indices.some((index) => {
    const part = parts[index];
    return part?.type === "tool-call" && toolInjection(part.result) !== undefined;
  });

/** "Searched twice, read 3 pages, and used 2 tools · 41s", like a work log summary. */
const workLabel = (
  parts: readonly GroupablePart[],
  indices: readonly number[],
  timing: ThreadGroupPart["timing"],
) => {
  const counts = new Map<string, number>();
  for (const i of indices) {
    const part = parts[i];
    if (part?.type !== "tool-call") continue;
    const kind =
      part.toolName === "web_search" ? "search" : part.toolName === "web_fetch" ? "read" : "tool";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const searches = counts.get("search");
  const reads = counts.get("read");
  const tools = counts.get("tool");
  const phrases = [
    searches ? t("thread.workSearched", { count: searches }) : "",
    reads ? t("thread.workRead", { count: reads }) : "",
    tools ? t("thread.workUsed", { count: tools }) : "",
  ].filter(Boolean);
  const text = phrases.length > 0 ? formatList(phrases) : t("thread.workWorked");
  const summary = `${text.charAt(0).toLocaleUpperCase(currentLocale())}${text.slice(1)}`;
  const seconds = reasoningDuration(timing);
  return seconds ? t("thread.workWithTime", { summary, time: formatDuration(seconds) }) : summary;
};

/**
 * One reasoning block as a work-log row: its first line, expanding to the full
 * text. It stays open while it streams and folds to one line when it ends.
 */
const ReasoningRow: FC<{ text: string; running: boolean }> = ({ text, running }) => {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? running;
  const firstLine =
    text
      .split("\n")
      .map((line) => line.replace(/[#>*_`]/g, "").trim())
      .find(Boolean) ?? "";
  return (
    <div className="my-1.5 text-sm">
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        className="text-muted-foreground hover:text-foreground flex w-full max-w-full items-center gap-2 text-start transition-colors duration-(--motion-fast) ease-out-quart"
      >
        <BrainIcon className="size-4 shrink-0" />
        <span className={cn("min-w-0 truncate", running && "shimmer")}>
          {open || !firstLine ? (running ? t("thread.thinking") : t("thread.thought")) : firstLine}
        </span>
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-(--motion-base) ease-out-expo",
            !open && "-rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="text-muted-foreground border-border animate-rise-in ms-2 mt-1 border-s ps-4">
          <MarkdownText />
        </div>
      )}
    </div>
  );
};

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
    TaskGroup: TaskGroupComponent,
    MessageMeta,
  } = useContext(ThreadComponentsContext);
  const baseGroupBy = TaskGroupComponent ? taskAwareMcpGroupBy : messageMcpGroupBy;
  const parts = useAuiState((s) => s.message.parts);
  // Live replies show every step; a finished one shows only its outcome. An open editor must show every
  // part, because text written between tool calls is editable too.
  const finished = useAuiState((s) => s.message.status?.type === "complete");
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const messageId = useAuiState((s) => s.message.id);
  const editing = useMessageEdits((s) => !!remoteId && s.editing === editKey(remoteId, messageId));
  const groupBy = useMemo(
    () => (finished && !editing ? foldWork(baseGroupBy, parts) : baseGroupBy),
    [finished, editing, baseGroupBy, parts],
  );
  const entering = useContext(MessageEnteringContext);
  const waitingForFirstToken = useAuiState((s) => {
    if (s.message.status?.type !== "running") return false;
    const last = s.message.parts.at(-1);
    return last === undefined || (last.type !== "text" && last.type !== "reasoning");
  });

  const ACTION_BAR_PT = "pt-1.5";
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;

  const focus = useMessageFocus();

  return (
    <MessagePrimitive.Root
      {...focus}
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className={cn(
        "relative -mb-7.5 pb-7.5 [contain-intrinsic-size:auto_200px] [content-visibility:auto] rounded-xl outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring/60",
        entering && "chat-message-in-soft",
      )}
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground px-2 leading-relaxed wrap-break-word"
      >
        <ReplyEditorShell active={editing} threadId={remoteId ?? ""} messageId={messageId} parts={parts}>
        <MessagePrimitive.GroupedParts groupBy={groupBy} indicator="never">
          {({ part, children }) => {
            switch (part.type) {
              case "group-work":
                return (
                  <ToolGroupRoot variant="ghost">
                    <ToolGroupTrigger
                      count={part.indices.length}
                      warning={groupHasInjection(parts, part.indices)}
                      label={workLabel(parts, part.indices, part.timing)}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-chainOfThought": {
                // Reasoning alone needs no wrapper: each block is already a row.
                if (!part.indices.some((i) => parts[i]?.type === "tool-call")) {
                  return children;
                }
                const running = part.status.type === "running";
                return (
                  // Open while it works, and when a call waits for approval.
                  <ToolGroupRoot
                    variant="ghost"
                    open={running || part.counts.requiresAction > 0 ? true : undefined}
                  >
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={running}
                      warning={groupHasInjection(parts, part.indices)}
                      label={workLabel(parts, part.indices, part.timing)}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              }
              case "group-task":
                return TaskGroupComponent ? (
                  <TaskGroupComponent group={part} />
                ) : null;
              case "group-tool":
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                return (
                  // A call waiting for approval must be visible, so the group opens itself.
                  <ToolGroupRoot variant="ghost" open={part.status.type === "requires-action" ? true : undefined}>
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={part.status.type === "running"}
                      warning={groupHasInjection(parts, part.indices)}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-reasoning": {
                if (ReasoningGroup) {
                  return (
                    <ReasoningGroup group={part}>{children}</ReasoningGroup>
                  );
                }
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running}>
                    <ReasoningTrigger
                      active={running}
                      duration={reasoningDuration(part.timing)}
                    />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text":
                // The editor shows all text parts below the tools, so each section keeps its own field.
                return editing ? null : <MarkdownText />;
              case "reasoning":
                return (
                  <ReasoningRow
                    text={part.text}
                    running={part.status.type === "running"}
                  />
                );
              case "tool-call":
                // Email cards show the reviewed payload; the existing fallback supplies their
                // Allow/Deny controls. Other custom tools retain their own approval UI.
                return part.toolUI ? (
                  <>
                    {part.toolUI}
                    {part.approval && (part.toolName === "email_send" || part.toolName === "email_reply") ? <ToolFallback.Approval {...part} /> : null}
                  </>
                ) : (
                  <ToolFallbackComponent {...part} />
                );
              case "data":
                return part.dataRendererUI;
              case "file":
                return (
                  <div data-slot="aui_assistant-message-file" className="py-1">
                    <MessageFile {...part} />
                  </div>
                );
              case "image":
                return (
                  <div data-slot="aui_assistant-message-image" className="py-1">
                    <Image {...part} />
                  </div>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        {editing && <EditableReplyTexts />}
        {finished && <ReplyFiles parts={parts} verify={!entering} />}
        {finished && <TurnServiceNote />}
        <StreamingIndicator waiting={waitingForFirstToken} />
        <MessageError />
        {editing ? <ReplyEditorFooter /> : <EditedReplyBadge />}
        </ReplyEditorShell>
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        {!editing && <BranchPicker />}
        {!editing && <AssistantActionBar />}
        {MessageMeta && <MessageMeta />}
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  const { BranchAction } = useContext(ThreadComponentsContext);
  // Like the composer: a rerun from a cached copy would parent on what the cache showed.
  const sync = useThreadSync();
  // A local server voice is disabled while the worker is down; StopSpeaking is never disabled, so an
  // active playback can always be stopped.
  const readAloudUnavailable = useLocalSpeechUnavailable("tts");
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      // Mounted on hover: a short delay keeps a passing cursor from flashing it.
      className="aui-assistant-action-bar-root text-muted-foreground animate-fade-in col-start-3 row-start-2 -ms-1 flex shrink-0 gap-1 max-sm:gap-0 [animation-delay:80ms]"
    >
      <CopyActionButton />
      <ReplyEditAction />
      {BranchAction && <BranchAction />}
      <ActionBarPrimitive.Reload asChild disabled={!!sync}>
        <TooltipIconButton tooltip={t("common.retry")} command="message.retry">
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <RetryWithModel />
      <AuiIf condition={(s) => s.thread.capabilities.feedback}>
        <ActionBarPrimitive.FeedbackPositive asChild>
          <TooltipIconButton
            tooltip={t("thread.helpful")}
            className="data-[submitted=true]:bg-accent data-[submitted=true]:text-accent-foreground"
          >
            <ThumbsUpIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.FeedbackPositive>
        <ActionBarPrimitive.FeedbackNegative asChild>
          <TooltipIconButton
            tooltip={t("thread.notHelpful")}
            className="data-[submitted=true]:bg-accent data-[submitted=true]:text-accent-foreground"
          >
            <ThumbsDownIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.FeedbackNegative>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.capabilities.speech}>
        <AuiIf condition={(s) => s.message.speech == null}>
          <ActionBarPrimitive.Speak asChild disabled={readAloudUnavailable}>
            <TooltipIconButton
              tooltip={readAloudUnavailable ? t("services.readAloudUnavailable") : t("thread.readAloud")}
              command="message.readAloud"
              aria-describedby={readAloudUnavailable ? "speech-service-availability" : undefined}
            >
              <Volume2Icon />
            </TooltipIconButton>
          </ActionBarPrimitive.Speak>
        </AuiIf>
        <AuiIf condition={(s) => s.message.speech != null}>
          <ActionBarPrimitive.StopSpeaking asChild>
            <TooltipIconButton tooltip={t("thread.stopReading")} command="message.readAloud">
              <VolumeXIcon />
            </TooltipIconButton>
          </ActionBarPrimitive.StopSpeaking>
        </AuiIf>
      </AuiIf>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip={t("common.more")}
            command="message.more"
            className="data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors duration-(--motion-fast) ease-out-quart select-none">
              <DownloadIcon className="size-4" />
              {t("thread.exportMarkdown")}
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const MessageFile: FileMessagePartComponent = (part) => {
  const image = part.mimeType.toLowerCase().startsWith("image/")
    ? getFileHref(part.data, part.mimeType, part.sourceType)
    : null;
  if (!image) return <File {...part} />;
  return (
    <Image
      type="image"
      image={image}
      status={part.status}
      {...(part.filename !== undefined && { filename: part.filename })}
    />
  );
};

const UserFilePart: FileMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-file" className="py-1">
    <MessageFile {...part} />
  </div>
);

const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className="py-1">
    <Image {...part} />
  </div>
);

/** Typed text renders as Markdown; attachment parts render as tiles above the bubble instead. */
const UserText: TextMessagePartComponent = ({ text }) =>
  parseAttachmentText(text) ? null : <MarkdownText lineBreaks />;

const UserMessage: FC = () => {
  const entering = useContext(MessageEnteringContext);
  const focus = useMessageFocus();
  return (
    <MessagePrimitive.Root
      {...focus}
      data-slot="aui_user-message-root"
      className={cn(
        // Inset the measured anchor without changing message spacing. The
        // reserve stops short turns below the mobile header's 5rem fade.
        // Negative margin preserves the spacing between messages. The reserve
        // overlaps the previous assistant footer, so only children take the pointer.
        // The root carries a tall top reserve, so focus is drawn on the bubble instead.
        "outline-none focus-visible:[&_.aui-user-message-content]:outline-2 focus-visible:[&_.aui-user-message-content]:outline-offset-2 focus-visible:[&_.aui-user-message-content]:outline-ring/60",
        "pointer-events-none [&>*]:pointer-events-auto -mt-24 grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 pt-24 md:-mt-[3em] md:pt-[3em] [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2",
        // Sent messages come up from the composer they left.
        entering && "chat-message-in",
      )}
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer depth-bubble text-foreground rounded-(--composer-radius) rounded-ee-md px-4 py-2 wrap-break-word empty:hidden">
          <MessagePrimitive.Parts
            components={{ Text: UserText, File: UserFilePart, Image: UserImagePart }}
          />
        </div>
      </div>

      <div
        data-slot="aui_user-message-footer"
        // Fixed height: the bar mounts on hover and must not push the next message.
        className="col-span-full col-start-1 -mt-1 -me-1 flex min-h-7 items-center justify-end"
      >
        <BranchPicker data-slot="aui_user-branch-picker" />
        <UserActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

/** Answers this user message again in the same chat; the old answer stays as a sibling branch. */
const UserRetryButton: FC = () => {
  const aui = useAui();
  const sync = useThreadSync();
  return (
    <TooltipIconButton
      tooltip={t("common.retry")}
      command="message.retry"
      disabled={!!sync}
      onClick={() => aui.thread.startRun({ parentId: aui.message.getState().id })}
    >
      <RefreshCwIcon />
    </TooltipIconButton>
  );
};

const UserActionBar: FC = () => {
  const { BranchAction } = useContext(ThreadComponentsContext);
  const sync = useThreadSync();
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root text-muted-foreground animate-fade-in flex gap-1 [animation-delay:80ms]"
    >
      <UserRetryButton />
      {BranchAction && <BranchAction />}
      <ActionBarPrimitive.Edit asChild disabled={!!sync}>
        <TooltipIconButton tooltip={t("common.edit")} command="message.edit" className="aui-user-action-edit">
          <SquarePenIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
      <UserCopyButton />
    </ActionBarPrimitive.Root>
  );
};

/** Copies only what the user typed; the built-in copy would include every attachment's full text. */
const UserCopyButton: FC = () => {
  const content = useAuiState((s) => s.message.content);
  const text = useMemo(() => typedText(content as Parameters<typeof typedText>[0]), [content]);
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  if (!text) return null;
  return (
    <TooltipIconButton tooltip={t("common.copy")} command="message.copy" onClick={() => copyToClipboard(text)}>
      <CopyFeedbackIcon copied={isCopied} />
    </TooltipIconButton>
  );
};

/**
 * The edit composer starts with every text part joined, attachment markup included, and drops text attachments
 * on send. Restores the typed text and turns attachment parts back into attachments, which resend unchanged.
 */
const EditComposerRestore: FC = () => {
  const aui = useAui();
  // Once per edit: StrictMode re-runs effects, and a second pass would add every attachment twice.
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const message = aui.message.getState();
    if (message.role !== "user") return;
    const content = message.content as Parameters<typeof splitUserMessage>[0];
    if (!content.some((part) => part.type === "text" && parseAttachmentText(part.text))) return;
    const { text, attachments } = splitUserMessage(content, message.attachments);
    aui.composer.setText(text);
    void aui.composer.clearAttachments().then(() =>
      Promise.all(attachments.map((attachment) => aui.composer.addAttachment(attachment))),
    );
  }, [aui]);
  return null;
};

const EditComposer: FC = () => {
  // An edit opened before a sync fell back to stale must not save either.
  const sync = useThreadSync();
  const submitMode = useSubmitMode();
  const longPaste = useLongPaste();
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="chat-edit-in flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root depth-composer ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--composer-radius) border bg-(--composer-bg) transition-[border-color,box-shadow] duration-(--motion-base) ease-out-quart">
        <EditComposerRestore />
        <div className="px-2.5 pt-2.5 has-[>.aui-composer-attachments:empty]:hidden">
          <ComposerAttachments />
        </div>
        {longPaste.notice && <div className="px-1.5 pt-2">{longPaste.notice}</div>}
        <ComposerPrimitive.Input
          {...longPaste.inputProps}
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          submitMode={sync ? "none" : submitMode}
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-8 px-3">
              {t("common.cancel")}
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild disabled={!!sync}>
            <Button size="sm" className="h-8 px-3">
              {t("thread.update")}
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        // Appears only once a message has siblings; ease it in like the actions.
        "aui-branch-picker-root text-muted-foreground animate-fade-in -ms-2 me-2 inline-flex shrink-0 items-center text-xs [animation-delay:80ms]",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip={t("common.previous")}>
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium whitespace-nowrap">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip={t("common.next")}>
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
