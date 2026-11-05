import { ComposerPrimitive, useAui } from "@assistant-ui/react";
import { CheckIcon, ChevronRightIcon, GlobeIcon, GlobeOffIcon, PaperclipIcon, PlusIcon, SettingsIcon, SquareSlashIcon, TelescopeIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useLocation } from "wouter";
import { t } from "@/i18n";
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
import { EffortIcon } from "./EffortIcon";
import { effortLabel, useEffortChoices } from "./ModelPicker";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { openPromptPicker } from "@/state/prompt-picker";

const triggerClass =
  "hover:bg-muted text-muted-foreground hover:text-foreground aria-expanded:bg-muted flex h-7 shrink-0 pointer-coarse:h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors duration-(--motion-fast) ease-out-quart";

/** Saves once a drag/key interaction finishes, rather than issuing a request for every pixel. */
function SearchLimitSlider() {
  const saved = useData((s) => s.settings?.maxSearches ?? 5);
  const update = useData((s) => s.updateSettings);
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const committing = useRef(false);
  const commit = async () => {
    if (committing.current || draft === saved) return;
    committing.current = true;
    setBusy(true);
    setError(false);
    try {
      await update({ maxSearches: draft });
    } catch {
      setDraft(useData.getState().settings?.maxSearches ?? 5);
      setError(true);
    } finally {
      committing.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="flex w-60 flex-col gap-2 p-2">
      <div className="flex items-center justify-between gap-3 text-xs font-medium">
        <span>{t("composer.searchSteps")}</span>
        <output className="tabular-nums">{draft}</output>
      </div>
      <input
        type="range"
        aria-label={t("composer.searchSteps")}
        className="settings-slider w-full"
        min={0}
        max={50}
        step={1}
        value={draft}
        disabled={busy}
        style={{ "--settings-slider-progress": `${draft * 2}%`, "--settings-slider-fill-offset": `${0.5 - draft / 50}rem` } as CSSProperties}
        onChange={(event) => setDraft(Number(event.currentTarget.value))}
        onPointerUp={() => void commit()}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={() => void commit()}
        onBlur={() => void commit()}
      />
      <p className="text-muted-foreground text-xs">{t("composer.searchStepsHelp")}</p>
      {error && <p role="alert" className="text-destructive text-xs">{t("composer.searchStepsFailed")}</p>}
    </div>
  );
}

export function SearchToggle() {
  const { enabled, toggle } = useChatSearch();
  const active = useChatModel();
  const webTools = useData((s) => s.settings?.webTools ?? true);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // Registered here, not as a click target: on phones the toggle lives in the plus menu.
  useCommand("composer.search", toggle, !!active?.toolCall && webTools);
  useCommand("composer.searchLimit", () => {
    const phone = window.matchMedia("(max-width: 639.98px), (pointer: coarse)").matches;
    if (phone) return false;
    setOpen(true);
  }, !!active?.toolCall && webTools);
  if (!active?.toolCall || !webTools) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <button
        ref={trigger}
        type="button"
        onClick={toggle}
        onContextMenu={(event) => { event.preventDefault(); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        aria-pressed={enabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t("composer.searchStepsHint")}
        className={cn(
          triggerClass,
          "flex max-sm:hidden pointer-coarse:hidden",
          enabled && "bg-primary/12! text-primary! hover:bg-primary/18!",
        )}
      >
        {enabled ? <GlobeIcon className="size-3.5" /> : <GlobeOffIcon className="size-3.5" />}
        {t("composer.search")}
      </button>
      <PopoverContent anchor={trigger} side="top" aria-label={t("composer.searchSteps")} finalFocus={trigger}>
        {open && <SearchLimitSlider />}
      </PopoverContent>
    </Popover>
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
  const hint = blocked ? `${t(unavailable)} ${t("composer.researchTurnOff")}.` : unavailable ? t(unavailable) : t("composer.researchHint");
  const limits = unavailable ? null : t("composer.researchLimits", { searches, steps });
  const payload = useMemo(
    () => ({
      tooltip: (
        <span className="flex flex-col gap-2 py-1 text-pretty">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{t("composer.deepResearch")}</span>
            {combo && usable && <Kbd combo={combo} />}
          </span>
          <span>{hint}</span>
          {limits && <span className="text-muted-foreground border-t pt-2">{limits}</span>}
        </span>
      ),
      side: "top" as const,
    }),
    [hint, limits, combo, usable],
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
            aria-description={limits ? `${hint} ${limits}` : hint}
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

/** Desktop: the combined prompt picker, always available even while the personal library is empty. */
export function PromptsButton() {
  const loadMcp = useData((s) => s.refreshMcpPrompts);
  return (
    <button
      type="button"
      data-command="composer.prompts"
      aria-label={t("composer.prompts")}
      onClick={() => {
        void loadMcp();
        openPromptPicker();
      }}
      className={cn(triggerClass, "max-sm:hidden pointer-coarse:hidden")}
    >
      <SquareSlashIcon className="size-3.5" />
      {t("composer.prompts")}
    </button>
  );
}

/** Touch and narrow layout: the plus button opens reasoning, search, and attachment choices in one menu. */
export function MobileComposerMenu() {
  const { active, current, options, set } = useEffortChoices();
  const { enabled, toggle } = useChatSearch();
  const webTools = useData((s) => s.settings?.webTools ?? true);
  const showSearch = !!active?.toolCall && webTools;
  const research = useChatResearch();
  const researchBlocked = !!research.unavailable && research.enabled;
  const loadPrompts = useData((s) => s.refreshMcpPrompts);
  const [, navigate] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const [searchLimitOpen, setSearchLimitOpen] = useState(false);
  useCommand("composer.searchLimit", () => {
    const phone = window.matchMedia("(max-width: 639.98px), (pointer: coarse)").matches;
    if (!phone) return false;
    mobileTrigger.current?.focus({ preventScroll: true });
    setMenuOpen(true);
    setSearchLimitOpen(true);
  }, showSearch);
  return (
    <div className="hidden shrink-0 max-sm:block pointer-coarse:block">
      <Menu
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (!open) setSearchLimitOpen(false);
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
                <EffortIcon effort={current} options={options} />
                <span className="flex-1">{t("composer.reasoningValue", { value: effortLabel(current) })}</span>
                <ChevronRightIcon className="text-muted-foreground ml-auto" />
              </MenuSubmenuTrigger>
              {/* -5px (border + padding) lines the submenu's top edge up with the parent menu's. */}
              <MenuContent side="right" align="start" alignOffset={-5}>
                <MenuLabel>{t("composer.reasoningEffort")}</MenuLabel>
                {options.map((e) => (
                  <MenuItem key={e} onClick={() => set(e)}>
                    <EffortIcon effort={e} options={options} />
                    <span className="flex-1">{effortLabel(e)}</span>
                    <CheckIcon className={cn("ml-auto", current === e ? "opacity-100" : "opacity-0")} />
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
          {showSearch && (
            <MenuSubmenuRoot open={searchLimitOpen} onOpenChange={setSearchLimitOpen}>
              <MenuSubmenuTrigger data-command="composer.searchLimit">
                <SettingsIcon />
                <span className="flex-1">{t("composer.searchSteps")}</span>
                <ChevronRightIcon className="text-muted-foreground ml-auto" />
              </MenuSubmenuTrigger>
              <MenuContent side="right" align="start" alignOffset={-5}>
                {searchLimitOpen && <SearchLimitSlider />}
              </MenuContent>
            </MenuSubmenuRoot>
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
          <MenuItem
            onClick={() => {
              setMenuOpen(false);
              void loadPrompts();
              // The dialog lives beside the thread, so opening it after the menu lets go of focus is enough.
              requestAnimationFrame(() => openPromptPicker());
            }}
          >
            <SquareSlashIcon />
            <span className="flex-1">{t("composer.prompts")}</span>
          </MenuItem>
          <ComposerPrimitive.AddAttachment render={<MenuItem />}>
            <PaperclipIcon />
            {t("composer.attach")}
          </ComposerPrimitive.AddAttachment>
        </MenuContent>
      </Menu>
    </div>
  );
}
