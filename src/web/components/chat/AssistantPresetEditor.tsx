import { useMemo, useState } from "react";
import { Loader2Icon } from "lucide-react";
import type { AssistantPreset, PresetConfig, PresetOptions, PresetVisibility, ToolFamily } from "@shared/assistant-presets";
import {
  ASSISTANT_ICONS,
  DEFAULT_ASSISTANT_ICON,
  emptyPresetConfig,
  hasSamplingControls,
  samplingCapabilities,
  validatePresetInput,
} from "@shared/assistant-presets";
import type { ReasoningEffort } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t, type PlainMessageKey } from "@/i18n";
import { ApiError, api } from "@/lib/api";
import { settingsHref } from "@/lib/settings-link";
import { useChatModel } from "@/state/thread-meta";
import { useAssistantPresets } from "@/state/assistant-presets";

/** Static icon components. A closed list, never a remote URL or uploaded SVG. */
export const ASSISTANT_ICON_COMPONENTS = {
  sparkles: SparklesIcon,
  bot: BotIcon,
  "book-open": BookOpenIcon,
  code: CodeIcon,
  "pen-line": PenLineIcon,
  search: SearchIcon,
  "graduation-cap": GraduationCapIcon,
  briefcase: BriefcaseIcon,
} as const;

import { BotIcon, BookOpenIcon, BriefcaseIcon, CodeIcon, GraduationCapIcon, PenLineIcon, SearchIcon, SparklesIcon } from "lucide-react";

const ICON_LABELS: Record<(typeof ASSISTANT_ICONS)[number], PlainMessageKey> = {
  sparkles: "assistants.iconSparkles",
  bot: "assistants.iconBot",
  "book-open": "assistants.iconBookOpen",
  code: "assistants.iconCode",
  "pen-line": "assistants.iconPenLine",
  search: "assistants.iconSearch",
  "graduation-cap": "assistants.iconGraduationCap",
  briefcase: "assistants.iconBriefcase",
};

export function AssistantIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ASSISTANT_ICON_COMPONENTS[(name as keyof typeof ASSISTANT_ICON_COMPONENTS)] ?? SparklesIcon;
  return <Icon className={className} aria-hidden />;
}

const EFFORT_LABELS: Record<ReasoningEffort, PlainMessageKey> = {
  none: "composer.effortNone",
  minimal: "composer.effortMinimal",
  low: "composer.effortLow",
  medium: "composer.effortMedium",
  high: "composer.effortHigh",
  xhigh: "composer.effortXhigh",
  max: "composer.effortMax",
};

/** Literal catalog keys, so the unused-key check can see every family label the server can send. */
const FAMILY_LABELS: Record<ToolFamily, PlainMessageKey> = {
  web: "assistants.familyWeb",
  memory: "assistants.familyMemory",
  knowledge: "assistants.familyKnowledge",
  skills: "assistants.familySkills",
  "email-read": "assistants.familyEmailRead",
  "email-write": "assistants.familyEmailWrite",
  drafts: "assistants.familyDrafts",
  artifacts: "assistants.familyArtifacts",
  images: "assistants.familyImages",
  code: "assistants.familyCode",
  widgets: "assistants.familyWidgets",
  delegate: "assistants.familyDelegate",
  research: "assistants.familyResearch",
  attachments: "assistants.familyAttachments",
};

export interface EditorDraft {
  name: string;
  description: string;
  icon: (typeof ASSISTANT_ICONS)[number];
  config: PresetConfig;
  visibility: PresetVisibility;
}

export const draftOf = (preset: AssistantPreset | null): EditorDraft =>
  preset
    ? { name: preset.name, description: preset.description, icon: preset.icon, config: preset.config, visibility: preset.visibility }
    : { name: "", description: "", icon: DEFAULT_ASSISTANT_ICON, config: emptyPresetConfig(), visibility: "private" };

/**
 * The private builder. Its state never leaves this component; Save is explicit, and a conflict keeps the
 * typed values so nothing is silently lost.
 */
export function AssistantPresetEditor({
  preset,
  options,
  onSaved,
  onCancel,
}: {
  preset: AssistantPreset | null;
  options: PresetOptions;
  onSaved: (preset: AssistantPreset) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<EditorDraft>(() => draftOf(preset));
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(draftOf(preset)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const loadMine = useAssistantPresets((s) => s.loadMine);
  const chatModel = useChatModel();

  const dirty = JSON.stringify(draft) !== savedSnapshot;
  const model = draft.config.modelRef ? options.models.find((entry) => entry.ref === draft.config.modelRef) : chatModel;
  const caps = useMemo(
    () =>
      model && "maxOutput" in model
        ? samplingCapabilities(model, draft.config.reasoningEffort)
        : { temperature: false, topP: false, maxOutputTokens: false, maxOutput: 0, temperatureMax: 2 },
    [model, draft.config.reasoningEffort],
  );
  const patchConfig = (patch: Partial<PresetConfig>) => setDraft((current) => ({ ...current, config: { ...current.config, ...patch } }));
  const toggleFamily = (family: ToolFamily) =>
    patchConfig({
      tools: {
        ...draft.config.tools,
        mode: "selected",
        builtins: draft.config.tools.builtins.includes(family)
          ? draft.config.tools.builtins.filter((entry) => entry !== family)
          : [...draft.config.tools.builtins, family].sort(),
      },
    });
  const toggleCollection = (id: string) =>
    patchConfig({
      knowledge: {
        mode: "selected",
        ids: draft.config.knowledge.ids.includes(id) ? draft.config.knowledge.ids.filter((entry) => entry !== id) : [...draft.config.knowledge.ids, id].slice(0, 20),
      },
    });
  const toggleMcp = (serverId: string, toolName: string) => {
    const exists = draft.config.tools.mcpTools.some((entry) => entry.serverId === serverId && entry.toolName === toolName);
    patchConfig({
      tools: {
        ...draft.config.tools,
        mode: "selected",
        mcpTools: exists
          ? draft.config.tools.mcpTools.filter((entry) => !(entry.serverId === serverId && entry.toolName === toolName))
          : [...draft.config.tools.mcpTools, { serverId, toolName }],
      },
    });
  };

  const save = async () => {
    const validated = validatePresetInput(draft);
    if (!validated.ok) {
      setError(validated.message);
      return;
    }
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      const body = { ...validated.value, ...(preset ? { expectedRevision: preset.revision } : {}) };
      const saved = await api<AssistantPreset>(preset ? `/assistant-presets/${preset.id}` : "/assistant-presets", {
        method: preset ? "PUT" : "POST",
        json: body,
      });
      setSavedSnapshot(JSON.stringify(draftOf(saved)));
      void loadMine();
      onSaved(saved);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) setConflict(true);
      setError(cause instanceof Error ? cause.message : t("assistants.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const requestClose = () => {
    if (dirty) setDiscarding(true);
    else onCancel();
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pe-1">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("assistants.name")}</span>
            <Input value={draft.name} maxLength={80} onChange={(event) => setDraft((current) => ({ ...current, name: event.currentTarget.value }))} autoFocus />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("assistants.icon")}</span>
            <Select
              value={draft.icon}
              onValueChange={(icon) => setDraft((current) => ({ ...current, icon }))}
              options={ASSISTANT_ICONS.map((icon) => ({ value: icon, label: t(ICON_LABELS[icon]) }))}
              aria-label={t("assistants.icon")}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("assistants.description")}</span>
          <Input value={draft.description} maxLength={240} onChange={(event) => setDraft((current) => ({ ...current, description: event.currentTarget.value }))} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("assistants.model")}</span>
          <Select
            value={draft.config.modelRef ?? ""}
            onValueChange={(ref) => patchConfig({ modelRef: ref || null })}
            options={[{ value: "", label: t("assistants.useChatModel") }, ...options.models.map((entry) => ({ value: entry.ref, label: `${entry.name} · ${entry.providerId}` }))]}
            aria-label={t("assistants.model")}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("assistants.instructions")}</span>
          <Textarea
            value={draft.config.instructions}
            rows={8}
            className="min-h-40 font-mono text-sm whitespace-pre-wrap"
            maxLength={20_000}
            onChange={(event) => patchConfig({ instructions: event.currentTarget.value })}
          />
        </label>

        <details open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)} className="rounded-xl border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">{t("assistants.advanced")}</summary>
          <div className="mt-3 grid gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t("assistants.reasoning")}</span>
              <Select
                value={draft.config.reasoningEffort ?? ""}
                onValueChange={(value) => patchConfig({ reasoningEffort: value ? (value as ReasoningEffort) : undefined })}
                options={[{ value: "", label: t("assistants.providerDefault") }, ...(model && "reasoningEfforts" in model ? (model.reasoningEfforts ?? []).map((effort) => ({ value: effort, label: t(EFFORT_LABELS[effort as ReasoningEffort] ?? "assistants.reasoning") })) : [])]}
                aria-label={t("assistants.reasoning")}
              />
            </label>
            {hasSamplingControls(caps) && (
              <div className="grid gap-3 sm:grid-cols-2">
                {caps.temperature && (
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">{t("assistants.temperature")}</span>
                    <Input
                      type="number"
                      step="0.1"
                      min={0}
                      max={caps.temperatureMax}
                      value={draft.config.sampling.temperature ?? ""}
                      placeholder={t("assistants.providerDefault")}
                      onChange={(event) => {
                        const value = event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value);
                        patchConfig({ sampling: { ...draft.config.sampling, temperature: value, topP: undefined } });
                      }}
                    />
                  </label>
                )}
                {caps.topP && (
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">{t("assistants.topP")}</span>
                    <Input
                      type="number"
                      step="0.05"
                      min={0.01}
                      max={1}
                      value={draft.config.sampling.topP ?? ""}
                      placeholder={t("assistants.providerDefault")}
                      onChange={(event) => {
                        const value = event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value);
                        patchConfig({ sampling: { ...draft.config.sampling, topP: value, temperature: undefined } });
                      }}
                    />
                  </label>
                )}
                {caps.maxOutputTokens && (
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">{t("assistants.maxOutput")}</span>
                    <Input
                      type="number"
                      step="1"
                      min={1}
                      max={Math.min(caps.maxOutput, 131_072)}
                      value={draft.config.sampling.maxOutputTokens ?? ""}
                      placeholder={t("assistants.providerDefault")}
                      onChange={(event) => {
                        const value = event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value);
                        patchConfig({ sampling: { ...draft.config.sampling, maxOutputTokens: value } });
                      }}
                    />
                  </label>
                )}
              </div>
            )}
            {!hasSamplingControls(caps) && <p className="text-muted-foreground text-xs">{t("assistants.unsupportedSampling")}</p>}
            {(draft.config.sampling.temperature !== undefined || draft.config.sampling.topP !== undefined || draft.config.sampling.maxOutputTokens !== undefined) && (
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => patchConfig({ sampling: {} })}>
                {t("assistants.clearUnsupported")}
              </Button>
            )}
          </div>
        </details>

        <fieldset className="flex flex-col gap-2 rounded-xl border px-3 py-3">
          <legend className="px-1 text-sm font-medium">{t("assistants.tools")}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="tool-mode"
              checked={draft.config.tools.mode === "inherit"}
              onChange={() => patchConfig({ tools: { mode: "inherit", builtins: [], mcpTools: [] } })}
            />
            {t("assistants.inheritTools")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="tool-mode" checked={draft.config.tools.mode === "selected"} onChange={() => patchConfig({ tools: { ...draft.config.tools, mode: "selected" } })} />
            {t("assistants.selectedTools")}
          </label>
          {draft.config.tools.mode === "selected" && (
            <div className="grid gap-1.5 ps-6 sm:grid-cols-2">
              {options.builtins.map((entry) => (
                <label key={entry.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.config.tools.builtins.includes(entry.id)}
                    onChange={() => toggleFamily(entry.id as ToolFamily)}
                  />
                  <span>{t(FAMILY_LABELS[entry.id as ToolFamily] ?? "assistants.tools")}</span>
                  {!entry.available && <span className="text-muted-foreground text-xs">{t("assistants.unavailable")}</span>}
                </label>
              ))}
              {options.mcpTools.length ? (
                options.mcpTools.map((tool) => (
                  <label key={`${tool.serverId}:${tool.toolName}`} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.config.tools.mcpTools.some((entry) => entry.serverId === tool.serverId && entry.toolName === tool.toolName)}
                      onChange={() => toggleMcp(tool.serverId, tool.toolName)}
                    />
                    <span className="truncate">{tool.serverName} · {tool.toolName}</span>
                    {!tool.available && <span className="text-muted-foreground text-xs">{t("assistants.unavailable")}</span>}
                  </label>
                ))
              ) : (
                <a href={settingsHref("mcp")} className="text-muted-foreground text-xs underline underline-offset-4">
                  {t("assistants.connectTools")}
                </a>
              )}
              {!draft.config.tools.builtins.length && !draft.config.tools.mcpTools.length && <p className="text-muted-foreground text-xs sm:col-span-2">{t("assistants.noTools")}</p>}
            </div>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-2 rounded-xl border px-3 py-3">
          <legend className="px-1 text-sm font-medium">{t("assistants.knowledge")}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="knowledge-mode" checked={draft.config.knowledge.mode === "inherit"} onChange={() => patchConfig({ knowledge: { mode: "inherit", ids: [] } })} />
            {t("assistants.inheritKnowledge")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="knowledge-mode" checked={draft.config.knowledge.mode === "selected"} onChange={() => patchConfig({ knowledge: { ...draft.config.knowledge, mode: "selected" } })} />
            {t("assistants.selectedKnowledge")}
          </label>
          {draft.config.knowledge.mode === "selected" && (
            <>
              <div className="grid gap-1.5 ps-6 sm:grid-cols-2">
                {options.collections.map((collection) => (
                  <label key={collection.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={draft.config.knowledge.ids.includes(collection.id)} onChange={() => toggleCollection(collection.id)} />
                    <span className="truncate">{collection.name}</span>
                  </label>
                ))}
              </div>
              <p className="text-muted-foreground text-xs">{t("assistants.knowledgeHint")}</p>
            </>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-2 rounded-xl border px-3 py-3">
          <legend className="px-1 text-sm font-medium">{t("assistants.sharing")}</legend>
          <div className="flex items-start justify-between gap-4">
            <span className="text-sm">{t("assistants.publish")}</span>
            <Switch checked={draft.visibility === "published"} onCheckedChange={(value) => setDraft((current) => ({ ...current, visibility: value ? "published" : "private" }))} aria-label={t("assistants.publish")} />
          </div>
          <p className="text-muted-foreground text-xs">{t("assistants.publishNotice")}</p>
          {draft.visibility === "published" && (
            <p className="text-muted-foreground text-xs">
              {t("assistants.publishRestrictions")}{" "}
              <button
                type="button"
                className="underline underline-offset-4"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    visibility: "private",
                    config: { ...current.config, knowledge: { mode: "inherit", ids: [] }, tools: { ...current.config.tools, mode: "selected", mcpTools: [] } },
                  }))
                }
              >
                {t("assistants.createPublishableCopy")}
              </button>
            </p>
          )}
        </fieldset>

        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {conflict && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                if (!preset) return;
                const stored = await api<AssistantPreset>(`/assistant-presets/${preset.id}`);
                setDraft(draftOf(stored));
                setSavedSnapshot(JSON.stringify(draftOf(stored)));
                setConflict(false);
                setError(null);
              }}
            >
              {t("assistants.reloadStored")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConflict(false)}>
              {t("assistants.keepEditing")}
            </Button>
          </div>
        )}
      </div>

      <DialogFooter className="mt-3">
        <Button type="button" variant="outline" onClick={requestClose} disabled={saving}>
          {t("common.cancel")}
        </Button>
        <Button type="button" onClick={() => void save()} disabled={saving || !draft.name.trim()}>
          {saving && <Loader2Icon className="animate-spin" />} {t("common.save")}
        </Button>
      </DialogFooter>

      <Dialog open={discarding} onOpenChange={(open) => !open && setDiscarding(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">{t("assistants.discardChanges")}</DialogTitle>
            <DialogDescription>{t("assistants.saveFailed")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDiscarding(false)}>
              {t("assistants.keepEditing")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setDiscarding(false);
                onCancel();
              }}
            >
              {t("assistants.discard")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A confirm dialog that never hijacks a user click: the caller says what will change. */
export function AssistantConfirm({
  open,
  title,
  description,
  confirmLabel,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
