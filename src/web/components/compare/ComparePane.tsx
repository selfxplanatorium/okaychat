import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { CopyIcon, ExternalLinkIcon, Loader2Icon, MoreHorizontalIcon, RefreshCwIcon, SquareIcon } from "lucide-react";
import type { ComparisonPaneDetail } from "@shared/compare";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { SimpleMarkdown } from "@/components/ui/simple-markdown";
import { t } from "@/i18n";
import { formatCost, formatDuration, formatList, formatTokens } from "@/i18n/format";
import { parseChatError } from "@/lib/api";
import { presentError } from "@/lib/error-presentation";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { metadataOf } from "@/state/context-usage";

export interface PaneHandle {
  send: (text: string) => void;
  stop: () => void;
  retry: () => void;
}

type ChatStatus = "submitted" | "streaming" | "ready" | "error";

const textOf = (message: UIMessage): string =>
  message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");

/**
 * One comparison column. It is a real chat: the normal `/api/chat` transport, the normal stream, and
 * server-side persistence. Pane text is rendered read-only here; the full chat is one action away.
 */
export function ComparePane({
  pane,
  effort,
  active,
  autoSend,
  onRegister,
  onStatus,
  onNeedsAnswer,
  onAutoSent,
  onPromote,
  onDeleteComparison,
}: {
  pane: ComparisonPaneDetail;
  effort?: string;
  active: boolean;
  autoSend: string | null;
  onRegister: (threadId: string, handle: PaneHandle | null) => void;
  onStatus: (threadId: string, status: ChatStatus) => void;
  onNeedsAnswer: (threadId: string, needs: boolean) => void;
  onAutoSent: (threadId: string) => void;
  onPromote: (threadId: string) => void;
  onDeleteComparison: () => void;
}) {
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: { id: pane.threadId, messages, config: { modelName: pane.modelRef, ...(effort ? { reasoningEffort: effort } : {}) } },
        }),
      }),
    [pane.threadId, pane.modelRef, effort],
  );
  const chat = useChat<UIMessage>({ id: pane.threadId, messages: pane.messages, transport });
  const models = useData((s) => s.models);
  const model = models.find((item) => item.ref === pane.modelRef);
  const modelName = model?.name ?? pane.modelName;
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  const sendRef = useRef<(text: string) => void>(() => {});
  const stopRef = useRef<() => void>(() => {});
  const retryRef = useRef<() => void>(() => {});
  sendRef.current = (text) => void chat.sendMessage({ text });
  stopRef.current = () => chat.stop();
  retryRef.current = () => {
    const last = chat.messages.at(-1);
    if (last?.role === "assistant") void chat.regenerate();
    else void chat.sendMessage();
  };

  useEffect(() => {
    onRegister(pane.threadId, {
      send: (text) => sendRef.current(text),
      stop: () => stopRef.current(),
      retry: () => retryRef.current(),
    });
    return () => onRegister(pane.threadId, null);
  }, [pane.threadId, onRegister]);

  useEffect(() => {
    onStatus(pane.threadId, chat.status as ChatStatus);
    onNeedsAnswer(pane.threadId, chat.messages.at(-1)?.role === "user" && chat.status !== "streaming" && chat.status !== "submitted");
  }, [chat.status, chat.messages, pane.threadId, onStatus, onNeedsAnswer]);

  const autoSent = useRef(false);
  useEffect(() => {
    if (!autoSend || autoSent.current) return;
    autoSent.current = true;
    void chat.sendMessage({ text: autoSend }).finally(() => onAutoSent(pane.threadId));
    // The prompt is sent once per mount; later follow-ups use the shared composer.
  }, [autoSend, chat, onAutoSent, pane.threadId]);

  const running = chat.status === "submitted" || chat.status === "streaming";
  const lastAssistant = [...chat.messages].reverse().find((message) => message.role === "assistant");
  const last = chat.messages.at(-1);
  const meta = metadataOf(lastAssistant?.metadata);
  const usage = meta.usage ? meta.usage.input + meta.usage.output : undefined;
  const tools = lastAssistant
    ? formatList([
        ...new Set(
          lastAssistant.parts.flatMap((part) => {
            if (!part.type.startsWith("tool-")) return [];
            const name = "toolName" in part && typeof part.toolName === "string" ? part.toolName : part.type.slice(5);
            return [name.replaceAll("_", " ")];
          }),
        ),
      ])
    : "";
  const failure = chat.error ? presentError(parseChatError(chat.error), "chat") : null;
  const statusText = failure
    ? t("compare.paneFailed")
    : chat.status === "submitted"
      ? t("compare.starting")
      : chat.status === "streaming"
        ? t("compare.writing")
        : lastAssistant
          ? t("compare.done")
          : t("compare.paneEmpty");

  return (
    <section
      aria-label={modelName}
      tabIndex={0}
      data-pane-active={active || undefined}
      className={cn("min-h-0 min-w-0 flex-col rounded-xl border", active ? "flex" : "hidden", "lg:flex")}
    >
      <header className="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-10 flex flex-col gap-1 rounded-t-xl border-b px-3 py-2 backdrop-blur">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{modelName}</span>
          <span className={cn("text-muted-foreground flex shrink-0 items-center gap-1 text-xs", running && "text-foreground")}>
            {running && <Loader2Icon aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />}
            {statusText}
          </span>
          <Menu>
            <MenuTrigger aria-label={t("common.more")} className="text-muted-foreground hover:bg-muted rounded-md p-1 pointer-coarse:p-2.5">
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onClick={() => onPromote(pane.threadId)}>
                <ExternalLinkIcon /> {t("compare.openAsChat")}
              </MenuItem>
              <MenuItem destructive onClick={onDeleteComparison}>
                {t("compare.deleteComparison")}
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
        {(effort || usage !== undefined || meta.cost !== undefined || meta.durationMs !== undefined) && (
          <p className="text-muted-foreground flex flex-wrap gap-x-2 text-[11px] tabular-nums">
            {effort && <span>{effort}</span>}
            {usage !== undefined && <span>{t("compare.tokens", { count: formatTokens(usage) })}</span>}
            {meta.cost !== undefined && <span>{t("compare.cost", { amount: formatCost(meta.cost) })}</span>}
            {meta.durationMs !== undefined && <span>{t("compare.duration", { duration: formatDuration(meta.durationMs / 1000) })}</span>}
          </p>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {failure && (
          <div role="alert" className="text-destructive mb-3 text-xs">
            {t(failure.messageKey)}
          </div>
        )}
        {chat.messages.length === 0 && !running && (
          <div className="flex flex-col items-start gap-2 py-6">
            <p className="text-muted-foreground text-sm">{t("compare.paneEmpty")}</p>
            <Button size="sm" variant="outline" onClick={() => retryRef.current()}>
              <RefreshCwIcon /> {t("compare.retry")}
            </Button>
          </div>
        )}
        <div className="flex flex-col gap-3">
          {chat.messages.map((message) =>
            message.role === "user" ? (
              <p key={message.id} className="bg-muted ms-auto max-w-[90%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap">
                {textOf(message)}
              </p>
            ) : message.role === "assistant" && textOf(message) ? (
              <SimpleMarkdown key={message.id} className="text-sm">
                {textOf(message)}
              </SimpleMarkdown>
            ) : null,
          )}
          {running && !(chat.messages.at(-1)?.role === "assistant" && textOf(chat.messages.at(-1)!)) && (
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Loader2Icon aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />
              {chat.status === "submitted" ? t("compare.thinking") : t("compare.writing")}
            </p>
          )}
        </div>
        {last?.role === "user" && !running && (
          <div className="mt-3 flex flex-wrap gap-1">
            <Button size="sm" variant="outline" onClick={() => retryRef.current()}>
              <RefreshCwIcon /> {t("compare.retry")}
            </Button>
          </div>
        )}
      </div>
      <footer className="flex flex-wrap items-center gap-1 border-t px-2 py-1.5">
        {running ? (
          <Button size="sm" variant="ghost" className="pointer-coarse:min-h-11" onClick={() => stopRef.current()}>
            <SquareIcon /> {t("compare.stop")}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="pointer-coarse:min-h-11" disabled={!lastAssistant} onClick={() => retryRef.current()}>
            <RefreshCwIcon /> {t("compare.retry")}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="pointer-coarse:min-h-11"
          disabled={!lastAssistant}
          onClick={() => lastAssistant && copyToClipboard(textOf(lastAssistant))}
        >
          <CopyIcon /> {isCopied ? t("compare.copied") : t("compare.copy")}
        </Button>
        <Button size="sm" variant="ghost" className="pointer-coarse:min-h-11" onClick={() => onPromote(pane.threadId)}>
          <ExternalLinkIcon /> {t("compare.openAsChat")}
        </Button>
        {tools && <span className="text-muted-foreground ms-auto truncate text-[11px]">{t("compare.usedTools", { tools })}</span>}
      </footer>
    </section>
  );
}
