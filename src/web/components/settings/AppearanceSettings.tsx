import { useAppearanceSyncStatus } from "@/state/appearance-sync";
// Ported from T3Code (MIT, Copyright (c) 2026 T3 Tools Inc.).
// Source: apps/web/src/components/settings/SettingsPanels.tsx (AppearanceSettingsPanel,
// TypographySection, font rows), ThemeSettings.tsx (ThemeLibrary, cards), ThemeImportDialog.tsx,
// ThemeWireframe.tsx and ThemeEditorPanel.tsx (simplified to a dialog with key roles).
import { CheckIcon, CopyIcon, EllipsisIcon, PaintbrushIcon, PenLineIcon, PlusIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { SettingsPage, SettingsRow, SettingsSection, SettingsSlider } from "@/components/settings/SettingsUI";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { DEFAULT_APPEARANCE, useAppearance } from "@/state/appearance";
import {
  applyThemeColorPreview,
  getCustomThemes,
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeDefinition,
  getThemeModes,
  installCustomTheme,
  isReservedThemeId,
  removeCustomTheme,
  serializeThemeFile,
  subscribeToCustomThemes,
  themeColorToHex,
  themeIdFromName,
  updateCustomTheme,
  updateThemeColorFamily,
  parseThemeFile,
  resolveThemeAppearance,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeHalves,
  type ThemePreferenceMode,
} from "@/theme/palette";
import { BUILT_IN_THEMES } from "@/theme/palettes";
import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  isFontFamilyAvailable,
  isMonospaceFamily,
  queryInstalledFontFamilies,
  resolveDefaultFamilyLabel,
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

type Appearance = ThemeAppearance;
type ModeChoice = ThemePreferenceMode;

const MODE_CHOICES: ReadonlyArray<{ value: ModeChoice; label: string; aria: string }> = [
  { value: "system", label: "System", aria: "Follow the system appearance" },
  { value: "light", label: "Light", aria: "Use light mode" },
  { value: "dark", label: "Dark", aria: "Use dark mode" },
];

const CHAT_WIDTH_OPTIONS: Array<{ value: ChatWidth; label: string }> = [
  { value: "comfortable", label: "Comfortable (default)" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full" },
];

const EDITOR_ROLES: ReadonlyArray<{ role: ThemeColorRole; label: string }> = [
  { role: "accent", label: "Accent" },
  { role: "canvas", label: "Background" },
  { role: "surface", label: "Surface" },
  { role: "text", label: "Text" },
  { role: "sidebar", label: "Sidebar" },
  { role: "border", label: "Border" },
  { role: "codeBackground", label: "Code background" },
];

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

// ---------------------------------------------------------------------------
// Theme helpers
// ---------------------------------------------------------------------------

function otherAppearance(appearance: Appearance): Appearance {
  return appearance === "light" ? "dark" : "light";
}

function useCustomThemes(): ReadonlyArray<ThemeDefinition> {
  return useSyncExternalStore(subscribeToCustomThemes, getCustomThemes, getCustomThemes);
}

/** Tracks the OS scheme so the preview and card state follow "System" live. */
function useResolvedAppearance(): Appearance {
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

/** Colors for a theme id ("" = T3 Code default) in one appearance. */
function colorsFor(themeId: string, appearance: Appearance): ThemeColors {
  if (themeId === "") return getStandardThemeColors(appearance);
  const definition = getThemeDefinition(themeId);
  if (!definition) return getStandardThemeColors(appearance);
  return getThemeColorsForMode(definition, appearance) ?? definition.colors;
}

function standardThemeDefinition(): ThemeDefinition {
  return {
    id: "t3-code",
    label: "T3 Code",
    appearance: "light",
    colors: getStandardThemeColors("light"),
    variants: { dark: getStandardThemeColors("dark") },
  };
}

/**
 * Writes one appearance's half. Assigning the default over a themed base
 * cannot be stored as a half, so the base moves to the other side first (as in T3Code).
 */
function assignThemeHalf(appearance: Appearance, themeId: string | null) {
  const state = useAppearance.getState();
  if (themeId === null && state.theme !== "") {
    const other = otherAppearance(appearance);
    const otherOwner = state.halves?.[other] ?? state.theme;
    state.setTheme("");
    if (otherOwner) state.setHalf(other, otherOwner);
    return;
  }
  state.setHalf(appearance, themeId);
}

/** Applies an installed theme: single-appearance themes take one half, others take the whole theme. */
function assignInstalledTheme(theme: ThemeDefinition) {
  const modes = getThemeModes(theme);
  const state = useAppearance.getState();
  if (modes.length === 1) state.setHalf(modes[0]!, theme.id);
  else state.setTheme(theme.id);
}

function downloadThemeFile(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking synchronously can abort the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ---------------------------------------------------------------------------
// Wireframe thumbnail (ThemeWireframe.tsx)
// ---------------------------------------------------------------------------

const WIRE_LINE = "rgb(127 127 127 / 0.25)";

function WireframePane({ colors, clip }: { colors: ThemeColors; clip?: "left" | "right" }) {
  const clipPath =
    clip === undefined
      ? undefined
      : clip === "left"
        ? "polygon(0 0, calc(50% - 1px) 0, calc(50% - 1px) 100%, 0 100%)"
        : "polygon(calc(50% + 1px) 0, 100% 0, 100% 100%, calc(50% + 1px) 100%)";
  return (
    <span className="absolute inset-0" style={{ clipPath }}>
      <span className="absolute inset-0" style={{ backgroundColor: colors.canvas }} />
      <span className="absolute inset-y-0 left-0 w-[22%]" style={{ backgroundColor: colors.sidebar, boxShadow: `inset -1px 0 0 ${WIRE_LINE}` }} />
      <span className="absolute top-[8%] left-[3%] h-[8%] w-[16%] rounded-md" style={{ backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${WIRE_LINE}` }} />
      <span className="absolute top-[22%] left-[3%] h-[7%] w-[16%] rounded-md" style={{ backgroundColor: colors.accentSurface }} />
      <span className="absolute top-[32%] left-[3%] h-[7%] w-[16%] rounded-md" style={{ backgroundColor: colors.messageSurface, opacity: 0.7 }} />
      <span className="absolute top-[42%] left-[3%] h-[7%] w-[16%] rounded-md" style={{ backgroundColor: colors.messageSurface, opacity: 0.5 }} />
      <span className="absolute top-[11%] right-[28%] h-[9%] w-[24%] rounded-lg" style={{ backgroundColor: colors.messageSurface }} />
      <span className="absolute top-[28%] left-[27%] h-[5%] w-[34%] rounded-sm" style={{ backgroundColor: WIRE_LINE }} />
      <span className="absolute top-[38%] left-[27%] h-[5%] w-[26%] rounded-sm" style={{ backgroundColor: WIRE_LINE }} />
      <span
        className="absolute right-[6%] bottom-[8%] left-[26%] flex h-[15%] items-center justify-between rounded-md px-1"
        style={{ backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${WIRE_LINE}` }}
      >
        <span className="block h-[26%] w-[34%] rounded-full" style={{ backgroundColor: WIRE_LINE, opacity: 0.7 }} />
        <span className="block aspect-square h-[58%] rounded-full" style={{ backgroundColor: colors.messageAction }} />
      </span>
      <span
        className="absolute top-[8%] right-[5%] h-[46%] w-[20%] rounded-lg"
        style={{ backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${WIRE_LINE}, 0 2px 5px rgb(0 0 0 / 0.14)` }}
      >
        {[0, 1, 2].map((row) => (
          <span key={row} className="absolute right-[11%] left-[11%] flex items-center gap-1" style={{ top: `${10 + row * 30}%`, height: "20%" }}>
            <span className="block aspect-square h-[26%] rounded-full" style={{ backgroundColor: row === 1 ? colors.messageAction : WIRE_LINE, opacity: 0.55 }} />
            <span className="block h-[30%] w-[52%] rounded-sm" style={{ backgroundColor: WIRE_LINE }} />
          </span>
        ))}
      </span>
    </span>
  );
}

function Wireframe({ panes, className }: { panes: ReadonlyArray<{ colors: ThemeColors; clip?: "left" | "right" }>; className?: string }) {
  return (
    <span aria-hidden className={cn("border-border/60 relative block w-full overflow-hidden rounded-lg border", className)}>
      {panes.map((pane) => (
        <WireframePane key={pane.clip ?? "pane"} colors={pane.colors} clip={pane.clip} />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Theme library
// ---------------------------------------------------------------------------

interface ThemeCard {
  id: string;
  label: string;
  modes: ReadonlyArray<Appearance>;
  definition: ThemeDefinition | null;
  custom: boolean;
}

function cardFromDefinition(definition: ThemeDefinition, custom: boolean): ThemeCard {
  return { id: definition.id, label: definition.label, modes: getThemeModes(definition), definition, custom };
}

function ThemeLibrary({
  theme,
  halves,
  appearance,
  mode,
  onEdit,
  onImport,
  onCreate,
}: {
  theme: string;
  halves: ThemeHalves | null;
  appearance: Appearance;
  mode: ModeChoice;
  onEdit: (theme: ThemeDefinition) => void;
  onImport: () => void;
  onCreate: () => void;
}) {
  const customThemes = useCustomThemes();
  const [removing, setRemoving] = useState<ThemeCard | null>(null);
  const headingId = useId();
  const ownerOf = (m: Appearance) => halves?.[m] ?? theme;

  const cards: ReadonlyArray<ThemeCard> = [
    { id: "", label: "T3 Code", modes: ["light", "dark"], definition: null, custom: false },
    ...BUILT_IN_THEMES.map((definition) => cardFromDefinition(definition, false)),
    ...customThemes.map((definition) => cardFromDefinition(definition, true)),
  ];

  const selectCard = (card: ThemeCard) => {
    const state = useAppearance.getState();
    if (card.id !== "" && card.modes.length === 1) assignThemeHalf(card.modes[0]!, card.id);
    else state.setTheme(card.id);
  };

  const duplicate = (card: ThemeCard): ThemeDefinition => {
    const source = card.definition ?? standardThemeDefinition();
    const label = `${source.label} copy`;
    return installCustomTheme({ ...source, id: uniqueThemeId(themeIdFromName(label)), label });
  };

  const exportCard = (card: ThemeCard) => {
    const definition = card.definition ?? standardThemeDefinition();
    downloadThemeFile(`${definition.id}.json`, serializeThemeFile(definition));
  };

  const confirmRemove = () => {
    if (!removing) return;
    const id = removing.id;
    // Move owners off the removed theme before deleting it, so no half keeps a dangling id.
    const affected = (["light", "dark"] as const).filter((m) => ownerOf(m) === id);
    for (const m of affected) assignThemeHalf(m, null);
    removeCustomTheme(id);
    setRemoving(null);
  };

  const pickedMode = (m: Appearance) => (m === "dark" ? "dark" : "light");
  const modeTiles = MODE_CHOICES.map((choice) => {
    const active = mode === choice.value;
    const panes =
      choice.value === "system"
        ? [
            { clip: "left" as const, colors: colorsFor(ownerOf("light"), "light") },
            { clip: "right" as const, colors: colorsFor(ownerOf("dark"), "dark") },
          ]
        : [{ colors: colorsFor(ownerOf(pickedMode(choice.value as Appearance)), pickedMode(choice.value as Appearance)) }];
    return (
      <button
        key={choice.value}
        type="button"
        aria-pressed={active}
        aria-label={choice.aria}
        onClick={() => useAppearance.getState().setMode(choice.value)}
        className={cn(
          "focus-visible:ring-ring flex cursor-pointer flex-col gap-1.5 rounded-xl border p-2 outline-none transition-colors focus-visible:ring-2",
          active ? "border-transparent bg-accent/30" : "border-border/70 bg-card/60 hover:bg-accent/10",
        )}
        style={active ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
      >
        <Wireframe className="h-28" panes={panes} />
        <span className={cn("text-xs font-medium", active ? "text-foreground" : "text-muted-foreground")}>{choice.label}</span>
      </button>
    );
  });

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-sm font-medium">
        Color scheme
      </h2>
      <div role="group" aria-label="Appearance mode" className="grid grid-cols-3 gap-3">
        {modeTiles}
      </div>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Themes</h3>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onCreate}>
            <PaintbrushIcon />
            Create theme
          </Button>
          <Button size="sm" variant="outline" onClick={onImport}>
            <PlusIcon />
            Add theme
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
        {cards.map((card) => {
          const owned = (m: Appearance) => ownerOf(m) === card.id;
          const active = ownerOf(appearance) === card.id;
          const cardColors = colorsFor(card.id, appearance);
          return (
            <div
              key={`${card.custom ? "custom" : "std"}-${card.id}`}
              className={cn(
                "border-border/70 bg-card/60 hover:bg-accent/10 flex flex-col overflow-hidden rounded-xl border transition-colors",
                active && "bg-accent/30",
              )}
              style={active ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
            >
              <div className="p-2 pb-0" onClick={() => selectCard(card)}>
                <Wireframe className="h-24" panes={[{ colors: cardColors }]} />
              </div>
              <div className="flex items-center gap-2 px-3 pt-2 pb-3">
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => selectCard(card)}
                  className="focus-visible:ring-ring min-w-0 flex-1 truncate rounded-sm text-left text-sm font-medium outline-none focus-visible:ring-2"
                >
                  {card.label}
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  {card.modes.map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-label={`Use ${card.label} for ${m} mode`}
                      aria-pressed={owned(m)}
                      onClick={() => assignThemeHalf(m, card.id === "" ? null : card.id)}
                      className={cn(
                        "border-border/70 focus-visible:ring-ring size-4 rounded-full border outline-none focus-visible:ring-2",
                        owned(m) && "ring-ring ring-2 ring-inset",
                      )}
                      style={{ backgroundColor: colorsFor(card.id, m).canvas, boxShadow: `inset 0 0 0 3px ${colorsFor(card.id, m).accent}` }}
                    />
                  ))}
                </div>
                {active && <CheckIcon aria-hidden className="text-foreground size-3.5 shrink-0" />}
                <Menu>
                  <MenuTrigger
                    render={<Button variant="ghost" size="icon-xs" aria-label={`Actions for ${card.label}`} />}
                  >
                    <EllipsisIcon />
                  </MenuTrigger>
                  <MenuContent align="end">
                    {card.custom && card.definition && (
                      <MenuItem onClick={() => onEdit(card.definition!)}>
                        <PenLineIcon />
                        Edit
                      </MenuItem>
                    )}
                    <MenuItem
                      onClick={() => {
                        const copy = duplicate(card);
                        onEdit(copy);
                      }}
                    >
                      <CopyIcon />
                      Duplicate & edit
                    </MenuItem>
                    <MenuItem onClick={() => exportCard(card)}>
                      <UploadIcon />
                      Export
                    </MenuItem>
                    {card.custom && (
                      <MenuItem className="text-destructive" onClick={() => setRemoving(card)}>
                        <Trash2Icon />
                        Delete
                      </MenuItem>
                    )}
                  </MenuContent>
                </Menu>
              </div>
            </div>
          );
        })}
      </div>

      {removing && (
        <Dialog open onOpenChange={(open) => !open && setRemoving(null)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Remove “{removing.label}”?</DialogTitle>
              <DialogDescription>You can bring it back anytime by importing its JSON file.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={confirmRemove}>
                Remove
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Theme editor (simplified: key color roles, live preview)
// ---------------------------------------------------------------------------

function toHex(value: string): string {
  return (themeColorToHex(value) ?? "#000000").slice(0, 7).toLowerCase();
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const id = useId();
  const hex = toHex(value);
  const [text, setText] = useState(hex);
  const [seenHex, setSeenHex] = useState(hex);
  if (seenHex !== hex) {
    setSeenHex(hex);
    setText(hex);
  }
  const commitText = () => {
    const candidate = text.trim().toLowerCase();
    if (HEX_PATTERN.test(candidate)) {
      if (candidate !== hex) onChange(candidate);
    } else {
      setText(hex);
    }
  };
  return (
    <div className="flex items-center gap-3">
      <label htmlFor={id} className="w-36 shrink-0 text-sm">
        {label}
      </label>
      <input
        id={id}
        type="color"
        value={hex}
        onChange={(event) => onChange(event.currentTarget.value.toLowerCase())}
        className="border-border size-8 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
      />
      <Input
        aria-label={`${label} hex`}
        value={text}
        maxLength={7}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={commitText}
        onKeyDown={(event) => {
          if (event.key === "Enter") commitText();
        }}
        className="h-8 w-28 font-mono text-xs"
      />
    </div>
  );
}

function ThemeEditorDialog({
  theme,
  onClose,
}: {
  theme: ThemeDefinition;
  /** saved=false restores the stored palette over the preview. */
  onClose: (saved: boolean) => void;
}) {
  const modes = getThemeModes(theme);
  const [mode, setMode] = useState<Appearance>(theme.appearance);
  const [drafts, setDrafts] = useState<Partial<Record<Appearance, ThemeColors>>>({});
  const [error, setError] = useState<string | null>(null);
  const colorsFor = (m: Appearance): ThemeColors => drafts[m] ?? getThemeColorsForMode(theme, m) ?? theme.colors;
  const current = colorsFor(mode);

  const setRole = (role: ThemeColorRole, value: string) => {
    // updateThemeColorFamily also regenerates the derived colors that depend on this role.
    const next = updateThemeColorFamily(mode, current, role, value);
    setDrafts((d) => ({ ...d, [mode]: next }));
    applyThemeColorPreview(next, mode);
  };

  const switchMode = (m: Appearance) => {
    setMode(m);
    applyThemeColorPreview(colorsFor(m), m);
  };

  const save = () => {
    const other = otherAppearance(theme.appearance);
    const otherColors = modes.includes(other) ? (drafts[other] ?? theme.variants?.[other]) : undefined;
    const next: ThemeDefinition = {
      ...theme,
      colors: drafts[theme.appearance] ?? theme.colors,
      variants: otherColors ? { [other]: otherColors } : undefined,
    };
    try {
      updateCustomTheme(next);
      onClose(true);
    } catch {
      setError("Could not save your theme.");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit theme</DialogTitle>
          <DialogDescription>{theme.label}</DialogDescription>
        </DialogHeader>
        {modes.length > 1 && (
          <div role="tablist" aria-label="Theme appearance" className="bg-muted flex w-fit gap-1 rounded-lg p-1">
            {modes.map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => switchMode(m)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium capitalize outline-none focus-visible:ring-2",
                  mode === m ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-2">
          {EDITOR_ROLES.map(({ role, label }) => (
            <ColorField key={role} label={label} value={current[role]} onChange={(hex) => setRole(role, hex)} />
          ))}
        </div>
        {error && (
          <p role="alert" aria-live="polite" className="text-destructive text-xs">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button onClick={save}>Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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

function ThemeImportDialog({ onClose }: { onClose: () => void }) {
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
      setError("Could not read that file. Paste the JSON below instead.");
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
      setError("Could not save that theme.");
      setConflicts(null);
    }
  };

  const submit = () => {
    let themes: ReadonlyArray<ThemeDefinition>;
    try {
      themes = parseThemeSources(sources);
    } catch {
      setError("That theme file is invalid.");
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

  if (conflicts) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Already installed</DialogTitle>
            <DialogDescription>{conflicts.map((t) => t.label).join(", ")} is already installed. Update it, or keep both copies.</DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" aria-live="polite" className="text-destructive text-xs">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConflicts(null)}>
              Back
            </Button>
            <Button variant="outline" onClick={() => install(pending, "keep")}>
              Keep both
            </Button>
            <Button onClick={() => install(pending, "update")}>Update existing</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a theme</DialogTitle>
          <DialogDescription>Paste a theme JSON file, or choose T3 Code or VS Code .json files.</DialogDescription>
        </DialogHeader>
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void readFiles(event.dataTransfer.files);
          }}
          className={cn(
            "flex flex-col items-center gap-2 rounded-xl border border-dashed p-4 text-center",
            dragging ? "border-ring bg-accent/20" : "border-border",
          )}
        >
          <p className="text-sm font-medium">Theme file</p>
          <p className="text-muted-foreground text-xs">
            {files.length > 0 ? files.map((f) => f.name).join(", ") : "Drop T3 Code or VS Code .json files"}
          </p>
          <Button size="sm" variant="outline" disabled={reading} onClick={() => inputRef.current?.click()}>
            {reading ? "Reading…" : "Choose files"}
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
        <div className="flex flex-col gap-1.5">
          <label htmlFor={textId} className="text-sm font-medium">
            Theme JSON
          </label>
          <Textarea
            id={textId}
            aria-label="Theme JSON"
            rows={8}
            spellCheck={false}
            value={text}
            onChange={(event) => {
              setText(event.currentTarget.value);
              setFiles([]);
            }}
            className="font-mono text-xs"
          />
        </div>
        {error && (
          <p role="alert" aria-live="polite" className="text-destructive text-xs">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={sources.length === 0 || reading} onClick={submit}>
            <PlusIcon />
            Add theme
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

const FONT_LIST_CACHE = { families: null as readonly string[] | null };

function FontRow({
  label,
  description,
  family,
  placeholder,
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
  placeholder: string;
  monospace?: boolean;
  size: number;
  sizeMin: number;
  sizeMax: number;
  sizeDefault: number;
  onFamilyChange: (family: string) => void;
  onSizeChange: (size: number) => void;
  onReset: () => void;
}) {
  const listId = useId();
  const [installedFamilies, setInstalledFamilies] = useState<readonly string[]>(FONT_LIST_CACHE.families ?? []);
  const [draft, setDraft] = useState(family);
  const [seenFamily, setSeenFamily] = useState(family);
  const [rejected, setRejected] = useState(false);
  const timer = useRef<number | null>(null);
  if (seenFamily !== family) {
    setSeenFamily(family);
    setDraft(family);
    setRejected(false);
  }
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const cancelPending = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const accepts = (candidate: string) => isFontFamilyAvailable(candidate) && (!monospace || isMonospaceFamily(candidate));
  const commit = (next: string) => {
    cancelPending();
    const trimmed = next.trim();
    if (trimmed === family) return;
    if (trimmed === "" || accepts(trimmed)) {
      setRejected(false);
      onFamilyChange(trimmed);
    } else {
      setRejected(true);
    }
  };

  const options = monospace ? installedFamilies.filter((f) => isMonospaceFamily(f)) : installedFamilies;
  const sizeOptions = Array.from({ length: sizeMax - sizeMin + 1 }, (_, i) => sizeMin + i).map((px) => ({
    value: String(px),
    label: `${px} px`,
  }));
  const changed = family !== "" || size !== sizeDefault;

  return (
    <SettingsRow
      label={label}
      description={description}
      reset={changed ? onReset : null}
      control={
        <div className="flex w-full items-center gap-2 sm:w-96">
          <Input
            aria-label={`${label} family`}
            aria-invalid={rejected || undefined}
            autoCapitalize="off"
            autoComplete="off"
            maxLength={200}
            spellCheck={false}
            placeholder={placeholder}
            list={listId}
            value={draft}
            onFocus={() => {
              if (FONT_LIST_CACHE.families !== null) return;
              void queryInstalledFontFamilies().then((result) => {
                if (result.status !== "granted") return;
                FONT_LIST_CACHE.families = result.families;
                setInstalledFamilies(result.families);
              });
            }}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setDraft(next);
              setRejected(false);
              cancelPending();
              timer.current = window.setTimeout(() => commit(next), 400);
            }}
            onBlur={() => commit(draft)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit(draft);
              if (event.key === "Escape") {
                // Discard typing without letting Escape close the settings page.
                event.preventDefault();
                event.stopPropagation();
                cancelPending();
                setDraft(family);
                setRejected(false);
              }
            }}
            className="min-w-0 flex-1"
          />
          <datalist id={listId}>
            {options.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <Select<string>
            aria-label={`${label} size`}
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

function TypographySection() {
  const s = useAppearance();
  const update = useAppearance((state) => state.update);
  const reset = useAppearance((state) => state.reset);
  const [defaults] = useState(() => ({
    sans: resolveDefaultFamilyLabel(DEFAULT_SANS_FONT_STACK) ?? "System default",
    code: resolveDefaultFamilyLabel(DEFAULT_CODE_FONT_STACK) ?? "System monospace",
  }));
  const interfaceLabel = s.fontFamilySans.trim() || defaults.sans;
  // Font smoothing only changes rendering on macOS (T3Code shows the row there only).
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <SettingsSection
      title="Typography"
      action={
        <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs font-medium">
          Advanced
          <Switch
            aria-label="Show advanced typography settings"
            checked={s.typographyAdvanced}
            onCheckedChange={(checked) => update({ typographyAdvanced: Boolean(checked) })}
          />
        </label>
      }
    >
      <FontRow
        label="Interface font"
        description="Everything outside code blocks."
        family={s.fontFamilySans}
        placeholder={defaults.sans}
        size={s.fontSizeInterface}
        sizeMin={MIN_INTERFACE_FONT_SIZE}
        sizeMax={MAX_INTERFACE_FONT_SIZE}
        sizeDefault={DEFAULT_APPEARANCE.fontSizeInterface}
        onFamilyChange={(fontFamilySans) => update({ fontFamilySans })}
        onSizeChange={(fontSizeInterface) => update({ fontSizeInterface })}
        onReset={() => update({ fontFamilySans: DEFAULT_APPEARANCE.fontFamilySans, fontSizeInterface: DEFAULT_APPEARANCE.fontSizeInterface })}
      />
      {s.typographyAdvanced && (
        <FontRow
          label="Prompt font"
          description="Only the box you write prompts in. Mono works well here."
          family={s.fontFamilyComposer}
          placeholder={interfaceLabel}
          size={s.fontSizePrompt}
          sizeMin={MIN_PROMPT_FONT_SIZE}
          sizeMax={MAX_PROMPT_FONT_SIZE}
          sizeDefault={DEFAULT_APPEARANCE.fontSizePrompt}
          onFamilyChange={(fontFamilyComposer) => update({ fontFamilyComposer })}
          onSizeChange={(fontSizePrompt) => update({ fontSizePrompt })}
          onReset={() => update({ fontFamilyComposer: DEFAULT_APPEARANCE.fontFamilyComposer, fontSizePrompt: DEFAULT_APPEARANCE.fontSizePrompt })}
        />
      )}
      <FontRow
        label={s.typographyAdvanced ? "Code font" : "Monospace font"}
        description="Code blocks and file previews."
        family={s.fontFamilyCode}
        placeholder={defaults.code}
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
        <SettingsRow
          label="Font smoothing"
          description="Use thinner grayscale text smoothing instead of the macOS default."
          reset={s.fontSmoothing !== DEFAULT_APPEARANCE.fontSmoothing ? () => reset("fontSmoothing") : null}
          control={
            <Switch
              aria-label="Font smoothing"
              checked={s.fontSmoothing}
              onCheckedChange={(checked) => update({ fontSmoothing: Boolean(checked) })}
            />
          }
        />
      )}
      <SettingsRow
        label="Word wrap"
        description="Wrap long lines in code blocks and tables by default."
        reset={s.wordWrap !== DEFAULT_APPEARANCE.wordWrap ? () => reset("wordWrap") : null}
        control={<Switch aria-label="Word wrap in code blocks" checked={s.wordWrap} onCheckedChange={(checked) => update({ wordWrap: Boolean(checked) })} />}
      />
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
  const [editing, setEditing] = useState<ThemeDefinition | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const closeEditor = (saved: boolean) => {
    // A canceled edit restores the stored palette that the preview replaced.
    if (!saved) useAppearance.getState().bump();
    setEditing(null);
  };

  return (
    <SettingsPage title="Appearance" description="Colors, themes, and typography synced across your devices.">
      {syncError && <p role="status" className="text-muted-foreground mb-4 text-sm">{syncError}</p>}
      <ThemeLibrary
        theme={s.theme}
        halves={s.halves}
        appearance={appearance}
        mode={s.mode}
        onEdit={(theme) => setEditing(theme)}
        onImport={() => setImportOpen(true)}
        onCreate={() => {
          const label = `Custom theme ${getCustomThemes().length + 1}`;
          const created = installCustomTheme({
            id: uniqueThemeId(themeIdFromName(label)),
            label,
            appearance: "light",
            colors: getStandardThemeColors("light"),
            variants: { dark: getStandardThemeColors("dark") },
          });
          setEditing(created);
        }}
      />

      {editing && <ThemeEditorDialog theme={editing} onClose={closeEditor} />}
      {importOpen && <ThemeImportDialog onClose={() => setImportOpen(false)} />}

      <SettingsSection title="Interface">
        <SettingsRow
          label="Contrast"
          description="Adjust the contrast of colors and borders across the interface."
          reset={s.appearanceContrast !== DEFAULT_APPEARANCE.appearanceContrast ? () => reset("appearanceContrast") : null}
          control={
            <SettingsSlider
              label="Contrast"
              value={s.appearanceContrast}
              min={MIN_APPEARANCE_CONTRAST}
              max={MAX_APPEARANCE_CONTRAST}
              step={5}
              format={(v) => `${v}%`}
              onChange={(appearanceContrast) => update({ appearanceContrast })}
            />
          }
        />
        <SettingsRow
          label="Glass opacity"
          description="Higher values make menus, dialogs, and the composer more solid."
          reset={s.glassOpacity !== DEFAULT_APPEARANCE.glassOpacity ? () => reset("glassOpacity") : null}
          control={
            <SettingsSlider
              label="Glass opacity"
              value={s.glassOpacity}
              min={MIN_GLASS_OPACITY}
              max={MAX_GLASS_OPACITY}
              step={5}
              format={(v) => `${v}%`}
              onChange={(glassOpacity) => update({ glassOpacity })}
            />
          }
        />
        <SettingsRow
          label="Chat width"
          description="Set how wide messages and the composer can grow on large screens."
          reset={s.chatWidth !== DEFAULT_APPEARANCE.chatWidth ? () => reset("chatWidth") : null}
          control={
            <div className="w-full sm:w-48">
              <Select<ChatWidth>
                aria-label="Chat width"
                value={s.chatWidth}
                options={CHAT_WIDTH_OPTIONS}
                onValueChange={(chatWidth) => update({ chatWidth })}
              />
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title="Motion">
        <SettingsRow
          label="Panel animations"
          description="Set how fast panels open and close."
          reset={s.panelAnimationDurationMs !== DEFAULT_APPEARANCE.panelAnimationDurationMs ? () => reset("panelAnimationDurationMs") : null}
          control={
            <SettingsSlider
              label="Panel animation duration"
              value={s.panelAnimationDurationMs}
              min={MIN_PANEL_ANIMATION_DURATION_MS}
              max={MAX_PANEL_ANIMATION_DURATION_MS}
              step={25}
              format={(v) => `${v} ms`}
              onChange={(panelAnimationDurationMs) => update({ panelAnimationDurationMs })}
            />
          }
        />
      </SettingsSection>

      <TypographySection />
    </SettingsPage>
  );
}

