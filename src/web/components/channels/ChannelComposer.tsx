import { useEffect, useRef, useState } from "react";
import { AtSignIcon, BotIcon, SendIcon, XIcon } from "lucide-react";
import type { ChannelMemberSummary, ChannelMessage, ChannelMentionInput, ChannelSummary } from "@shared/channels";
import { CHANNEL_LIMITS } from "@shared/channels";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { ChannelMentionPicker } from "./ChannelMentionPicker";

interface SelectedMention extends ChannelMentionInput {
  name: string;
}

/** Text-only composer with a structured mention picker and an explicit, visually distinct AI chip. */
export function ChannelComposer({
  room,
  members,
  draft,
  reply,
  aiArmed,
  sending,
  onDraftChange,
  onSend,
  onCancelReply,
  onAiToggle,
}: {
  room: ChannelSummary;
  members: ChannelMemberSummary[];
  draft: string;
  reply: ChannelMessage | null;
  aiArmed: boolean;
  sending: boolean;
  onDraftChange: (text: string) => void;
  onSend: (text: string, mentions: ChannelMentionInput[]) => void;
  onCancelReply: () => void;
  onAiToggle: () => void;
}) {
  const sendWith = useData((state) => state.settings?.keyboard?.sendWith) ?? "enter";
  const ref = useRef<HTMLTextAreaElement>(null);
  const [mentions, setMentions] = useState<SelectedMention[]>([]);
  const [picker, setPicker] = useState<{ start: number; query: string } | null>(null);
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const disabled = !room.capabilities.post || sending || offline;

  useEffect(() => {
    if (!draft) setMentions([]);
  }, [draft]);

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
    if (disabled || !draft.trim()) return;
    const valid = mentions.filter((mention) => draft.slice(mention.start, mention.end) === `@${mention.name}`);
    onSend(draft, valid.map(({ userId, start, end }) => ({ userId, start, end })));
    setMentions([]);
  };

  return (
    <div className="bg-background/80 supports-backdrop-filter:bg-background/60 relative border-t backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-1 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {reply && (
          <div className="border-border bg-muted/40 flex items-center gap-2 rounded-lg border px-2 py-1 text-xs">
            <span className="text-muted-foreground min-w-0 flex-1 truncate">
              {t("channels.replyTo", { name: reply.author?.name ?? t("channels.deletedAccount") })}
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
        <div className="border-border bg-muted/40 focus-within:bg-background relative flex items-end gap-1 rounded-xl border p-1 transition-colors">
          {picker && <ChannelMentionPicker members={members} query={picker.query} onSelect={selectMention} onClose={() => setPicker(null)} />}
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
            id="channel-composer"
            value={draft}
            disabled={disabled}
            rows={1}
            maxLength={CHANNEL_LIMITS.bodyChars}
            aria-label={t("channels.composerPlaceholder")}
            placeholder={room.archivedAt ? t("channels.archivedReadOnly") : t("channels.composerPlaceholder")}
            onChange={(event) => update(event.target.value, event.target.selectionStart ?? event.target.value.length)}
            onKeyDown={(event) => {
              if (picker) return;
              const mod = event.metaKey || event.ctrlKey;
              const shouldSend = (event.key === "Enter" && !event.shiftKey && (sendWith === "enter" || mod)) || (event.key === "Enter" && mod);
              if (shouldSend) {
                event.preventDefault();
                send();
              }
            }}
            className="max-h-40 min-h-9 resize-none border-0 bg-transparent px-0 py-1.5 shadow-none focus-visible:bg-transparent"
          />
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
          <Button type="button" size="icon-sm" aria-label={sending ? t("channels.sending") : t("channels.send")} disabled={disabled || !draft.trim()} onClick={send}>
            <SendIcon aria-hidden />
          </Button>
        </div>
        <div className="text-muted-foreground flex items-center justify-between gap-2 text-[0.7rem]">
          <span className="truncate">{room.ai ? `${t("channels.aiBinding")}: ${room.ai.label}` : t("channels.aiNone")}</span>
          <span>{t("channels.storageOwner")}</span>
        </div>
      </div>
    </div>
  );
}
