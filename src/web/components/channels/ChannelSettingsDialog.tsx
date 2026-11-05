import { useEffect, useMemo, useState } from "react";
import { llmTargets } from "@shared/n8n-agents";
import { CHANNEL_ICONS, CHANNEL_LIMITS, type ChannelIcon, type ChannelSummary } from "@shared/channels";
import { t } from "@/i18n";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { channelsApi, type ChannelBindingRequest } from "@/state/channels-api";
import { useData } from "@/state/data";
import { useChannels } from "@/state/channels";
import { ChannelNotificationPreferences } from "./ChannelNotificationPreferences";
import { useAssistantPresets } from "@/state/assistant-presets";
import { cn } from "@/lib/utils";

export function ChannelSettingsDialog({
  open,
  room,
  onOpenChange,
  onSave,
  onArchive,
  onDelete,
  onLeave,
}: {
  open: boolean;
  room: ChannelSummary;
  onOpenChange: (open: boolean) => void;
  onSave: (input: { revision: number; name: string; description: string; icon: ChannelIcon; groupIds: string[]; ai?: ChannelBindingRequest | null }) => Promise<boolean>;
  onArchive: (archived: boolean) => Promise<void>;
  onDelete: (revision: number) => Promise<void>;
  onLeave: () => Promise<void>;
}) {
  const rawModels = useData((state) => state.models);
  const meId = useData((state) => state.me?.id ?? null);
  const models = useMemo(() => llmTargets(rawModels), [rawModels]);
  const presets = useAssistantPresets((state) => state.mine);
  const loadPresets = useAssistantPresets((state) => state.loadMine);
  const [name, setName] = useState(room.name);
  const [description, setDescription] = useState(room.description);
  const [icon, setIcon] = useState<ChannelIcon>(room.icon);
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [audienceReady, setAudienceReady] = useState(room.visibility !== "group");
  const [aiMode, setAiMode] = useState<"none" | "model" | "preset">(room.ai?.kind ?? "none");
  const [modelRef, setModelRef] = useState(room.ai?.modelRef ?? models[0]?.ref ?? "");
  const [presetId, setPresetId] = useState("");
  const [reduced, setReduced] = useState(false);
  const [aiTouched, setAiTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dmEmail, setDmEmail] = useState("");
  const [dmBusy, setDmBusy] = useState(false);
  const blocks = useChannels((state) => state.blocks);
  const dm = room.kind === "dm";

  useEffect(() => {
    if (!open) return;
    setName(room.name);
    setDescription(room.description);
    setIcon(room.icon);
    setAiMode(room.ai?.kind ?? "none");
    setModelRef(room.ai?.modelRef ?? models[0]?.ref ?? "");
    setPresetId("");
    setReduced(false);
    setAiTouched(false);
    setAudienceReady(room.visibility !== "group");
    if (room.kind === "dm") {
      void useChannels.getState().loadBlocks();
      return;
    }
    void loadPresets();
    void channelsApi.groups().then((result) => setGroups(result.items)).catch(() => setGroups([]));
    void channelsApi
      .audience(room.id)
      .then((result) => { setGroupIds(result.groupIds); setAudienceReady(true); })
      .catch(() => setAudienceReady(room.visibility !== "group"));
  }, [loadPresets, models, open, room.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const canManage = room.capabilities.manage;
  const canModerate = room.capabilities.moderate;
  const binding: ChannelBindingRequest | null | undefined = !canManage || !aiTouched
    ? undefined
    : aiMode === "none"
      ? null
      : aiMode === "model"
        ? { kind: "model", modelRef }
        : presetId
          ? { kind: "preset", presetId, confirmReduced: reduced }
          : undefined;
  const bindingInvalid = canManage && aiTouched && aiMode !== "none" && ((aiMode === "model" && !modelRef) || (aiMode === "preset" && (!presetId || !reduced)));

  if (dm) {
    const owner = room.ownerId;
    const isOwner = room.membership?.role === "owner";
    const add = async () => {
      const email = dmEmail.trim();
      if (!email) return;
      setDmBusy(true);
      const found = await useChannels.getState().lookupPeople(email);
      const person = found[0];
      if (!person) {
        setDmBusy(false);
        return;
      }
      const ok = await useChannels.getState().addDmMembers([person.id]);
      setDmBusy(false);
      if (ok) setDmEmail("");
    };
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("channels.directMessages")}</DialogTitle>
            <DialogDescription>{t("channels.dmNoAi")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <fieldset>
              <legend className="mb-1 text-sm font-medium">{t("channels.members")}</legend>
              <ul className="flex flex-col gap-1">
                {(room.dmMembers ?? []).map((person) => (
                  <li key={person.id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{person.name}</span>
                    {person.id === owner && <span className="text-muted-foreground text-xs">{t("channels.owner")}</span>}
                    {person.id !== meId && (
                      <Button type="button" size="xs" variant="ghost" onClick={() => { if (window.confirm(t("channels.dmBlockConfirm"))) void useChannels.getState().blockUser(person.id); }}>
                        {t("channels.dmBlock")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </fieldset>
            {room.membership && (
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="font-medium">{t("channels.notificationMode")}</span>
                <ChannelNotificationPreferences mode={room.membership.notifyMode} onChange={(mode) => void useChannels.getState().setNotify(mode)} />
              </div>
            )}
            {isOwner && (
              <label className="flex flex-col gap-1 text-sm font-medium">
                {t("channels.dmAddPeople")}
                <div className="flex gap-1">
                  <Input value={dmEmail} type="email" placeholder={t("channels.dmSearchPlaceholder")} aria-label={t("channels.dmSearchPlaceholder")} onChange={(event) => setDmEmail(event.target.value)} />
                  <Button type="button" variant="outline" disabled={!dmEmail.trim() || dmBusy} onClick={() => void add()}>{t("channels.dmAddPeople")}</Button>
                </div>
              </label>
            )}
            {blocks.length > 0 && (
              <fieldset>
                <legend className="mb-1 text-sm font-medium">{t("channels.dmBlockedList")}</legend>
                <ul className="flex flex-col gap-1">
                  {blocks.map((person) => (
                    <li key={person.id} className="flex items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">{person.name}</span>
                      <Button type="button" size="xs" variant="ghost" onClick={() => void useChannels.getState().unblockUser(person.id)}>
                        {t("channels.dmUnblock")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </fieldset>
            )}
            <div className="flex flex-wrap gap-1">
              <Button type="button" variant="outline" onClick={() => { if (window.confirm(t("channels.dmLeaveConfirm"))) void onLeave(); }}>
                {t("channels.dmLeave")}
              </Button>
              {isOwner && (
                <Button type="button" variant="destructive" onClick={() => { if (window.confirm(t("channels.dmDeleteConfirm"))) void onDelete(room.revision); }}>
                  {t("channels.deleteRoom")}
                </Button>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("channels.cancel")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("channels.settings")}</DialogTitle>
          <DialogDescription>{t("channels.settingsHelp")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("channels.name")}
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={CHANNEL_LIMITS.nameChars} disabled={!canManage} aria-label={t("channels.name")} />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("channels.description")}
            <Textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={CHANNEL_LIMITS.descriptionChars} rows={3} disabled={!canManage} aria-label={t("channels.description")} />
          </label>
          <fieldset>
            <legend className="mb-1 text-sm font-medium">{t("channels.icon")}</legend>
            <div className="flex flex-wrap gap-1">
              {CHANNEL_ICONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={value}
                  aria-pressed={icon === value}
                  disabled={!canManage}
                  onClick={() => setIcon(value)}
                  className={cn("rounded-lg border px-2 py-1 text-xs", icon === value ? "depth-primary text-primary-foreground border-transparent" : "hover:bg-muted")}
                >
                  {value}
                </button>
              ))}
            </div>
          </fieldset>
          <p className="text-muted-foreground text-xs">{t("channels.visibilityImmutable")}</p>
          <p className="text-muted-foreground text-xs">{t("channels.attachmentsStorageNote")}</p>
          {room.visibility === "group" && (
            <fieldset>
              <legend className="mb-1 text-sm font-medium">{t("channels.groups")}</legend>
              {groups.map((group) => (
                <label key={group.id} className="flex items-center gap-2 py-0.5 text-sm">
                  <input
                    type="checkbox"
                    checked={groupIds.includes(group.id)}
                    disabled={!canManage}
                    onChange={(event) => setGroupIds((ids) => event.target.checked ? [...ids, group.id] : ids.filter((id) => id !== group.id))}
                  />
                  {group.name}
                </label>
              ))}
            </fieldset>
          )}
          {canManage && (
            <fieldset className="flex flex-col gap-2 rounded-lg border p-2">
              <legend className="px-1 text-sm font-medium">{t("channels.aiBinding")}</legend>
              <Select
                value={aiMode}
                onValueChange={(value) => { setAiMode(value); setAiTouched(true); }}
                options={[
                  { value: "none", label: t("channels.aiNone") },
                  { value: "model", label: t("channels.aiModel") },
                  { value: "preset", label: t("channels.aiPreset") },
                ]}
                aria-label={t("channels.aiBinding")}
              />
              {aiMode === "model" && (
                <Select
                  value={modelRef || null}
                  onValueChange={(value) => { setModelRef(value); setAiTouched(true); }}
                  options={models.map((model) => ({ value: model.ref, label: model.name }))}
                  placeholder={t("channels.aiModel")}
                  aria-label={t("channels.aiModel")}
                />
              )}
              {aiMode === "preset" && (
                <>
                  <Select
                    value={presetId || null}
                    onValueChange={(value) => { setPresetId(value); setAiTouched(true); }}
                    options={presets.map((preset) => ({ value: preset.id, label: preset.name }))}
                    placeholder={t("channels.aiPreset")}
                    aria-label={t("channels.aiPreset")}
                  />
                  <p className="text-muted-foreground text-xs">{t("channels.aiReducedNotice")}</p>
                  <label className="flex items-center justify-between gap-2 text-xs">
                    {t("channels.aiDisclosure")}
                    <Switch checked={reduced} onCheckedChange={(value) => { setReduced(value); setAiTouched(true); }} aria-label={t("channels.aiReducedNotice")} />
                  </label>
                </>
              )}
              <p className="text-muted-foreground text-xs">{t("channels.storageTransfer")}</p>
            </fieldset>
          )}
          {canModerate && (
            <div className="flex flex-wrap gap-1">
              <Button type="button" variant="outline" onClick={() => void onArchive(room.archivedAt === null)}>
                {t(room.archivedAt ? "channels.unarchive" : "channels.archive")}
              </Button>
              {!room.membership || room.membership.role !== "owner" ? (
                <Button type="button" variant="outline" onClick={() => void onLeave()}>{t("channels.leave")}</Button>
              ) : (
                <Button type="button" variant="destructive" onClick={() => { if (window.confirm(t("channels.deleteRoomConfirm"))) void onDelete(room.revision); }}>
                  {t("channels.deleteRoom")}
                </Button>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("channels.cancel")}</Button>
          {canManage && (
            <Button
              type="button"
              disabled={busy || bindingInvalid || (room.visibility === "group" && !audienceReady)}
              onClick={async () => {
                setBusy(true);
                const ok = await onSave({ revision: room.revision, name, description, icon, groupIds: room.visibility === "group" ? groupIds : [], ai: binding });
                setBusy(false);
                if (ok) onOpenChange(false);
              }}
            >
              {t("channels.save")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
