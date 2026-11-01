import { getExternalStoreMessages, useAui, useAuiState } from "@assistant-ui/react";
import type { UIMessage } from "ai";
import type { ThreadSummary } from "@shared/types";
import { CalendarClockIcon, MonitorIcon, MoonIcon, MoreHorizontalIcon, PuzzleIcon, SunIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { CallButton } from "@/speech/call/CallButton";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GhostIcon } from "@/components/chat/GhostIcon";
import { ShareButton } from "@/components/share/ShareButton";
import { t, type PlainMessageKey } from "@/i18n";
import { api } from "@/lib/api";
import { settingsHref } from "@/lib/settings-link";
import { cn } from "@/lib/utils";
import { useAppearance } from "@/state/appearance";
import { getActiveModel, useData } from "@/state/data";
import { chatPrivacyFor, useChatPrivacy, useChatPrivacyStore } from "@/state/chat-privacy";
import { useCurrentThreadId, useThreadMeta, useThreadMetaStore } from "@/state/thread-meta";
import { useThreadSync } from "@/state/thread-sync";
import { runCommand, useCommand } from "@/keyboard/registry";

const MODES = [
  { mode: "light", label: "composer.schemeLight", Icon: SunIcon },
  { mode: "system", label: "composer.schemeSystem", Icon: MonitorIcon },
  { mode: "dark", label: "composer.schemeDark", Icon: MoonIcon },
] as const satisfies ReadonlyArray<{ mode: string; label: PlainMessageKey; Icon: unknown }>;

function ColorSchemeToggle() {
  const mode = useAppearance((s) => s.mode);
  const setMode = useAppearance((s) => s.setMode);
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm font-medium">{t("composer.colorScheme")}</span>
      <div role="group" aria-label={t("composer.colorScheme")} className="bg-muted flex rounded-lg p-0.5">
        {MODES.map(({ mode: value, label, Icon }) => (
          <button
            key={value}
            type="button"
            aria-label={t(label)}
            aria-pressed={mode === value}
            title={t(label)}
            onClick={() => setMode(value)}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-md transition-[color,background-color,box-shadow] duration-(--motion-fast) ease-out-quart",
              mode === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
          </button>
        ))}
      </div>
    </div>
  );
}

const ghostButtonClass = (active: boolean) => cn(
  "surface-glass relative z-20 inline-flex size-8 pointer-coarse:size-10 items-center justify-center rounded-lg border transition-colors duration-(--motion-fast) ease-out-quart disabled:opacity-50",
  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
);

/** Sent as a user message; the drafted skill only lands after create_skill is approved. */
const CREATE_SKILL_PROMPT =
  "Turn this chat into a reusable skill I can use in future chats. Draft it yourself from what we covered: " +
  "a name (lowercase kebab-case, max 64 characters), a one-sentence description (what the skill does and when to use it), " +
  "and the full SKILL.md instructions in Markdown — the steps, conventions, and context from this chat that a future " +
  "conversation would need. Include reusable reference material or templates as extra files where they help. " +
  "Call create_skill with the draft so I can approve it.";

/** Chat-level choices belong to the header; the composer is reserved for writing and model controls. */
export function ChatPrivacyMenu() {
  const aui = useAui();
  const privacy = useChatPrivacy();
  const meta = useThreadMeta();
  const running = useAuiState((s) => s.thread.isRunning);
  const syncing = !!useThreadSync();
  const started = useAuiState((s) => s.thread.messages.length > 0);
  const remoteId = useCurrentThreadId();
  const refresh = useThreadMetaStore((s) => s.refresh);
  const [open, setOpen] = useState(false);
  const [ghostOpen, setGhostOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState<boolean | null>(null);
  const [skillsEnabled, setSkillsEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const load = () => void api<{ enabled: boolean }>("/memory/preferences").then((p) => { if (active) setMemoryEnabled(p.enabled); }).catch(() => {});
    load();
    window.addEventListener("focus", load);
    window.addEventListener("okaychat:memory", load);
    return () => { active = false; window.removeEventListener("focus", load); window.removeEventListener("okaychat:memory", load); };
  }, []);
  useEffect(() => {
    let active = true;
    const load = () => void api<{ enabled: boolean }>("/skills/prefs").then((p) => { if (active) setSkillsEnabled(p.enabled); }).catch(() => { if (active) setSkillsEnabled(false); });
    load();
    window.addEventListener("focus", load);
    return () => { active = false; window.removeEventListener("focus", load); };
  }, []);

  const changeChat = async (temporary: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const previous = aui.threadListItem.getState();
      await aui.threads.switchToNewThread();
      // The item scope lags one render behind a switch away from a stored chat; the thread list does not.
      const nextId = aui.threads.getState().mainThreadId;
      useChatPrivacyStore.getState().set(nextId, { temporary, personalized: !temporary });
      if (previous.id !== nextId && chatPrivacyFor(previous).temporary) await aui.threads.item({ id: previous.id }).delete();
      setOpen(false);
      setGhostOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("composer.startChatFailed"));
      // The ghost popover shows its own errors; a plain toggle has nowhere else to report one.
      if (!ghostOpen) setOpen(true);
    }
    finally { setBusy(false); }
  };

  /** Copies the current branch into a new stored thread. Temporary turns recorded no usage, so none is backfilled. */
  const saveChat = async () => {
    setBusy(true);
    setError(null);
    try {
      const previous = aui.threadListItem.getState();
      const messages = aui.thread.getState().messages.flatMap((m) => getExternalStoreMessages<UIMessage>(m));
      const thread = await api<ThreadSummary>("/threads", { method: "POST", json: { projectId: useData.getState().activeProject } });
      let parent: string | null = null;
      for (const { id, ...content } of messages) {
        await api(`/threads/${thread.id}/messages`, { method: "POST", json: { id, parent_id: parent, format: "ai-sdk/v6", content } });
        parent = id;
      }
      const text = messages.filter((m) => m.role === "user").flatMap((m) => m.parts).map((p) => (p.type === "text" ? p.text : "")).join("\n").slice(0, 4000);
      const modelRef = getActiveModel(previous.remoteId)?.ref;
      await api(`/threads/${thread.id}/title`, { method: "POST", json: { text, modelRef } }).catch(() => {});
      await aui.threads.reload();
      aui.threads.switchToThread(thread.id);
      await aui.threads.item({ id: previous.id }).delete();
      setGhostOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("composer.saveChatFailed")); }
    finally { setBusy(false); }
  };

  // A started temporary chat has content worth keeping, so the ghost asks instead of discarding it.
  const asks = privacy.temporary && started;
  useCommand("nav.temporaryChat", () => {
    if (busy || running) return false;
    if (asks) {
      setError(null);
      setGhostOpen(true);
      return;
    }
    // From the keyboard the next step is typing, so focus goes to the new chat's message box.
    void changeChat(!privacy.temporary).then(() => runCommand("chat.focusComposer"));
  });
  const ghostLabel = asks ? t("composer.ghostSaveOrEnd") : privacy.temporary ? t("composer.ghostEnd") : t("composer.ghostStart");

  return (
    <div className="shell-chat-actions absolute top-2 right-2 flex items-center gap-1">
      {!privacy.temporary && <ShareButton />}
      {/* A started chat cannot become temporary, so the share button takes the ghost's place. */}
      {(privacy.temporary || !started) && (
        <Popover open={ghostOpen} onOpenChange={(next) => {
          if (!next) setGhostOpen(false);
          else if (asks) { setError(null); setGhostOpen(true); }
          else void changeChat(!privacy.temporary);
        }}>
          <Tooltip>
            <TooltipTrigger render={<PopoverTrigger disabled={busy || running} aria-pressed={privacy.temporary} aria-label={ghostLabel} className={ghostButtonClass(privacy.temporary)} />}>
              <GhostIcon active={privacy.temporary} className="size-[18px]" />
            </TooltipTrigger>
            <TooltipContent side="bottom">{ghostLabel}</TooltipContent>
          </Tooltip>
          <PopoverContent align="end" className="w-72 max-w-[calc(100vw-1rem)] p-4 pointer-coarse:[&_button]:min-h-11">
            <h2 className="text-sm font-medium">{t("composer.temporaryChat")}</h2>
            <p className="text-muted-foreground mt-1 text-xs">{t("composer.temporaryPopoverBody")}</p>
            <div className="mt-4 flex flex-col gap-2">
              <Button disabled={busy || running} onClick={() => void saveChat()}>{t("composer.saveToHistory")}</Button>
              <Button variant="outline" disabled={busy || running} onClick={() => void changeChat(false)}>{t("composer.endAndDiscard")}</Button>
            </div>
            {error && <p role="alert" className="text-destructive mt-3 text-xs">{error}</p>}
          </PopoverContent>
        </Popover>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger data-command="chat.options" className="surface-glass text-muted-foreground hover:text-foreground relative z-20 inline-flex size-8 pointer-coarse:size-10 items-center justify-center rounded-lg border transition-colors duration-(--motion-fast)" aria-label={t("composer.chatOptions")}>
          <MoreHorizontalIcon className="size-4" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 max-w-[calc(100vw-1rem)] p-4">
          <h2 className="text-sm font-medium">{privacy.temporary ? t("composer.temporaryChat") : t("composer.chatOptions")}</h2>
          {started && <CallButton placement="options" onOpen={() => setOpen(false)} />}
          {privacy.temporary ? <>
            <p className="text-muted-foreground mt-1 text-xs">{t("composer.temporaryOptionsBody")}</p>
            <div className="my-4 flex items-center justify-between gap-4">
              <div>
                <label htmlFor="temporary-personalization" className="text-sm font-medium">{t("composer.personalizeChat")}</label>
                <p className="text-muted-foreground mt-1 text-xs">{t("composer.personalizeChatBody")}</p>
              </div>
              <Switch id="temporary-personalization" checked={privacy.personalized} disabled={busy || running} onCheckedChange={(personalized) => {
                const item = aui.threadListItem.getState();
                useChatPrivacyStore.getState().set(item.remoteId ?? item.id, { temporary: true, personalized });
              }} />
            </div>
          </> : <>
            <div className="my-4 flex items-center justify-between gap-4">
              <div>
                <label htmlFor="chat-memory" className={cn("text-sm font-medium", memoryEnabled !== true && "text-muted-foreground")}>{t("composer.useMemory")}</label>
                <p id="chat-memory-description" className="text-muted-foreground mt-1 text-xs">{memoryEnabled === false ? t("composer.memoryOff") : memoryEnabled !== true ? t("composer.memoryChecking") : t("composer.memoryOn")}</p>
              </div>
              <Switch id="chat-memory" aria-describedby="chat-memory-description" checked={memoryEnabled === true && !meta?.memoryDisabled} disabled={busy || running || memoryEnabled !== true} onCheckedChange={async (enabled) => {
                setBusy(true);
                setError(null);
                try {
                  const { remoteId } = await aui.threadListItem.initialize();
                  await api(`/threads/${remoteId}`, { method: "PATCH", json: { memoryDisabled: !enabled } });
                  await refresh(remoteId);
                } catch (cause) { setError(cause instanceof Error ? cause.message : t("composer.memoryChangeFailed")); }
                finally { setBusy(false); }
              }} />
            </div>
            <Link href={settingsHref("memory")} onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground mb-4 block text-xs underline underline-offset-4">{t("composer.memorySettings")}</Link>
            {skillsEnabled && (
              <button
                type="button"
                disabled={busy || running || syncing}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await aui.thread.append(CREATE_SKILL_PROMPT);
                    setOpen(false);
                  } catch (cause) { setError(cause instanceof Error ? cause.message : t("composer.skillDraftFailed")); }
                  finally { setBusy(false); }
                }}
                className="hover:bg-accent mb-4 -mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-(--motion-fast) disabled:opacity-50"
              >
                <PuzzleIcon className="size-4 shrink-0" />
                {t("composer.createSkill")}
              </button>
            )}
            {started && remoteId && (
              <Link
                href={`/scheduled?thread=${encodeURIComponent(remoteId)}`}
                onClick={() => setOpen(false)}
                className="hover:bg-accent mb-4 -mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors duration-(--motion-fast)"
              >
                <CalendarClockIcon className="size-4 shrink-0" />
                {t("composer.schedulePrompt")}
              </Link>
            )}
          </>}
          <ColorSchemeToggle />
          {error && <p role="alert" className="text-destructive mt-3 text-xs">{error}</p>}
        </PopoverContent>
      </Popover>
    </div>
  );
}
