import type { Me } from "@shared/types";
import { imageVariantUrl } from "@/lib/media";
import { Avatar, AvatarFallback, AvatarImage } from "./avatar";

export function AccountAvatar({ user, className }: { user: Me | null; className?: string }) {
  return (
    <Avatar className={className}>
      {user?.avatarUrl && <AvatarImage key={`${user.id}:${user.avatarUrl}`} src={imageVariantUrl(user.avatarUrl, "thumb")} alt="" decoding="async" />}
      <AvatarFallback className="bg-primary text-primary-foreground font-medium uppercase">
        {user?.name.slice(0, 1) ?? "?"}
      </AvatarFallback>
    </Avatar>
  );
}
