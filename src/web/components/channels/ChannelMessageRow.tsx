import { useState } from "react";
import { BotIcon, CopyIcon, CornerUpLeftIcon, MoreHorizontalIcon, PencilIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import type { ChannelMessage, ChannelSummary } from "@shared/channels";
import { t } from "@/i18n";
import { formatTime } from "@/i18n/format";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Textarea } from "@/components/ui/textarea";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";
import { ChannelMarkdown } from "./ChannelMarkdown";
import { ChannelQuote } from "./ChannelQuote";
import { ChannelReactionMenu } from "./ChannelReactionMenu";
import { ChannelAiStatus } from "./ChannelAiStatus";

export interface MessageActions {
  onReply: (message: ChannelMessage) => void;
  onJumpToQuote: (messageId: string) => void;
  onEdit: (messageId: string, body: string, mentions?: ChannelMessage["mentions"]) => Promise<boolean>;
  onDelete: (message: ChannelMessage) => void;
  onReact: (messageId: string, emoji: string, add: boolean) => void;
  onAskAi: (message: ChannelMessage) => void;
  onStopAi: (message: ChannelMessage) => void;
}

export function ChannelMessageRow({
  message,
  room,
  meId,
  focused,
  actions,
  onFocus,
}: {
  message: ChannelMessage;
  room: ChannelSummary;
  meId: string | null;
  focused: boolean;
  actions: MessageActions;
  onFocus: () => void;
}) {
  const { copyToClipboard } = useCopyToClipboard();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const own = message.kind === "human" && message.author?.id === meId;
  const canDelete = !message.deletedAt && message.kind === "human" && (own || room.capabilities.moderate);
  const pending = message.aiRun?.state === "queued" || message.aiRun?.state === "running";
  const canStop = !!message.aiRun && pending && (message.aiRun.requesterId === meId || room.capabilities.moderate);

  if (message.deletedAt) {
    return (
      <div data-message-id={message.id} tabIndex={0} onFocus={onFocus} className={cn("px-3 py-1.5 text-xs", focused && "bg-muted/40 rounded-lg outline-none")}>
        <p className="text-muted-foreground italic">{t("channels.deletedMessage")}</p>
      </div>
    );
  }

  return (
    <article
      data-message-id={message.id}
      tabIndex={0}
      onFocus={onFocus}
      aria-label={message.kind === "ai" ? message.aiLabel ?? t("channels.aiAsk") : message.author?.name ?? t("channels.deletedAccount")}
      className={cn(
        "group/message relative rounded-xl px-3 py-2 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring",
        message.kind === "ai" ? "bg-muted/30 border-border/60 border" : "hover:bg-muted/30",
        focused && "bg-muted/50",
      )}
    >
      <header className="mb-0.5 flex min-w-0 items-center gap-2">
        {message.kind === "ai" ? (
          <>
            <BotIcon aria-hidden className="text-primary size-3.5 shrink-0" />
            <span className="text-sm font-medium">{message.aiLabel ?? t("channels.aiAsk")}</span>
            {message.aiRequester && <span className="text-muted-foreground truncate text-xs">{t("channels.aiRequestedBy", { name: message.aiRequester.name })}</span>}
          </>
        ) : (
          <>
            <span className="truncate text-sm font-medium">{message.author?.name ?? t("channels.deletedAccount")}</span>
            <time className="text-muted-foreground text-xs" dateTime={new Date(message.createdAt).toISOString()}>{formatTime(message.createdAt)}</time>
          </>
        )}
        {message.editedAt && <span className="text-muted-foreground text-[0.7rem]">{t("channels.edited")}</span>}
        <div className="ms-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 pointer-coarse:opacity-100">
          <Menu>
            <MenuTrigger aria-label={t("channels.messageActions")} className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-md p-1">
              <MoreHorizontalIcon aria-hidden className="size-4" />
            </MenuTrigger>
            <MenuContent side="bottom" align="end" className="w-52">
              <MenuItem onClick={() => actions.onReply(message)} disabled={!room.capabilities.post}>
                <CornerUpLeftIcon aria-hidden /> {t("channels.reply")}
              </MenuItem>
              <MenuItem onClick={() => copyToClipboard(message.body)}>
                <CopyIcon aria-hidden /> {t("channels.copy")}
              </MenuItem>
              {own && room.capabilities.post && (
                <MenuItem onClick={() => { setDraft(message.body); setEditing(true); }}>
                  <PencilIcon aria-hidden /> {t("channels.edit")}
                </MenuItem>
              )}
              {canDelete && (
                <MenuItem
                  className="text-destructive data-highlighted:bg-destructive/10"
                  onClick={() => {
                    if (window.confirm(t("channels.deleteMessageConfirm"))) actions.onDelete(message);
                  }}
                >
                  <Trash2Icon aria-hidden /> {t("channels.deleteMessage")}
                </MenuItem>
              )}
              {message.kind === "human" && room.capabilities.requestAi && (
                <MenuItem onClick={() => actions.onAskAi(message)}>
                  <SparklesIcon aria-hidden /> {t("channels.aiAsk")}
                </MenuItem>
              )}
            </MenuContent>
          </Menu>
        </div>
      </header>
      {message.replyTo && <ChannelQuote quote={message.replyTo} onClick={() => actions.onJumpToQuote(message.replyTo!.id)} className="mb-1" />}
      {editing ? (
        <div className="flex flex-col gap-1">
          <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} aria-label={t("channels.edit")} />
          <div className="flex justify-end gap-1">
            <Button type="button" size="xs" variant="ghost" onClick={() => { setEditing(false); setDraft(message.body); }}>{t("channels.cancel")}</Button>
            <Button
              type="button"
              size="xs"
              onClick={() => {
                void actions.onEdit(message.id, draft, draft === message.body ? message.mentions : undefined).then((ok) => { if (ok) setEditing(false); });
              }}
            >
              {t("channels.save")}
            </Button>
          </div>
        </div>
      ) : message.body ? (
        <ChannelMarkdown>{message.body}</ChannelMarkdown>
      ) : pending ? (
        <p className="text-muted-foreground text-sm italic">{t("channels.aiQueued")}</p>
      ) : null}
      <ChannelReactionMenu message={message} onToggle={(emoji, add) => actions.onReact(message.id, emoji, add)} disabled={!room.capabilities.post} />
      {message.kind === "ai" && (
        <ChannelAiStatus
          message={message}
          canStop={canStop}
          onStop={() => actions.onStopAi(message)}
          onRetry={() => message.aiRun && actions.onAskAi({ ...message, id: message.aiRun.sourceId })}
        />
      )}
    </article>
  );
}
