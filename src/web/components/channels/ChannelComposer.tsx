import { useEffect, useRef, useState } from "react";
import { AtSignIcon, BotIcon, SendIcon, XIcon } from "lucide-react";
import type { ChannelMemberSummary, ChannelMessage, ChannelMentionInput, ChannelSummary } from "@shared/channels";
import { CHANNEL_LIMITS } from "@shared/channels";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { useChannels } from "@/state/channels";
import { channelActivity } from "@/state/channel-activity";
import { ChannelMentionPicker } from "./ChannelMentionPicker";
import { ChannelAttachmentPicker } from "./ChannelAttachmentPicker";
import { ChannelTypingIndicator } from "./ChannelTypingIndicator";

interface SelectedMention extends ChannelMentionInput {
  name: string;
}

// A stable empty list: a fresh `[]` from a selector re-renders forever.
const NO_CHIPS: never[] = [];

/** Text composer with a structured mention picker, attachments, and an explicit, visually distinct AI chip. */
export function ChannelComposer({
  room,
  members,
  composerKey,
  rootId = null,
  draft,
  reply,
  aiArmed,
  sending,
  showAi = true,
  threadMode = false,
  announceTyping = true,
  onDraftChange,
  onSend,
  onCancelReply,
  onAiToggle,
}: {
  room: ChannelSummary;
  members: ChannelMemberSummary[];
  composerKey: string;
  /** The explicit protocol scope: null for the room line, a live root for a thread line. */
  rootId?: string | null;
  draft: string;
  reply: ChannelMessage | null;
  aiArmed: boolean;
  sending: boolean;
  showAi?: boolean;
  threadMode?: boolean;
  announceTyping?: boolean;
  onDraftChange: (text: string) => void;
  onSend: (text: string, mentions: ChannelMentionInput[]) => void;
  onCancelReply: () => void;
  onAiToggle: () => void;
}) {
  const sendWith = useData((state) => state.settings?.keyboard?.sendWith) ?? "enter";
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [mentions, setMentions] = useState<SelectedMention[]>([]);
  const [picker, setPicker] = useState<{ start: number; query: string } | null>(null);
  const chips = useChannels((state) => state.pendingAttachments[composerKey] ?? NO_CHIPS);
  const uploading = useChannels((state) => state.uploading[composerKey] ?? 0);
  const ready = chips.filter((chip) => chip.status === "ready").length;
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const disabled = !room.capabilities.post || sending || offline;
  const canSend = !disabled && (draft.trim().length > 0 || ready > 0) && uploading === 0;
  const scope = { channelId: room.id, rootId };
  // A DOM id is never the protocol scope, but the room and thread composers need distinct targets.
  const textareaId = rootId ? `channel-composer-thread-${rootId}` : `channel-composer-room-${room.id}`;

  useEffect(() => {
    if (!draft) setMentions([]);
  }, [draft]);

  useEffect(() => {
    const current = scope;
    return () => channelActivity.typingStop(current);
  }, [room.id, rootId]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (value: string, caret: number) => {
    const previous = draft;
    const delta = value.length - previous.length;
    setMentions((current) =>
      current.flatMap((mention) => {
        if (mention.start >= caret) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
        if (mention.end <= caret) return [mention];
        return [];
      }),
    );
    onDraftChange(value);
    // Draft restore and focus never reach this path; only a real edit starts the typing lease.
    channelActivity.typingInput(scope, value);
    const match = /@([^\s@]*)$/.exec(value.slice(0, caret));
    setPicker(match && members.length ? { start: caret - match[0].length, query: match[1] ?? "" } : null);
  };

  const selectMention = (member: ChannelMemberSummary) => {
    if (!picker) return;
    const before = draft.slice(0, picker.start);
    const after = draft.slice(picker.start + 1 + picker.query.length);
    const inserted = `@${member.name} `;
    const text = `${before}${inserted}${after}`;
    const start = before.length;
    setMentions((current) => [
      ...current.filter((mention) => mention.end <= start || mention.start >= picker.start + 1 + picker.query.length).map((mention) =>
        mention.start >= picker.start + 1 + picker.query.length ? { ...mention, start: mention.start + inserted.length - (picker.query.length + 1), end: mention.end + inserted.length - (picker.query.length + 1) } : mention,
      ),
      { userId: member.id, start, end: start + inserted.length - 1, name: member.name },
    ]);
    onDraftChange(text);
    setPicker(null);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(start + inserted.length, start + inserted.length);
    });
  };

  const send = () => {
    if (!canSend) return;
    channelActivity.submit(scope);
    const valid = mentions.filter((mention) => draft.slice(mention.start, mention.end) === `@${mention.name}`);
    onSend(draft, valid.map(({ userId, start, end }) => ({ userId, start, end })));
    setMentions([]);
  };

  const attachDropped = (files: FileList | null) => {
    if (!files?.length || !room.capabilities.attach) return;
    void useChannels.getState().attachFiles(composerKey, [...files]);
  };

  return (
    <div className="bg-background/80 supports-backdrop-filter:bg-background/60 relative border-t backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-1 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {reply && (
          <div className="border-border bg-muted/40 flex items-center gap-2 rounded-lg border px-2 py-1 text-xs">
            <span className="text-muted-foreground min-w-0 flex-1 truncate">
              {threadMode ? t("channels.replyingInThread") : t("channels.replyTo", { name: reply.author?.name ?? t("channels.deletedAccount") })}
            </span>
            <button type="button" onClick={onCancelReply} aria-label={t("channels.cancelReply")} className="text-muted-foreground hover:text-foreground rounded p-1">
              <XIcon aria-hidden className="size-3.5" />
            </button>
          </div>
        )}
        {aiArmed && (
          <div className="border-primary/40 bg-primary/10 text-primary flex items-center gap-2 rounded-lg border px-2 py-1 text-xs">
            <BotIcon aria-hidden className="size-3.5" />
            <span className="min-w-0 flex-1">{t("channels.aiDisclosure")}</span>
            <button type="button" onClick={onAiToggle} aria-label={t("channels.aiDisarm")} className="rounded p-1">
              <XIcon aria-hidden className="size-3.5" />
            </button>
          </div>
        )}
        <ChannelTypingIndicator channelId={room.id} rootId={rootId} members={members} announce={announceTyping} className="-mb-1 px-1" />
        <div
          className="border-border bg-muted/40 focus-within:bg-background relative flex items-end gap-1 rounded-xl border p-1 transition-colors"
          onDragOver={(event) => {
            if (!room.capabilities.attach) return;
            event.preventDefault();
          }}
          onDrop={(event) => {
            if (!room.capabilities.attach) return;
            event.preventDefault();
            attachDropped(event.dataTransfer.files);
          }}
        >
          {picker && <ChannelMentionPicker members={members} query={picker.query} onSelect={selectMention} onClose={() => setPicker(null)} />}
          <ChannelAttachmentPicker room={room} composerKey={composerKey} />
          <button
            type="button"
            aria-label={t("channels.mentionPicker")}
            title={t("channels.mentionPicker")}
            disabled={disabled}
            onClick={() => {
              const caret = ref.current?.selectionStart ?? draft.length;
              update(`${draft.slice(0, caret)}@${draft.slice(caret)}`, caret + 1);
              ref.current?.focus();
            }}
            className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-lg p-2 pointer-coarse:p-3"
          >
            <AtSignIcon aria-hidden className="size-4" />
          </button>
          <Textarea
            ref={ref}
            id={textareaId}
            value={draft}
            disabled={disabled}
            rows={1}
            maxLength={CHANNEL_LIMITS.bodyChars}
            aria-label={t("channels.composerPlaceholder")}
            placeholder={room.archivedAt ? t("channels.archivedReadOnly") : t("channels.composerPlaceholder")}
            onChange={(event) => update(event.target.value, event.target.selectionStart ?? event.target.value.length)}
            onBlur={() => channelActivity.typingStop(scope)}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onPaste={(event) => {
              if (!room.capabilities.attach) return;
              const files = event.clipboardData.files;
              if (files.length) {
                event.preventDefault();
                attachDropped(files);
              }
            }}
            onKeyDown={(event) => {
              if (picker) return;
              // An IME Enter confirms the composition; it must never send the message.
              if (composing.current || event.nativeEvent.isComposing) return;
              const mod = event.metaKey || event.ctrlKey;
              const shouldSend = (event.key === "Enter" && !event.shiftKey && (sendWith === "enter" || mod)) || (event.key === "Enter" && mod);
              if (shouldSend) {
                event.preventDefault();
                send();
              }
            }}
            className="max-h-40 min-h-9 resize-none border-0 bg-transparent px-0 py-1.5 shadow-none focus-visible:bg-transparent"
          />
          {showAi && (
            <button
              type="button"
              aria-label={aiArmed ? t("channels.aiDisarm") : t("channels.aiAsk")}
              aria-pressed={aiArmed}
              disabled={disabled || !room.ai}
              title={room.ai ? (aiArmed ? t("channels.aiArmed") : t("channels.aiAsk")) : t("channels.aiNone")}
              onClick={onAiToggle}
              className={cn(
                "rounded-lg p-2 pointer-coarse:p-3 transition-colors",
                aiArmed ? "depth-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                !room.ai && "opacity-40",
              )}
            >
              <BotIcon aria-hidden className="size-4" />
            </button>
          )}
          <Button type="button" size="icon-sm" aria-label={sending ? t("channels.sending") : t("channels.send")} disabled={!canSend} onClick={send}>
            <SendIcon aria-hidden />
          </Button>
        </div>
        <div className="text-muted-foreground flex items-center justify-between gap-2 text-[0.7rem]">
          <span className="truncate">{showAi ? (room.ai ? `${t("channels.aiBinding")}: ${room.ai.label}` : t("channels.aiNone")) : t("channels.storageOwner")}</span>
          <span>{showAi ? t("channels.storageOwner") : ""}</span>
        </div>
      </div>
    </div>
  );
}
