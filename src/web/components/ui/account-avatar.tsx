import type { Me } from "@shared/types";
import { Avatar, AvatarFallback, AvatarImage } from "./avatar";

export function AccountAvatar({ user, className }: { user: Me | null; className?: string }) {
  return (
    <Avatar className={className}>
      {user?.avatarUrl && <AvatarImage key={`${user.id}:${user.avatarUrl}`} src={user.avatarUrl} alt="" />}
      <AvatarFallback className="bg-primary text-primary-foreground font-medium uppercase">
        {user?.name.slice(0, 1) ?? "?"}
      </AvatarFallback>
    </Avatar>
  );
}
