import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import type { ChannelPresenceState } from "@shared/channel-activity";

/**
 * Presence is shape first, color second: filled online, ringed away, soft neutral offline, dashed
 * unavailable. The dot is decorative; every place that shows it also shows the localized status text,
 * so touch users and color-blind users get the same information without hover.
 */

const DOT: Record<ChannelPresenceState | "unavailable", string> = {
  online: "bg-success",
  away: "border-2 border-warning bg-transparent",
  offline: "bg-muted-foreground/60",
  unavailable: "border border-dashed border-muted-foreground/60 bg-transparent",
};

const LABEL = {
  online: "channels.presenceOnline",
  away: "channels.presenceAway",
  offline: "channels.presenceOffline",
  unavailable: "channels.presenceUnavailable",
} as const;

export function presenceStatusText(state: ChannelPresenceState | undefined): string {
  return t(LABEL[state ?? "unavailable"]);
}

export function ChannelPresenceDot({ state, className }: { state: ChannelPresenceState | undefined; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2.5 shrink-0 rounded-full", DOT[state ?? "unavailable"], className)} />;
}

/** The visible status line beside a member's name; never focusable and never live-announced here. */
export function ChannelPresenceText({ state, className }: { state: ChannelPresenceState | undefined; className?: string }) {
  return <span className={cn("text-muted-foreground text-[0.7rem]", className)}>{presenceStatusText(state)}</span>;
}
