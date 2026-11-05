import { BotIcon, MessageCircleIcon, SparklesIcon, WorkflowIcon } from "lucide-react";
import { AGENT_AVATARS, type AgentAvatar as AgentAvatarId } from "@shared/n8n-agents";
import { cn } from "@/lib/utils";

// An agent's avatar is one of a fixed set of local icons. Nothing here loads a remote image or an
// uploaded SVG, so a definition can never point the settings page or the picker at outside content.

const ICONS = {
  workflow: WorkflowIcon,
  bot: BotIcon,
  sparkles: SparklesIcon,
  "message-circle": MessageCircleIcon,
} as const;

const SIZES = {
  xs: "size-5 rounded-md [&_svg]:size-3",
  sm: "size-7 rounded-lg [&_svg]:size-3.5",
  md: "size-10 rounded-xl [&_svg]:size-5",
} as const;

/** Narrows an arbitrary stored avatar key to the allowlist; unknown values fall back to the workflow tile. */
export const agentAvatarId = (value: string | undefined): AgentAvatarId =>
  (AGENT_AVATARS as readonly string[]).includes(value ?? "") ? (value as AgentAvatarId) : "workflow";

export function AgentAvatar({
  avatar,
  size = "md",
  className,
}: {
  avatar: string | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const Icon = ICONS[agentAvatarId(avatar)];
  return (
    <span
      aria-hidden
      className={cn(
        "bg-muted text-primary inline-flex shrink-0 items-center justify-center border shadow-[var(--depth-highlight)]",
        SIZES[size],
        className,
      )}
    >
      <Icon />
    </span>
  );
}
