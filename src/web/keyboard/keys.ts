/**
 * Key combos are strings like "Mod+Shift+K", "Alt+Shift+ArrowUp", or "?". Modifiers come first in the
 * order Mod, Ctrl, Alt, Shift. `Mod` is ⌘ on Apple devices and Ctrl elsewhere, so one default works on both;
 * `Ctrl` is only written for the real Control key on a Mac.
 *
 * Shift is part of letters, digits, and named keys only. A symbol already says whether Shift was needed
 * ("?" is Shift+/ in the US layout and Shift+ß in the German one), so it is matched by the character.
 */

import type { PlainMessageKey } from "@/i18n";

export type Platform = "mac" | "other";

export const platform: Platform =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? "mac" : "other";

const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift"] as const;
type Modifier = (typeof MODIFIERS)[number];

export interface Combo {
  mods: ReadonlySet<Modifier>;
  key: string;
}

/** Keys the browser reports by name. Anything else is a single character. */
const NAMED = new Set([
  "Enter", "Escape", "Backspace", "Delete", "Tab", "Space", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Insert",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);

/** Physical keys for punctuation, used when a modifier (macOS Option) turned the character into another one. */
const CODE_KEYS: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`",
};

const isSymbol = (key: string) => key.length === 1 && !/[a-z0-9]/i.test(key);

export function parseCombo(text: string): Combo | null {
  // "Plus" stands for the + key, which cannot appear as itself between separators.
  const parts = text.split("+").map((part) => (part === "Plus" ? "+" : part));
  const key = parts.pop();
  if (!key) return null;
  const mods = new Set<Modifier>();
  for (const part of parts) {
    const mod = MODIFIERS.find((m) => m.toLowerCase() === part.toLowerCase());
    if (!mod || mods.has(mod)) return null;
    mods.add(mod);
  }
  const normal = NAMED.has(key) ? key : key.length === 1 ? key.toLowerCase() : null;
  if (!normal) return null;
  if (isSymbol(normal)) mods.delete("Shift");
  return { mods, key: normal };
}

export function stringifyCombo(combo: Combo): string {
  const key = combo.key === "+" ? "Plus" : combo.key.length === 1 ? combo.key.toUpperCase() : combo.key;
  return [...MODIFIERS.filter((m) => combo.mods.has(m)), key].join("+");
}

/** Canonical spelling, so equal combos compare equal as strings. Null for text that is not a combo. */
export function normalizeCombo(text: string): string | null {
  const combo = parseCombo(text);
  return combo ? stringifyCombo(combo) : null;
}

/** The modifier keys themselves never form a combo. */
const MODIFIER_KEYS = new Set(["Control", "Meta", "Alt", "Shift", "AltGraph", "CapsLock", "Fn", "OS", "Hyper", "Super"]);

/**
 * Every combo this key press could mean: the produced character, and the physical key when a modifier
 * changed the character (macOS Option+N types "˜", but should still match Alt+N). Empty for modifier-only presses.
 */
export function eventCombos(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> & { altGraph?: boolean }): string[] {
  if (MODIFIER_KEYS.has(event.key)) return [];
  const mods = new Set<Modifier>();
  // AltGr reports Ctrl+Alt on Windows; it types characters such as @ and € on German keyboards and is never a shortcut.
  const altGraph = event.altGraph === true;
  if (platform === "mac") {
    if (event.metaKey) mods.add("Mod");
    if (event.ctrlKey) mods.add("Ctrl");
  } else if (!altGraph) {
    if (event.ctrlKey) mods.add("Mod");
    if (event.metaKey) return [];
  }
  if (event.altKey && !altGraph) mods.add("Alt");
  if (event.shiftKey) mods.add("Shift");

  const keys = new Set<string>();
  const key = event.key === " " ? "Space" : event.key;
  const ascii = key.length === 1 && /[\x21-\x7e]/.test(key);
  if (NAMED.has(key)) keys.add(key);
  else if (ascii) keys.add(key.toLowerCase());
  // The physical key stands in only while Ctrl/⌘/Alt is held: Option changes the character on a Mac, and
  // non-Latin layouts type other letters. Without a modifier it would turn typing into shortcuts.
  if (mods.has("Mod") || mods.has("Ctrl") || mods.has("Alt")) {
    const letter = /^Key([A-Z])$/.exec(event.code)?.[1] ?? /^Digit(\d)$/.exec(event.code)?.[1];
    if (letter) keys.add(letter.toLowerCase());
    else if (!ascii && CODE_KEYS[event.code]) keys.add(CODE_KEYS[event.code]!);
  }
  return [...keys].map((k) => {
    const own = new Set(mods);
    if (isSymbol(k)) own.delete("Shift");
    return stringifyCombo({ mods: own, key: k });
  });
}

/** Whether a combo includes Ctrl, ⌘, or Alt. Those are the only ones allowed while typing in a field. */
export function isChord(text: string): boolean {
  const combo = parseCombo(text);
  return !!combo && (combo.mods.has("Mod") || combo.mods.has("Ctrl") || combo.mods.has("Alt"));
}

/** Function keys do nothing in a text field, so they may fire there too. */
export function firesWhileTyping(text: string): boolean {
  const combo = parseCombo(text);
  return !!combo && (isChord(text) || /^F\d+$/.test(combo.key));
}

const MAC_SYMBOLS: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
const KEY_LABELS: Record<string, string> = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", Backspace: platform === "mac" ? "⌫" : "Backspace",
  Delete: "Del", Enter: platform === "mac" ? "↩" : "Enter", Space: "Space", PageUp: "PgUp", PageDown: "PgDn",
};

/** Display parts for one combo, one per key cap. */
export function comboKeys(text: string): string[] {
  const combo = parseCombo(text);
  if (!combo) return [text];
  const mods = MODIFIERS.filter((m) => combo.mods.has(m)).map((m) =>
    platform === "mac" ? MAC_SYMBOLS[m]! : m === "Mod" ? "Ctrl" : m,
  );
  const key = KEY_LABELS[combo.key] ?? (combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
  return [...mods, key];
}

export function formatCombo(text: string): string {
  return comboKeys(text).join(platform === "mac" ? "" : "+");
}

/** For `aria-keyshortcuts`, which names the real keys. */
export function ariaCombo(text: string): string {
  const combo = parseCombo(text);
  if (!combo) return text;
  const mods = MODIFIERS.filter((m) => combo.mods.has(m)).map((m) =>
    m === "Mod" ? (platform === "mac" ? "Meta" : "Control") : m === "Ctrl" ? "Control" : m,
  );
  return [...mods, combo.key === "Space" ? "Space" : combo.key.length === 1 ? combo.key.toUpperCase() : combo.key].join("+");
}

/**
 * Browser and OS shortcuts. `blocked` ones never reach the page (Chrome and Firefox handle them first);
 * `taken` ones reach it, but taking them away surprises people.
 */
export function browserConflict(text: string): { level: "blocked" | "taken"; what: PlainMessageKey } | null {
  const combo = normalizeCombo(text);
  if (!combo) return null;
  const blocked: Record<string, PlainMessageKey> = {
    "Mod+T": "keyboard.conflictNewTab", "Mod+W": "keyboard.conflictCloseTab", "Mod+N": "keyboard.conflictNewWindow", "Mod+Shift+T": "keyboard.conflictReopenClosedTab",
    "Mod+Shift+N": "keyboard.conflictPrivateWindow", "Mod+Shift+W": "keyboard.conflictCloseWindow", "Mod+Q": "keyboard.conflictQuit", "Mod+Shift+Q": "keyboard.conflictQuit",
    "Mod+Tab": "keyboard.conflictNextTab", "Mod+Shift+Tab": "keyboard.conflictPreviousTab", "Mod+PageUp": "keyboard.conflictPreviousTab", "Mod+PageDown": "keyboard.conflictNextTab",
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`Mod+${i + 1}`, "keyboard.conflictSwitchTab" as const])),
    "Alt+F4": "keyboard.conflictCloseWindow", "F11": "keyboard.conflictFullScreen", "F12": "keyboard.conflictDeveloperTools", "Mod+Shift+I": "keyboard.conflictDeveloperTools",
    "Mod+Shift+J": "keyboard.conflictDeveloperTools", "Mod+Shift+C": "keyboard.conflictDeveloperTools",
  };
  if (platform === "mac") Object.assign(blocked, { "Mod+H": "keyboard.conflictHideApp", "Mod+M": "keyboard.conflictMinimize", "Mod+Space": "keyboard.conflictSpotlight", "Mod+Alt+I": "keyboard.conflictDeveloperTools" });
  const taken: Record<string, PlainMessageKey> = {
    "Mod+F": "keyboard.conflictFind", "Mod+G": "keyboard.conflictFindNext", "Mod+Shift+G": "keyboard.conflictFindPrevious", "Mod+P": "keyboard.conflictPrint", "Mod+S": "keyboard.conflictSavePage",
    "Mod+O": "keyboard.conflictOpenFile", "Mod+R": "keyboard.conflictReload", "Mod+Shift+R": "keyboard.conflictHardReload", "F5": "keyboard.conflictReload", "Mod+L": "keyboard.conflictAddressBar",
    "Mod+D": "keyboard.conflictBookmark", "Mod+H": "keyboard.conflictHistory", "Mod+J": "keyboard.conflictDownloads", "Mod+U": "keyboard.conflictPageSource", "Mod+E": "keyboard.conflictSearch",
    "Mod+A": "keyboard.conflictSelectAll", "Mod+C": "keyboard.conflictCopy", "Mod+V": "keyboard.conflictPaste", "Mod+X": "keyboard.conflictCut", "Mod+Z": "keyboard.conflictUndo", "Mod+Y": "keyboard.conflictRedo",
    "Mod+Shift+Z": "keyboard.conflictRedo", "Mod+Shift+V": "keyboard.conflictPasteAsPlainText", "Mod+Shift+A": "keyboard.conflictTabSearch", "Mod+Shift+B": "keyboard.conflictBookmarksBar",
    "Mod+Shift+O": "keyboard.conflictBookmarkManager", "Mod+Shift+Delete": "keyboard.conflictClearBrowsingData", "Mod+Shift+P": "keyboard.conflictPrivateWindowFirefox",
    "Mod+Shift+K": "keyboard.conflictWebConsoleFirefox", "Mod+Shift+E": "keyboard.conflictNetworkMonitorFirefox", "Mod+Shift+S": "keyboard.conflictScreenshotFirefox",
    "Mod+Shift+H": "keyboard.conflictHistoryFirefox", "Mod+Shift+Y": "keyboard.conflictDownloadsFirefox", "Mod+Shift+M": "keyboard.conflictProfiles", "Mod+Shift+D": "keyboard.conflictBookmarkAllTabs",
    "Mod+Shift+U": "keyboard.conflictUnicodeInputLinux", "Mod+Shift+X": "keyboard.conflictTextDirectionFirefox", "Mod+B": "keyboard.conflictBoldTextFields",
    "Mod+I": "keyboard.conflictItalicTextFields", "Mod+0": "keyboard.conflictResetZoom", "Mod+-": "keyboard.conflictZoomOut", "Mod+=": "keyboard.conflictZoomIn", "Mod+Plus": "keyboard.conflictZoomIn",
    "Alt+ArrowLeft": "keyboard.conflictBack", "Alt+ArrowRight": "keyboard.conflictForward", "Alt+Home": "keyboard.conflictHomePage", "F1": "keyboard.conflictHelp", "F3": "keyboard.conflictFindNext",
    "F6": "keyboard.conflictAddressBar", "F7": "keyboard.conflictCaretBrowsing", "Mod+Shift+F": "keyboard.conflictFullScreenMac", "Shift+Escape": "keyboard.conflictTaskManagerChrome",
    "Mod+,": "keyboard.conflictBrowserSettingsMac", "Mod+K": "keyboard.conflictWebSearch",
    "Tab": "keyboard.conflictMoveFocus", "Shift+Tab": "keyboard.conflictMoveFocus",
  };
  // Windows and Linux open browser menus with Alt+letter.
  if (platform !== "mac") for (const letter of "FEVSBTHD") taken[`Alt+${letter}`] = "keyboard.conflictBrowserMenu";
  if (blocked[combo]) return { level: "blocked", what: blocked[combo] };
  if (taken[combo]) return { level: "taken", what: taken[combo] };
  return null;
}
