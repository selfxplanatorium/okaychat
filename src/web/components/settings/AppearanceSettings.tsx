import { useAppearanceSyncStatus } from "@/state/appearance-sync";
import { t, type PlainMessageKey } from "@/i18n";
import { formatList, formatPercent } from "@/i18n/format";
// Ported from T3Code (MIT, Copyright (c) 2026 T3 Tools Inc.).
// Source: apps/web/src/components/settings/SettingsPanels.tsx (AppearanceSettingsPanel,
// TypographySection, font rows) and ThemeImportDialog.tsx. The theme library and editor live in ./theme.
import { PlusIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { ThemeLibrary } from "@/components/settings/theme/ThemeLibrary";
import { useEffect, useId, useRef, useState } from "react";
import { SettingsPage, SettingsRow, SettingsSection, SettingsSlider } from "@/components/settings/SettingsUI";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, type SelectOption } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { errorText } from "@/lib/error-text";
import { cn } from "@/lib/utils";
import { DEFAULT_APPEARANCE, useAppearance } from "@/state/appearance";
import { MOTION_GROUPS, type AppearanceSettings, type MotionGroup } from "@shared/appearance";
import type { InstalledFont } from "@shared/types";
import { installFont, removeFont, useInstalledFonts } from "@/state/fonts";
import {
  getCustomThemes,
  getThemeModes,
  installCustomTheme,
  isReservedThemeId,
  updateCustomTheme,
  parseThemeFile,
  resolveThemeAppearance,
  type ThemeAppearance,
  type ThemeDefinition,
} from "@/theme/palette";
import { BUILT_IN_THEMES } from "@/theme/palettes";
import { BUNDLED_FONTS } from "@/theme/bundled-fonts";
import {
  cssFontFamilies,
  DEFAULT_SANS_FONT_LABEL,
  isMonospaceFamily,
  queryInstalledFontFamilies,
} from "@/theme/fonts";
import {
  MAX_APPEARANCE_CONTRAST,
  MAX_CODE_FONT_SIZE,
  MAX_GLASS_OPACITY,
  MAX_INTERFACE_FONT_SIZE,
  MAX_PANEL_ANIMATION_DURATION_MS,
  MAX_PROMPT_FONT_SIZE,
  MIN_APPEARANCE_CONTRAST,
  MIN_CODE_FONT_SIZE,
  MIN_GLASS_OPACITY,
  MIN_INTERFACE_FONT_SIZE,
  MIN_PANEL_ANIMATION_DURATION_MS,
  MIN_PROMPT_FONT_SIZE,
  type ChatWidth,
} from "@/theme/settings";
import { isVsCodeThemeFile, pairVsCodeThemes, parseVsCodeThemeFile, resolveThemeLabelCollisions } from "@/theme/vscode-import";

const MOTION_OPTIONS: Array<{ group: MotionGroup; label: PlainMessageKey; description: PlainMessageKey }> = [
  { group: "interface", label: "appearance.motionInterface", description: "appearance.motionInterfaceDescription" },
  { group: "transitions", label: "appearance.motionTransitions", description: "appearance.motionTransitionsDescription" },
  { group: "icons", label: "appearance.motionIcons", description: "appearance.motionIconsDescription" },
  { group: "loading", label: "appearance.motionLoading", description: "appearance.motionLoadingDescription" },
];

const CHAT_WIDTH_OPTIONS: Array<{ value: ChatWidth; label: PlainMessageKey }> = [
  { value: "comfortable", label: "appearance.chatWidthComfortable" },
  { value: "wide", label: "appearance.chatWidthWide" },
  { value: "full", label: "appearance.chatWidthFull" },
];

/** Tracks the OS scheme so the library follows "System" live. */
function useResolvedAppearance(): ThemeAppearance {
  const theme = useAppearance((s) => s.theme);
  const mode = useAppearance((s) => s.mode);
  const halves = useAppearance((s) => s.halves);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return resolveThemeAppearance(theme || "system", systemDark, undefined, mode, halves);
}

function isTakenThemeId(id: string): boolean {
  return isReservedThemeId(id) || BUILT_IN_THEMES.some((t) => t.id === id) || getCustomThemes().some((t) => t.id === id);
}

function uniqueThemeId(base: string): string {
  let candidate = base;
  for (let n = 2; isTakenThemeId(candidate); n += 1) candidate = `${base}-${n}`;
  return candidate;
}

/** Applies an installed theme: single-appearance themes take one half, others take the whole theme. */
function assignInstalledTheme(theme: ThemeDefinition) {
  const modes = getThemeModes(theme);
  const state = useAppearance.getState();
  if (modes.length === 1) state.setHalf(modes[0]!, theme.id);
  else state.setTheme(theme.id);
}

// ---------------------------------------------------------------------------
// Import dialog
// ---------------------------------------------------------------------------

interface ThemeSource {
  name?: string;
  text: string;
}

/** Parses T3Code and VS Code theme JSON. VS Code light and dark files with one name are paired. */
function parseThemeSources(sources: ReadonlyArray<ThemeSource>): ReadonlyArray<ThemeDefinition> {
  const named: Array<{ theme: ThemeDefinition; sourceName?: string | undefined }> = [];
  const vscode: ThemeDefinition[] = [];
  for (const source of sources) {
    const value: unknown = JSON.parse(source.text);
    if (isVsCodeThemeFile(value)) vscode.push(parseVsCodeThemeFile(value));
    else named.push({ theme: parseThemeFile(value), sourceName: source.name });
  }
  const paired = pairVsCodeThemes(vscode);
  return resolveThemeLabelCollisions([...named, ...paired.map((theme) => ({ theme }))]);
}

/** Stays mounted so the dialog animates in and out. The body is keyed per opening to start fresh. */
function ThemeImportDialog({ open, session, onClose }: { open: boolean; session: number; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        <ThemeImportBody key={session} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

function ThemeImportBody({ onClose }: { onClose: () => void }) {
  const textId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<ReadonlyArray<ThemeSource>>([]);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ReadonlyArray<ThemeDefinition> | null>(null);
  const [pending, setPending] = useState<ReadonlyArray<ThemeDefinition>>([]);

  const sources: ReadonlyArray<ThemeSource> = files.length > 0 ? files : text.trim() ? [{ text }] : [];

  const readFiles = async (list: FileList | ReadonlyArray<File>) => {
    const selected = Array.from(list);
    setReading(true);
    setError(null);
    try {
      setFiles(await Promise.all(selected.map(async (file) => ({ name: file.name, text: await file.text() }))));
    } catch {
      setError(t("appearance.importReadFailed"));
    } finally {
      setReading(false);
    }
  };

  const install = (themes: ReadonlyArray<ThemeDefinition>, strategy: "keep" | "update") => {
    try {
      const saved = themes.map((theme) => {
        if (strategy === "update" && getCustomThemes().some((t) => t.id === theme.id)) return updateCustomTheme(theme);
        const id = isTakenThemeId(theme.id) ? uniqueThemeId(theme.id) : theme.id;
        return installCustomTheme({ ...theme, id });
      });
      if (saved.length === 1) assignInstalledTheme(saved[0]!);
      onClose();
    } catch {
      setError(t("appearance.importSaveFailed"));
      setConflicts(null);
    }
  };

  const submit = () => {
    let themes: ReadonlyArray<ThemeDefinition>;
    try {
      themes = parseThemeSources(sources);
    } catch {
      setError(t("appearance.importInvalid"));
      return;
    }
    const existing = themes.filter((t) => getCustomThemes().some((c) => c.id === t.id));
    if (existing.length > 0) {
      setPending(themes);
      setConflicts(existing);
      return;
    }
    install(themes, "keep");
  };

  const errorLine = error && (
    <p role="alert" aria-live="polite" className="text-destructive settings-error text-sm">
      {error}
    </p>
  );

  // Layout follows T3Code's ThemeImportDialog: glass surface, wide popup, padded header and body.
  return (
    <>
        <DialogHeader className="gap-2 p-6 pb-3">
          <DialogTitle>{conflicts ? t("appearance.alreadyInstalled") : t("appearance.addTheme")}</DialogTitle>
          <DialogDescription>
            {conflicts
              ? t("appearance.alreadyInstalledBody", { names: formatList(conflicts.map((theme) => theme.label)), count: conflicts.length })
              : t("appearance.importDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5 p-6 pt-3">
          {conflicts ? (
            <>
              {errorLine}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={() => setConflicts(null)}>
                  {t("common.back")}
                </Button>
                <Button variant="outline" onClick={() => install(pending, "keep")}>
                  {t("appearance.keepBoth")}
                </Button>
                <Button onClick={() => install(pending, "update")}>{t("appearance.updateExisting")}</Button>
              </div>
            </>
          ) : (
            <>
              <div
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                  setDragging(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  void readFiles(event.dataTransfer.files);
                }}
                className={cn(
                  "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed px-4 py-4 transition-colors duration-(--motion-fast)",
                  dragging ? "border-ring bg-accent/20" : "border-border/80 bg-muted/20",
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t("appearance.themeFile")}</p>
                  <p className="text-muted-foreground truncate text-xs">
                    {files.length > 0 ? formatList(files.map((f) => f.name ?? ""), { type: "unit", style: "short" }) : t("appearance.dropFiles")}
                  </p>
                </div>
                <Button size="sm" variant="outline" disabled={reading} onClick={() => inputRef.current?.click()}>
                  <UploadIcon />
                  {reading ? t("appearance.reading") : t("appearance.chooseFiles")}
                </Button>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".json,application/json"
                  multiple
                  hidden
                  onChange={(event) => {
                    if (event.currentTarget.files) void readFiles(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                />
              </div>
              <div className="flex items-center gap-3" aria-hidden>
                <div className="bg-border h-px flex-1" />
                <span className="text-muted-foreground text-2xs tracking-wider uppercase">{t("appearance.orPasteJson")}</span>
                <div className="bg-border h-px flex-1" />
              </div>
              <div className="space-y-2">
                <label htmlFor={textId} className="text-sm font-medium">
                  {t("appearance.themeJson")}
                </label>
                <Textarea
                  id={textId}
                  aria-label={t("appearance.themeJson")}
                  spellCheck={false}
                  value={text}
                  placeholder={'{\n  "version": 1,\n  "name": "Aurora",\n  "appearance": "light",\n  "colors": { ... }\n}'}
                  onChange={(event) => {
                    setText(event.currentTarget.value);
                    setFiles([]);
                  }}
                  className="bg-background/60 min-h-56 resize-y rounded-xl p-3 font-mono text-xs leading-5 md:text-xs"
                />
              </div>
              {errorLine}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={onClose}>
                  {t("common.cancel")}
                </Button>
                <Button disabled={sources.length === 0 || reading} onClick={submit}>
                  <PlusIcon />
                  {t("appearance.addTheme")}
                </Button>
              </div>
            </>
          )}
        </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

const FONT_LIST_CACHE = { families: null as readonly string[] | null };

const FONT_FILE_ACCEPT = ".woff2,.woff,.ttf,.otf";

function FontOptionLabel({ family, tag }: { family: string; tag?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate" style={{ fontFamily: cssFontFamilies(family) ?? undefined }}>
        {family}
      </span>
      {tag && <span className="bg-primary/10 text-primary shrink-0 rounded px-1.5 text-[10px]">{tag}</span>}
    </span>
  );
}

function FontRow({
  label,
  description,
  family,
  defaultLabel,
  monospace = false,
  size,
  sizeMin,
  sizeMax,
  sizeDefault,
  onFamilyChange,
  onSizeChange,
  onReset,
}: {
  label: string;
  description: string;
  family: string;
  defaultLabel: string;
  monospace?: boolean;
  size: number;
  sizeMin: number;
  sizeMax: number;
  sizeDefault: number;
  onFamilyChange: (family: string) => void;
  onSizeChange: (size: number) => void;
  onReset: () => void;
}) {
  const installed = useInstalledFonts((state) => state.fonts);
  const [systemFamilies, setSystemFamilies] = useState<readonly string[]>(FONT_LIST_CACHE.families ?? []);

  // Bundled, then uploaded, then system fonts. The code row shows only monospace faces.
  const bundled = BUNDLED_FONTS.filter((font) => !monospace || font.monospace).map((font) => font.family);
  const uploaded = installed.map((font) => font.family).filter((name) => !bundled.includes(name));
  const listed = [...bundled, ...uploaded];
  const system = systemFamilies.filter((name) => !listed.includes(name) && (!monospace || isMonospaceFamily(name)));
  const options: Array<SelectOption<string>> = [
    { value: "", label: t("appearance.fontDefault", { name: defaultLabel }) },
    ...bundled.map((name) => ({ value: name, label: <FontOptionLabel family={name} tag={t("appearance.fontBundled")} /> })),
    ...uploaded.map((name) => ({ value: name, label: <FontOptionLabel family={name} tag={t("appearance.fontUploaded")} /> })),
    ...system.map((name) => ({ value: name, label: <FontOptionLabel family={name} /> })),
  ];
  // A family that is no longer installed still shows, so the choice stays visible and can be changed.
  if (family !== "" && !options.some((option) => option.value === family)) {
    options.push({ value: family, label: <FontOptionLabel family={family} /> });
  }

  const openSystemFonts = (open: boolean) => {
    if (!open || FONT_LIST_CACHE.families !== null) return;
    // Opening the list is the user gesture the browser needs for the local-fonts prompt.
    void queryInstalledFontFamilies().then((result) => {
      if (result.status !== "granted") return;
      FONT_LIST_CACHE.families = result.families;
      setSystemFamilies(result.families);
    });
  };

  const sizeOptions = Array.from({ length: sizeMax - sizeMin + 1 }, (_, i) => sizeMin + i).map((px) => ({
    value: String(px),
    label: t("appearance.pixels", { n: px }),
  }));
  const changed = family !== "" || size !== sizeDefault;

  return (
    <SettingsRow
      label={label}
      description={description}
      reset={changed ? onReset : null}
      control={
        <div className="flex w-full items-center gap-2 sm:w-96">
          <Select<string>
            aria-label={t("appearance.fontFamilyLabel", { name: label })}
            className="h-8 min-w-0 flex-1"
            value={family}
            options={options}
            onValueChange={onFamilyChange}
            onOpenChange={openSystemFonts}
          />
          <Select<string>
            aria-label={t("appearance.fontSizeLabel", { name: label })}
            className="w-24 shrink-0"
            value={String(size)}
            options={sizeOptions}
            onValueChange={(next) => {
              const parsed = Number(next);
              if (Number.isInteger(parsed) && parsed >= sizeMin && parsed <= sizeMax) onSizeChange(parsed);
            }}
          />
        </div>
      }
    />
  );
}

function InstalledFontsRow() {
  const fonts = useInstalledFonts((state) => state.fonts);
  const s = useAppearance();
  const update = useAppearance((state) => state.update);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      await installFont(file);
    } catch (caught) {
      setError(errorText(caught, "appearance.fontInstallFailed"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (font: InstalledFont) => {
    // Settings that still point at the removed family fall back to their defaults.
    const patch: Partial<Pick<AppearanceSettings, "fontFamilySans" | "fontFamilyComposer" | "fontFamilyCode">> = {};
    if (s.fontFamilySans === font.family) patch.fontFamilySans = "";
    if (s.fontFamilyComposer === font.family) patch.fontFamilyComposer = "";
    if (s.fontFamilyCode === font.family) patch.fontFamilyCode = "";
    if (Object.keys(patch).length > 0) update(patch);
    setError(null);
    try {
      await removeFont(font.id);
    } catch (caught) {
      setError(errorText(caught, "appearance.fontRemoveFailed"));
    }
  };

  return (
    <SettingsRow
      label={t("appearance.installedFonts")}
      description={t("appearance.installedFontsDescription")}
      control={
        <div className="flex w-full flex-col gap-2 sm:w-96">
          <div className="flex justify-end">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
              <UploadIcon />
              {busy ? t("appearance.installing") : t("appearance.installFont")}
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept={FONT_FILE_ACCEPT}
              className="hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void install(file);
              }}
            />
          </div>
          {fonts.length > 0 && (
            <ul className="divide-y rounded-lg border">
              {fonts.map((font) => (
                <li key={font.id} className="flex items-center justify-between gap-2 px-2.5 py-1 text-sm">
                  <span className="truncate" style={{ fontFamily: cssFontFamilies(font.family) ?? undefined }}>
                    {font.family}
                  </span>
                  <Button variant="ghost" size="icon" aria-label={t("appearance.removeFont", { name: font.family })} onClick={() => void remove(font)}>
                    <Trash2Icon />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
        </div>
      }
    />
  );
}

function TypographySection() {
  const s = useAppearance();
  const update = useAppearance((state) => state.update);
  const reset = useAppearance((state) => state.reset);
  const interfaceLabel = s.fontFamilySans.trim() || DEFAULT_SANS_FONT_LABEL;
  // Font smoothing only changes rendering on macOS (T3Code shows the row there only).
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <SettingsSection
      title={t("appearance.typography")}
      action={
        <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs font-medium">
          {t("appearance.advanced")}
          <Switch
            aria-label={t("appearance.showAdvancedTypography")}
            checked={s.typographyAdvanced}
            onCheckedChange={(checked) => update({ typographyAdvanced: Boolean(checked) })}
          />
        </label>
      }
    >
      <FontRow
        label={t("appearance.interfaceFont")}
        description={t("appearance.interfaceFontDescription")}
        family={s.fontFamilySans}
        defaultLabel={DEFAULT_SANS_FONT_LABEL}
        size={s.fontSizeInterface}
        sizeMin={MIN_INTERFACE_FONT_SIZE}
        sizeMax={MAX_INTERFACE_FONT_SIZE}
        sizeDefault={DEFAULT_APPEARANCE.fontSizeInterface}
        onFamilyChange={(fontFamilySans) => update({ fontFamilySans })}
        onSizeChange={(fontSizeInterface) => update({ fontSizeInterface })}
        onReset={() => update({ fontFamilySans: DEFAULT_APPEARANCE.fontFamilySans, fontSizeInterface: DEFAULT_APPEARANCE.fontSizeInterface })}
      />
      {s.typographyAdvanced && (
        <div className="settings-collapse">
          <FontRow
            label={t("appearance.promptFont")}
            description={t("appearance.promptFontDescription")}
            family={s.fontFamilyComposer}
            defaultLabel={interfaceLabel}
            size={s.fontSizePrompt}
            sizeMin={MIN_PROMPT_FONT_SIZE}
            sizeMax={MAX_PROMPT_FONT_SIZE}
            sizeDefault={DEFAULT_APPEARANCE.fontSizePrompt}
            onFamilyChange={(fontFamilyComposer) => update({ fontFamilyComposer })}
            onSizeChange={(fontSizePrompt) => update({ fontSizePrompt })}
            onReset={() => update({ fontFamilyComposer: DEFAULT_APPEARANCE.fontFamilyComposer, fontSizePrompt: DEFAULT_APPEARANCE.fontSizePrompt })}
          />
        </div>
      )}
      <FontRow
        label={s.typographyAdvanced ? t("appearance.codeFont") : t("appearance.monospaceFont")}
        description={t("appearance.codeFontDescription")}
        family={s.fontFamilyCode}
        defaultLabel={t("appearance.systemMonospace")}
        monospace
        size={s.fontSizeCode}
        sizeMin={MIN_CODE_FONT_SIZE}
        sizeMax={MAX_CODE_FONT_SIZE}
        sizeDefault={DEFAULT_APPEARANCE.fontSizeCode}
        onFamilyChange={(fontFamilyCode) => update({ fontFamilyCode })}
        onSizeChange={(fontSizeCode) => update({ fontSizeCode })}
        onReset={() => update({ fontFamilyCode: DEFAULT_APPEARANCE.fontFamilyCode, fontSizeCode: DEFAULT_APPEARANCE.fontSizeCode })}
      />
      {s.typographyAdvanced && isMac && (
        <div className="settings-collapse">
          <SettingsRow
            label={t("appearance.fontSmoothing")}
            description={t("appearance.fontSmoothingDescription")}
            reset={s.fontSmoothing !== DEFAULT_APPEARANCE.fontSmoothing ? () => reset("fontSmoothing") : null}
            control={
              <Switch
                aria-label={t("appearance.fontSmoothing")}
                checked={s.fontSmoothing}
                onCheckedChange={(checked) => update({ fontSmoothing: Boolean(checked) })}
              />
            }
          />
        </div>
      )}
      <SettingsRow
        label={t("appearance.wordWrap")}
        description={t("appearance.wordWrapDescription")}
        reset={s.wordWrap !== DEFAULT_APPEARANCE.wordWrap ? () => reset("wordWrap") : null}
        control={<Switch aria-label={t("appearance.wordWrapAria")} checked={s.wordWrap} onCheckedChange={(checked) => update({ wordWrap: Boolean(checked) })} />}
      />
      <InstalledFontsRow />
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AppearanceSettings() {
  const syncError = useAppearanceSyncStatus((s) => s.error);
  const s = useAppearance();
  const update = useAppearance((state) => state.update);
  const reset = useAppearance((state) => state.reset);
  const appearance = useResolvedAppearance();
  const [importOpen, setImportOpen] = useState(false);
  const [importSession, setImportSession] = useState(0);

  return (
    <SettingsPage title={t("appearance.title")} description={t("appearance.description")}>
      {syncError && <p role="status" className="text-muted-foreground animate-fade-in mb-4 text-sm">{syncError}</p>}
      <ThemeLibrary
        theme={s.theme}
        halves={s.halves}
        appearanceMode={s.mode}
        initialAppearance={appearance}
        onImport={() => {
          setImportSession((n) => n + 1);
          setImportOpen(true);
        }}
      />

      <ThemeImportDialog open={importOpen} session={importSession} onClose={() => setImportOpen(false)} />

      <SettingsSection title={t("appearance.interface")}>
        <SettingsRow
          label={t("appearance.contrast")}
          description={t("appearance.contrastDescription")}
          reset={s.appearanceContrast !== DEFAULT_APPEARANCE.appearanceContrast ? () => reset("appearanceContrast") : null}
          control={
            <SettingsSlider
              label={t("appearance.contrast")}
              value={s.appearanceContrast}
              min={MIN_APPEARANCE_CONTRAST}
              max={MAX_APPEARANCE_CONTRAST}
              step={5}
              format={(v) => formatPercent(v / 100)}
              onChange={(appearanceContrast) => update({ appearanceContrast })}
            />
          }
        />
        <SettingsRow
          label={t("appearance.glassOpacity")}
          description={t("appearance.glassOpacityDescription")}
          reset={s.glassOpacity !== DEFAULT_APPEARANCE.glassOpacity ? () => reset("glassOpacity") : null}
          control={
            <SettingsSlider
              label={t("appearance.glassOpacity")}
              value={s.glassOpacity}
              min={MIN_GLASS_OPACITY}
              max={MAX_GLASS_OPACITY}
              step={5}
              format={(v) => formatPercent(v / 100)}
              onChange={(glassOpacity) => update({ glassOpacity })}
            />
          }
        />
        <SettingsRow
          label={t("appearance.chatWidth")}
          description={t("appearance.chatWidthDescription")}
          reset={s.chatWidth !== DEFAULT_APPEARANCE.chatWidth ? () => reset("chatWidth") : null}
          control={
            <div className="w-full sm:w-48">
              <Select<ChatWidth>
                aria-label={t("appearance.chatWidth")}
                value={s.chatWidth}
                options={CHAT_WIDTH_OPTIONS.map((option) => ({ ...option, label: t(option.label) }))}
                onValueChange={(chatWidth) => update({ chatWidth })}
              />
            </div>
          }
        />
        <SettingsRow
          label={t("appearance.dockedSidebar")}
          description={t("appearance.dockedSidebarDescription")}
          reset={s.sidebarStyle !== DEFAULT_APPEARANCE.sidebarStyle ? () => reset("sidebarStyle") : null}
          control={
            <Switch
              aria-label={t("appearance.dockedSidebar")}
              checked={s.sidebarStyle === "docked"}
              onCheckedChange={(checked) => update({ sidebarStyle: checked ? "docked" : "floating" })}
            />
          }
        />
        <SettingsRow
          label={t("appearance.squareCorners")}
          description={t("appearance.squareCornersDescription")}
          reset={s.squareCorners !== DEFAULT_APPEARANCE.squareCorners ? () => reset("squareCorners") : null}
          control={<Switch aria-label={t("appearance.squareCorners")} checked={s.squareCorners} onCheckedChange={(checked) => update({ squareCorners: Boolean(checked) })} />}
        />
      </SettingsSection>

      <SettingsSection title={t("appearance.motion")}>
        <SettingsRow
          label={t("appearance.animations")}
          description={t("appearance.animationsDescription")}
          reset={s.motionOff.length ? () => reset("motionOff") : null}
          control={
            <Switch
              aria-label={t("appearance.animations")}
              checked={s.motionOff.length < MOTION_GROUPS.length}
              onCheckedChange={(checked) => update({ motionOff: checked ? [] : [...MOTION_GROUPS] })}
            />
          }
        />
        {MOTION_OPTIONS.map((option) => (
          <SettingsRow
            key={option.group}
            className="sm:pl-8"
            label={t(option.label)}
            description={t(option.description)}
            control={
              <Switch
                aria-label={t(option.label)}
                checked={!s.motionOff.includes(option.group)}
                onCheckedChange={(checked) =>
                  update({
                    motionOff: checked
                      ? s.motionOff.filter((group) => group !== option.group)
                      : MOTION_GROUPS.filter((group) => group === option.group || s.motionOff.includes(group)),
                  })
                }
              />
            }
          />
        ))}
        <SettingsRow
          label={t("appearance.panelAnimations")}
          description={t("appearance.panelAnimationsDescription")}
          reset={s.panelAnimationDurationMs !== DEFAULT_APPEARANCE.panelAnimationDurationMs ? () => reset("panelAnimationDurationMs") : null}
          control={
            <SettingsSlider
              label={t("appearance.panelAnimationDuration")}
              value={s.panelAnimationDurationMs}
              min={MIN_PANEL_ANIMATION_DURATION_MS}
              max={MAX_PANEL_ANIMATION_DURATION_MS}
              step={25}
              format={(v) => t("appearance.milliseconds", { n: v })}
              onChange={(panelAnimationDurationMs) => update({ panelAnimationDurationMs })}
            />
          }
        />
      </SettingsSection>

      <TypographySection />
    </SettingsPage>
  );
}

