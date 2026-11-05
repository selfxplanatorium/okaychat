import { useEffect, useState } from "react";
import { BookOpenIcon, CodeIcon, CoffeeIcon, HashIcon, LightbulbIcon, MegaphoneIcon, MessagesSquareIcon, UsersIcon } from "lucide-react";
import { CHANNEL_ICONS, CHANNEL_LIMITS, type ChannelIcon, type ChannelVisibility } from "@shared/channels";
import { t } from "@/i18n";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { channelsApi } from "@/state/channels-api";
import { cn } from "@/lib/utils";

const ICONS = {
  hash: HashIcon,
  "messages-square": MessagesSquareIcon,
  users: UsersIcon,
  megaphone: MegaphoneIcon,
  "book-open": BookOpenIcon,
  code: CodeIcon,
  lightbulb: LightbulbIcon,
  coffee: CoffeeIcon,
} as const;

export function CreateChannelDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { name: string; description?: string; icon: ChannelIcon; visibility: ChannelVisibility; groupIds?: string[] }) => Promise<string | null>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState<ChannelIcon>("hash");
  const [visibility, setVisibility] = useState<ChannelVisibility>("public");
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setIcon("hash");
    setVisibility("public");
    setGroupIds([]);
    void channelsApi.groups().then((result) => setGroups(result.items)).catch(() => setGroups([]));
  }, [open]);
  const invalid = !name.trim() || (visibility === "group" && groupIds.length === 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("channels.createTitle")}</DialogTitle>
          <DialogDescription>{t("channels.createDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("channels.name")}
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={CHANNEL_LIMITS.nameChars} aria-label={t("channels.name")} />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("channels.description")}
            <Textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={CHANNEL_LIMITS.descriptionChars} rows={3} aria-label={t("channels.description")} />
          </label>
          <fieldset>
            <legend className="mb-1 text-sm font-medium">{t("channels.icon")}</legend>
            <div className="flex flex-wrap gap-1">
              {CHANNEL_ICONS.map((value) => {
                const Icon = ICONS[value];
                return (
                  <button
                    key={value}
                    type="button"
                    aria-label={value}
                    aria-pressed={icon === value}
                    onClick={() => setIcon(value)}
                    className={cn("rounded-lg border p-2 pointer-coarse:p-3", icon === value ? "depth-primary text-primary-foreground border-transparent" : "hover:bg-muted")}
                  >
                    <Icon aria-hidden className="size-4" />
                  </button>
                );
              })}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-1 text-sm font-medium">{t("channels.visibility")}</legend>
            <div className="flex flex-wrap gap-1">
              {(["public", "private", "group"] as const).map((value) => (
                <Button key={value} type="button" size="sm" variant={visibility === value ? "default" : "outline"} aria-pressed={visibility === value} onClick={() => setVisibility(value)}>
                  {t(value === "public" ? "channels.public" : value === "private" ? "channels.private" : "channels.group")}
                </Button>
              ))}
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              {t(visibility === "public" ? "channels.publicHelp" : visibility === "private" ? "channels.privateHelp" : "channels.groupHelp")}
            </p>
          </fieldset>
          {visibility === "group" && (
            <fieldset>
              <legend className="mb-1 text-sm font-medium">{t("channels.groups")}</legend>
              {groups.length ? groups.map((group) => (
                <label key={group.id} className="flex items-center gap-2 py-0.5 text-sm">
                  <input
                    type="checkbox"
                    checked={groupIds.includes(group.id)}
                    onChange={(event) => setGroupIds((ids) => event.target.checked ? [...ids, group.id] : ids.filter((id) => id !== group.id))}
                  />
                  {group.name}
                </label>
              )) : <p className="text-muted-foreground text-xs">{t("channels.emptyDiscover")}</p>}
            </fieldset>
          )}
          <p className="text-muted-foreground text-xs">{t("channels.visibilityImmutable")}</p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("channels.cancel")}</Button>
          <Button
            type="button"
            disabled={busy || invalid}
            onClick={async () => {
              setBusy(true);
              const id = await onCreate({ name, description, icon, visibility, ...(groupIds.length ? { groupIds } : {}) });
              setBusy(false);
              if (id) onOpenChange(false);
            }}
          >
            {t("channels.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
