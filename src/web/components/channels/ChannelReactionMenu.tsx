import { SmilePlusIcon } from "lucide-react";
import { CHANNEL_REACTIONS, type ChannelMessage } from "@shared/channels";
import { t } from "@/i18n";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/utils";

export function ChannelReactionMenu({
  message,
  onToggle,
  disabled,
}: {
  message: ChannelMessage;
  onToggle: (emoji: string, add: boolean) => void;
  disabled?: boolean;
}) {
  if (message.deletedAt) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {message.reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          aria-pressed={reaction.mine}
          aria-label={t("channels.reactionCount", { emoji: reaction.emoji, count: reaction.count })}
          title={reaction.mine ? t("channels.reactionMine") : undefined}
          disabled={disabled}
          onClick={() => onToggle(reaction.emoji, !reaction.mine)}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors",
            reaction.mine ? "depth-primary border-transparent text-primary-foreground" : "border-border bg-muted/40 hover:bg-muted",
          )}
        >
          <span aria-hidden>{reaction.emoji}</span>
          <span>{reaction.count}</span>
        </button>
      ))}
      {!disabled && (
        <Menu>
          <MenuTrigger
            aria-label={t("channels.addReaction")}
            className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-full p-1 transition-colors"
          >
            <SmilePlusIcon aria-hidden className="size-3.5" />
          </MenuTrigger>
          <MenuContent side="top" className="flex-row p-1">
            {CHANNEL_REACTIONS.map((emoji) => {
              const mine = message.reactions.some((reaction) => reaction.emoji === emoji && reaction.mine);
              return (
                <MenuItem
                  key={emoji}
                  aria-label={t("channels.emojiLabel", { emoji })}
                  aria-pressed={mine}
                  onClick={() => onToggle(emoji, !mine)}
                  className="justify-center text-lg"
                >
                  <span aria-hidden>{emoji}</span>
                </MenuItem>
              );
            })}
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}
