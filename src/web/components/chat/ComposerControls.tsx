import { ComposerPrimitive, useAui } from "@assistant-ui/react";
import { BrainIcon, BookOpenIcon, CheckIcon, ChevronRightIcon, GlobeIcon, GlobeOffIcon, Loader2Icon, PaperclipIcon, PlusIcon, SettingsIcon, SquareSlashIcon, TelescopeIcon, TriangleAlertIcon, ZapIcon } from "lucide-react";
import { Fragment, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import type { McpPromptInfo } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { formatNumber } from "@/i18n/format";
import { api } from "@/lib/api";
import { settingsHref } from "@/lib/settings-link";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { useChatModel } from "@/state/thread-meta";
import { useChatSearch } from "@/state/chat-search";
import { useChatResearch } from "@/state/chat-research";
import { sharedTooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/keyboard/Kbd";
import { ariaCombo } from "@/keyboard/keys";
import { useCommand, useShortcut } from "@/keyboard/registry";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSubmenuRoot, MenuSubmenuTrigger, MenuTrigger } from "@/components/ui/menu";
import { effortLabel, useEffortChoices } from "./ModelPicker";
import { KnowledgeMenuItems } from "@/components/knowledge/KnowledgeSelector";
import { useChatKnowledge } from "@/state/chat-knowledge";

const triggerClass =
  "hover:bg-muted text-muted-foreground hover:text-foreground aria-expanded:bg-muted flex h-7 shrink-0 pointer-coarse:h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors duration-(--motion-fast) ease-out-quart";

export function SearchToggle() {
  const { enabled, toggle } = useChatSearch();
  const active = useChatModel();
  const webTools = useData((s) => s.settings?.webTools ?? true);
  // Registered here, not as a click target: on phones the toggle lives in the plus menu.
  useCommand("composer.search", toggle, !!active?.toolCall && webTools);
  if (!active?.toolCall || !webTools) return null;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={enabled}
      className={cn(
        triggerClass,
        "flex max-sm:hidden pointer-coarse:hidden",
        // Pressed state replaces the trigger's hover colors, so both must be overridden with `!`.
        enabled && "bg-primary/12! text-primary! hover:bg-primary/18!",
      )}
    >
      {enabled ? <GlobeIcon className="size-3.5" /> : <GlobeOffIcon className="size-3.5" />}
      {t("composer.search")}
    </button>
  );
}

/**
 * Deep research for this chat. Hidden where the model or account has no web tools, like Search, unless it is
 * on: then it stays visible with the reason it cannot run, because sending would be refused.
 */
export function ResearchToggle() {
  const { enabled, toggle, unavailable, searches, steps } = useChatResearch();
  const webTools = useData((s) => s.settings?.webTools ?? true);
  const toolCall = !!useChatModel()?.toolCall;
  // Turning it off always works; turning it on only where it can run.
  const usable = enabled || !unavailable;
  useCommand("composer.research", toggle, usable);
  const combo = useShortcut("composer.research");
  const blocked = unavailable && enabled;
  const hint = blocked ? `${t(unavailable)} ${t("composer.researchTurnOff")}.` : unavailable ? t(unavailable) : t("composer.researchHint", { searches, steps });
  const payload = useMemo(
    () => ({ tooltip: combo && usable ? <span className="flex items-center gap-2">{hint}<Kbd combo={combo} /></span> : hint, side: "top" as const }),
    [hint, combo, usable],
  );
  if (!enabled && !(toolCall && webTools)) return null;
  return (
    <>
      <TooltipTrigger
        handle={sharedTooltip}
        payload={payload}
        render={
          <button
            type="button"
            onClick={() => usable && toggle()}
            aria-pressed={enabled}
            aria-disabled={!usable || undefined}
            aria-description={hint}
            aria-keyshortcuts={combo && usable ? ariaCombo(combo) : undefined}
            className={cn(
              triggerClass,
              "flex max-sm:hidden pointer-coarse:hidden",
              !usable && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground",
              enabled && !blocked && "bg-primary/12! text-primary! hover:bg-primary/18!",
              blocked && "bg-warning/12! text-warning! hover:bg-warning/18!",
            )}
          />
        }
      >
        {blocked ? <TriangleAlertIcon className="size-3.5" /> : <TelescopeIcon className="size-3.5" />}
        {t("composer.deepResearch")}
      </TooltipTrigger>
      {(unavailable === "composer.researchNeedsWeb" || unavailable === "composer.researchNeedsSearches") && (
        <Link
          href={settingsHref(unavailable === "composer.researchNeedsWeb" ? "webTools" : "webSearchLimit")}
          data-command={unavailable === "composer.researchNeedsWeb" ? "settings.webTools" : "settings.webSearchLimit"}
          aria-label={unavailable === "composer.researchNeedsWeb" ? t("ux.openWebToolSettings") : t("ux.openSearchLimitSettings")}
          className={cn(triggerClass, "max-sm:hidden pointer-coarse:hidden focus-visible:outline-ring")}
        >
          <SettingsIcon className="size-3.5" />
        </Link>
      )}
    </>
  );
}

/** Puts a filled-in prompt into the composer, after anything already typed. */
function usePromptPicker() {
  const aui = useAui();
  const [open, setOpen] = useState<McpPromptInfo | null>(null);
  const insert = async (prompt: McpPromptInfo, args: Record<string, string>) => {
    const { text } = await api<{ text: string }>(`/mcp/${prompt.serverId}/prompts`, { method: "POST", json: { name: prompt.name, arguments: args } });
    const current = aui.composer().getState().text.trim();
    aui.composer().setText(current ? `${current}\n\n${text}` : text);
  };
  const pick = (prompt: McpPromptInfo) => {
    if (prompt.arguments.length) setOpen(prompt);
    else void insert(prompt, {}).catch(() => setOpen(prompt));
  };
  const dialog = <PromptDialog prompt={open} onClose={() => setOpen(null)} onSubmit={insert} />;
  return { pick, dialog };
}

function PromptItems({ onPick }: { onPick: (prompt: McpPromptInfo) => void }) {
  const prompts = useData((s) => s.mcpPrompts);
  const servers = [...new Set(prompts.map((p) => p.server))];
  return servers.map((server) => (
    <Fragment key={server}>
      <MenuLabel>{server}</MenuLabel>
      {prompts
        .filter((p) => p.server === server)
        .map((p) => (
          <MenuItem key={`${p.serverId}:${p.name}`} onClick={() => onPick(p)} className="flex-col items-start gap-0">
            <span>{p.title ?? p.name}</span>
            {p.description && <span className="line-clamp-2 text-xs opacity-70">{p.description}</span>}
          </MenuItem>
        ))}
    </Fragment>
  ));
}

function PromptDialog({
  prompt,
  onClose,
  onSubmit,
}: {
  prompt: McpPromptInfo | null;
  onClose: () => void;
  onSubmit: (prompt: McpPromptInfo, args: Record<string, string>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The closing animation still shows the last prompt, so the dialog does not collapse while it fades.
  const [shown, setShown] = useState(prompt);
  if (prompt && prompt !== shown) {
    setShown(prompt);
    setValues({});
    setError(null);
  }
  return (
    <Dialog open={!!prompt} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-3 sm:max-w-md">
        {shown && (
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                // Optional arguments left empty are not sent, so the server applies its own default.
                await onSubmit(shown, Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())));
                onClose();
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <DialogTitle className="pe-6 text-base">{shown.title ?? shown.name}</DialogTitle>
            <DialogDescription>{shown.description ?? t("composer.promptFrom", { server: shown.server })}</DialogDescription>
            {shown.arguments.map((arg, index) => (
              <label key={arg.name} className="flex flex-col gap-1 text-xs">
                <span className="font-medium">
                  {arg.name}
                  {arg.required && <span className="text-muted-foreground"> {t("composer.required")}</span>}
                </span>
                <Input
                  autoFocus={index === 0}
                  required={arg.required}
                  value={values[arg.name] ?? ""}
                  onChange={(e) => setValues({ ...values, [arg.name]: e.target.value })}
                />
                {arg.description && <span className="text-muted-foreground">{arg.description}</span>}
              </label>
            ))}
            {error && <p className="text-error text-xs">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2Icon className="animate-spin" />}
                {t("composer.insert")}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Desktop: shown only when the user's MCP servers offer prompt templates. */
export function McpPromptsButton() {
  const hasPrompts = useData((s) => s.mcpPrompts.length > 0);
  const load = useData((s) => s.refreshMcpPrompts);
  const { pick, dialog } = usePromptPicker();
  if (!hasPrompts) return null;
  return (
    <>
      <Menu onOpenChange={(open) => open && void load()}>
        <MenuTrigger aria-label={t("composer.mcpPrompts")} data-command="composer.prompts" className={cn(triggerClass, "max-sm:hidden pointer-coarse:hidden")}>
          <SquareSlashIcon className="size-3.5" />
          {t("composer.prompts")}
        </MenuTrigger>
        <MenuContent side="top" align="start" className="max-h-80 w-72">
          <PromptItems onPick={pick} />
        </MenuContent>
      </Menu>
      {dialog}
    </>
  );
}

/** Touch and narrow layout: the plus button opens reasoning, search, and attachment choices in one menu. */
export function MobileComposerMenu() {
  const { active, current, options, set } = useEffortChoices();
  const { enabled, toggle } = useChatSearch();
  const webTools = useData((s) => s.settings?.webTools ?? true);
  const showSearch = !!active?.toolCall && webTools;
  const research = useChatResearch();
  const knowledge = useChatKnowledge();
  const researchBlocked = !!research.unavailable && research.enabled;
  const hasPrompts = useData((s) => s.mcpPrompts.length > 0);
  const loadPrompts = useData((s) => s.refreshMcpPrompts);
  const { pick, dialog } = usePromptPicker();
  const [, navigate] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  // The desktop trigger is hidden here. The command opens this menu and its knowledge submenu instead.
  useCommand("composer.knowledge", () => {
    const phone = typeof window !== "undefined" && (window.matchMedia("(max-width: 639.98px)").matches || window.matchMedia("(pointer: coarse)").matches);
    if (!phone) return false;
    mobileTrigger.current?.focus({ preventScroll: true });
    setMenuOpen(true);
    setKnowledgeOpen(true);
  }, !!active?.toolCall && !knowledge.temporary);
  return (
    <div className="hidden shrink-0 max-sm:block pointer-coarse:block">
      {dialog}
      <Menu
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (!open) setKnowledgeOpen(false);
          else if (hasPrompts) void loadPrompts();
        }}
      >
        <MenuTrigger
          ref={mobileTrigger}
          aria-label={t("composer.composerOptions")}
          className="aui-composer-add-attachment text-muted-foreground hover:text-foreground hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 pointer-coarse:size-9 rounded-full flex items-center justify-center transition-[color,background-color,scale] active:scale-[0.96] motion-reduce:transition-none"
        >
          <PlusIcon className="size-4" />
        </MenuTrigger>
        <MenuContent side="top" align="start" className="min-w-52">
          {active?.reasoning && (
            <MenuSubmenuRoot>
              <MenuSubmenuTrigger>
                {current === "none" ? <ZapIcon /> : <BrainIcon />}
                <span className="flex-1">{t("composer.reasoningValue", { value: current ? effortLabel(current) : t("composer.effortDefault") })}</span>
                <ChevronRightIcon className="text-muted-foreground ml-auto" />
              </MenuSubmenuTrigger>
              {/* -5px (border + padding) lines the submenu's top edge up with the parent menu's. */}
              <MenuContent side="right" align="start" alignOffset={-5}>
                <MenuLabel>{t("composer.reasoningEffort")}</MenuLabel>
                <MenuItem onClick={() => set(undefined)}>
                  <CheckIcon className={cn(!current ? "opacity-100" : "opacity-0")} />
                  {t("composer.modelDefault")}
                </MenuItem>
                {options.map((e) => (
                  <MenuItem key={e} onClick={() => set(e)}>
                    <CheckIcon className={cn(current === e ? "opacity-100" : "opacity-0")} />
                    {effortLabel(e)}
                  </MenuItem>
                ))}
              </MenuContent>
            </MenuSubmenuRoot>
          )}
          {showSearch && (
            <MenuItem
              closeOnClick={false}
              onClick={toggle}
              className={cn(enabled && "depth-primary text-primary-foreground")}
            >
              {enabled ? <GlobeIcon /> : <GlobeOffIcon />}
              <span className="flex-1">{t("composer.search")}</span>
              <CheckIcon className={cn("ml-auto", enabled ? "opacity-100" : "opacity-0")} />
            </MenuItem>
          )}
          {(showSearch || research.enabled) && (
            <MenuItem
              closeOnClick={false}
              disabled={!!research.unavailable && !research.enabled}
              onClick={research.toggle}
              className={cn(research.enabled && !researchBlocked && "depth-primary text-primary-foreground", "items-start")}
            >
              {researchBlocked ? <TriangleAlertIcon className="text-warning mt-0.5" /> : <TelescopeIcon className="mt-0.5" />}
              <span className="flex flex-1 flex-col">
                <span>{t("composer.deepResearch")}</span>
                <span className="text-xs opacity-70">{research.unavailable ? t(research.unavailable) : t("composer.researchSearchNotice")}</span>
              </span>
              <CheckIcon className={cn("mt-0.5 ml-auto", research.enabled ? "opacity-100" : "opacity-0")} />
            </MenuItem>
          )}
          {research.unavailable === "composer.researchNeedsWeb" && (
            <MenuItem data-command="settings.webTools" onClick={() => navigate(settingsHref("webTools"))}>
              <SettingsIcon />
              {t("ux.openWebToolSettings")}
            </MenuItem>
          )}
          {research.unavailable === "composer.researchNeedsSearches" && (
            <MenuItem data-command="settings.webSearchLimit" onClick={() => navigate(settingsHref("webSearchLimit"))}>
              <SettingsIcon />
              {t("ux.openSearchLimitSettings")}
            </MenuItem>
          )}
          {active?.toolCall && !knowledge.temporary && (
            <MenuSubmenuRoot open={knowledgeOpen} onOpenChange={setKnowledgeOpen}>
              <MenuSubmenuTrigger>
                <BookOpenIcon />
                <span className="flex-1">{t("knowledge.selector")}</span>
                {knowledge.ids.length > 0 && <span className="text-muted-foreground text-xs tabular-nums">{formatNumber(knowledge.ids.length)}</span>}
                <ChevronRightIcon className="text-muted-foreground ml-auto" />
              </MenuSubmenuTrigger>
              <MenuContent side="right" align="start" alignOffset={-5} className="max-h-80 w-72">
                <KnowledgeMenuItems />
              </MenuContent>
            </MenuSubmenuRoot>
          )}
          {hasPrompts && (
            <MenuSubmenuRoot>
              <MenuSubmenuTrigger>
                <SquareSlashIcon />
                <span className="flex-1">{t("composer.prompts")}</span>
                <ChevronRightIcon className="text-muted-foreground ml-auto" />
              </MenuSubmenuTrigger>
              <MenuContent side="right" align="start" alignOffset={-5} className="max-h-80 w-64">
                <PromptItems onPick={pick} />
              </MenuContent>
            </MenuSubmenuRoot>
          )}
          <ComposerPrimitive.AddAttachment render={<MenuItem />}>
            <PaperclipIcon />
            {t("composer.attach")}
          </ComposerPrimitive.AddAttachment>
        </MenuContent>
      </Menu>
    </div>
  );
}
