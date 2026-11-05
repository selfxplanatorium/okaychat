import { useEffect, useMemo, useState } from "react";
import { AtSignIcon } from "lucide-react";
import type { ChannelMemberSummary } from "@shared/channels";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/** Keyboard listbox for structured member mentions. It never offers @everyone or group mentions. */
export function ChannelMentionPicker({
  members,
  query,
  onSelect,
  onClose,
}: {
  members: ChannelMemberSummary[];
  query: string;
  onSelect: (member: ChannelMemberSummary) => void;
  onClose: () => void;
}) {
  const matches = useMemo(
    () => members.filter((member) => member.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8),
    [members, query],
  );
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    if (!matches.length) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setIndex((value) => (value + 1) % matches.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((value) => (value - 1 + matches.length) % matches.length);
      } else if (event.key === "Enter") {
        event.preventDefault();
        onSelect(matches[index]!);
      } else if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, matches, onClose, onSelect]);
  return (
    <div role="listbox" aria-label={t("channels.mentionPicker")} className="border-border bg-popover absolute inset-x-2 bottom-full z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border p-1 shadow-lg">
      <p className="text-muted-foreground flex items-center gap-1.5 px-2 py-1 text-xs">
        <AtSignIcon aria-hidden className="size-3" /> {t("channels.mentionPicker")}
      </p>
      {matches.length === 0 ? (
        <p className="text-muted-foreground px-2 py-2 text-sm">{t("channels.mentionNoMatch")}</p>
      ) : (
        matches.map((member, position) => (
          <button
            key={member.id}
            type="button"
            role="option"
            aria-selected={position === index}
            onClick={() => onSelect(member)}
            onMouseEnter={() => setIndex(position)}
            className={cn(
              "flex w-full items-center rounded-lg px-2 py-1.5 text-start text-sm",
              position === index ? "depth-primary text-primary-foreground" : "hover:bg-muted",
            )}
          >
            <span className="truncate">{member.name}</span>
            <span className="ms-2 text-xs opacity-70">{t(member.role === "owner" ? "channels.owner" : member.role === "moderator" ? "channels.moderator" : "channels.member")}</span>
          </button>
        ))
      )}
    </div>
  );
}
