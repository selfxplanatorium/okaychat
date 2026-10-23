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
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
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
  AudioLinesIcon,
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
  type PropsWithChildren,
} from "react";
import { CopyFeedbackIcon } from "@/components/assistant-ui/elements/surfaces";

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
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
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
  "tool-call:run_code": [],
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
 * (searches, reads, screenshots, sub-agents) are work, not results.
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
    case "run_code": {
      // Only a run that wrote files is a result; the server keeps the last one's files.
      const files = (part.result as { files?: unknown[] } | undefined)?.files;
      return files?.length ? "run_code" : undefined;
    }
    case "generate_image":
      return `image:${part.toolCallId}`;
    default:
      return undefined;
  }
};

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
    return keep.has(part) ? path : ["group-work", ...path];
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

const CopyActionButton: FC<{ className?: string }> = ({ className }) => {
  const copied = useAuiState((s) => s.message.isCopied);
  return (
    <ActionBarPrimitive.Copy asChild>
      <TooltipIconButton tooltip="Copy" className={className}>
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
    <span className="sr-only">Loading conversation</span>
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
              <ThreadPrimitive.Messages>
                {() => <ThreadMessage />}
              </ThreadPrimitive.Messages>
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
          <span>Voice conversation</span>
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
          {role === "user" ? "You said" : "Assistant said"}
        </span>
        <div className="min-w-0 flex-1 wrap-break-word">
          <MessagePrimitive.Parts components={{ Text: SpokenText }} />
          {isSpeaking && (
            <span
              data-slot="aui_spoken-message-indicator"
              role="status"
              className="text-muted-foreground ms-1 animate-pulse font-sans"
              aria-label="Assistant is speaking"
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
        {loading ? "Loading earlier messages" : ""}
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
              {loading ? "Loading earlier messages" : "Load earlier messages"}
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
        tooltip="Scroll to bottom"
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
        How can I help you today?
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

const Composer: FC<{ autoFocus: boolean }> = ({ autoFocus }) => {
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="aui_composer-shell"
          className="depth-composer data-[dragging=true]:border-ring flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) [backdrop-filter:blur(var(--glass-blur))_saturate(var(--glass-saturation))] transition-[border-color,box-shadow] duration-(--motion-base) ease-out-quart data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
        >
          <ComposerAttachments />
          <ComposerPrimitive.Input
            placeholder="Send a message..."
            className="aui-composer-input caret-primary placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none"
            rows={1}
            autoFocus={autoFocus && finePointer}
            enterKeyHint="send"
            aria-label="Message input"
          />
          <ComposerAction />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC = () => {
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

  const { ComposerToolbar } = useContext(ThreadComponentsContext);

  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <ComposerAddAttachment className="max-sm:hidden pointer-coarse:hidden" />
        {ComposerToolbar && <ComposerToolbar />}
      </div>
      <div className="flex items-center gap-1.5">
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip="Voice input"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-dictate text-muted-foreground hover:text-foreground size-7 pointer-coarse:size-9 rounded-full"
                aria-label="Start voice input"
              >
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton
                tooltip="Stop dictation"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-stop-dictation text-destructive size-7 pointer-coarse:size-9 rounded-full"
                aria-label="Stop voice input"
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
            <ComposerPrimitive.Send asChild>
              <TooltipIconButton
                tooltip="Send message"
                side="bottom"
                type="button"
                variant="default"
                size="icon"
                // Empty composer: the button sits back, then springs forward once there is something to send.
                className="aui-composer-send size-7 pointer-coarse:size-9 rounded-[0.6rem] pointer-coarse:rounded-xl disabled:scale-[0.86] disabled:saturate-[0.4]"
                aria-label="Send message"
              >
                <ArrowUpIcon className="aui-composer-send-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Send>
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
                aria-label={isSending ? "Cancel sending" : "Stop generating"}
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

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive animate-rise-in dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm transition-colors dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

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
      aria-label="Assistant is working"
      className={cn(
        "mt-1 ms-1 inline-flex items-center gap-1",
        leaving ? "chat-wait-out" : "chat-wait-in",
      )}
    >
      <span className="bg-muted-foreground/70 size-1.5 animate-pulse-soft rounded-full" />
      <span className="bg-muted-foreground/70 size-1.5 animate-pulse-soft rounded-full [animation-delay:160ms]" />
      <span className="bg-muted-foreground/70 size-1.5 animate-pulse-soft rounded-full [animation-delay:320ms]" />
    </span>
  );
};

const workLabel = (
  parts: readonly GroupablePart[],
  indices: readonly number[],
) => {
  const steps = indices.filter((i) => parts[i]?.type === "tool-call").length;
  return steps ? `Worked in ${steps} ${steps === 1 ? "step" : "steps"}` : "Show work";
};

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
    TaskGroup: TaskGroupComponent,
    MessageMeta,
  } = useContext(ThreadComponentsContext);
  const baseGroupBy = TaskGroupComponent ? taskAwareGroupBy : messageGroupBy;
  const parts = useAuiState((s) => s.message.parts);
  // Live replies show every step; a finished one shows only its outcome.
  const finished = useAuiState((s) => s.message.status?.type === "complete");
  const groupBy = useMemo(
    () => (finished ? foldWork(baseGroupBy, parts) : baseGroupBy),
    [finished, baseGroupBy, parts],
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

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className={cn(
        "relative -mb-7.5 pb-7.5 [contain-intrinsic-size:auto_200px] [content-visibility:auto]",
        entering && "chat-message-in-soft",
      )}
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground px-2 leading-relaxed wrap-break-word"
      >
        <MessagePrimitive.GroupedParts groupBy={groupBy} indicator="never">
          {({ part, children }) => {
            switch (part.type) {
              case "group-work":
                return (
                  <ToolGroupRoot variant="ghost">
                    <ToolGroupTrigger
                      count={part.indices.length}
                      label={workLabel(parts, part.indices)}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
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
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
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
        <StreamingIndicator waiting={waitingForFirstToken} />
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <BranchPicker />
        <AssistantActionBar />
        {MessageMeta && <MessageMeta />}
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  const { BranchAction } = useContext(ThreadComponentsContext);
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      // Mounted on hover: a short delay keeps a passing cursor from flashing it.
      className="aui-assistant-action-bar-root text-muted-foreground animate-fade-in col-start-3 row-start-2 -ms-1 flex shrink-0 gap-1 [animation-delay:80ms]"
    >
      <CopyActionButton />
      {BranchAction && <BranchAction />}
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="Retry">
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <AuiIf condition={(s) => s.thread.capabilities.feedback}>
        <ActionBarPrimitive.FeedbackPositive asChild>
          <TooltipIconButton
            tooltip="Helpful"
            className="data-[submitted=true]:bg-accent data-[submitted=true]:text-accent-foreground"
          >
            <ThumbsUpIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.FeedbackPositive>
        <ActionBarPrimitive.FeedbackNegative asChild>
          <TooltipIconButton
            tooltip="Not helpful"
            className="data-[submitted=true]:bg-accent data-[submitted=true]:text-accent-foreground"
          >
            <ThumbsDownIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.FeedbackNegative>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.capabilities.speech}>
        <AuiIf condition={(s) => s.message.speech == null}>
          <ActionBarPrimitive.Speak asChild>
            <TooltipIconButton tooltip="Read aloud">
              <Volume2Icon />
            </TooltipIconButton>
          </ActionBarPrimitive.Speak>
        </AuiIf>
        <AuiIf condition={(s) => s.message.speech != null}>
          <ActionBarPrimitive.StopSpeaking asChild>
            <TooltipIconButton tooltip="Stop reading">
              <VolumeXIcon />
            </TooltipIconButton>
          </ActionBarPrimitive.StopSpeaking>
        </AuiIf>
      </AuiIf>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="More"
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
              Export as Markdown
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

const UserMessage: FC = () => {
  const entering = useContext(MessageEnteringContext);
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className={cn(
        // Inset the measured anchor without changing message spacing. The
        // reserve stops short turns below the mobile header's 5rem fade.
        // Negative margin preserves the spacing between messages. The reserve
        // overlaps the previous assistant footer, so only children take the pointer.
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
            components={{ File: UserFilePart, Image: UserImagePart }}
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
  return (
    <TooltipIconButton
      tooltip="Retry"
      onClick={() => aui.thread.startRun({ parentId: aui.message.getState().id })}
    >
      <RefreshCwIcon />
    </TooltipIconButton>
  );
};

const UserActionBar: FC = () => {
  const { BranchAction } = useContext(ThreadComponentsContext);
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root text-muted-foreground animate-fade-in flex gap-1 [animation-delay:80ms]"
    >
      <UserRetryButton />
      {BranchAction && <BranchAction />}
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="Edit" className="aui-user-action-edit">
          <SquarePenIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
      <CopyActionButton />
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="chat-edit-in flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root depth-composer ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--composer-radius) border bg-(--composer-bg) transition-[border-color,box-shadow] duration-(--motion-base) ease-out-quart">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-8 px-3">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 px-3">
              Update
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
        <TooltipIconButton tooltip="Previous">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium whitespace-nowrap">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
