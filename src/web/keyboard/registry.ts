import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { KeyboardSettings } from "@shared/types";
import { useData } from "@/state/data";
import { COMMANDS, type CommandDef, resolveBindings } from "./commands";
import { ariaCombo, eventCombos, firesWhileTyping, formatCombo, isChord } from "./keys";

/** Return false when the command does not apply right now, so the next handler or the DOM target gets a turn. */
type Handler = () => boolean | void;

const handlers = new Map<string, Handler[]>();

/**
 * Lets a mounted component run a command, usually because it owns the state involved. The newest
 * registration wins. Without one, the command clicks the visible `[data-command=<id>]` element.
 */
export function useCommand(id: string, handler: Handler, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const own: Handler = () => ref.current();
    handlers.set(id, [...(handlers.get(id) ?? []), own]);
    return () => {
      const rest = (handlers.get(id) ?? []).filter((h) => h !== own);
      if (rest.length) handlers.set(id, rest);
      else handlers.delete(id);
    };
  }, [id, enabled]);
}

const visible = (el: HTMLElement) =>
  !el.closest("[inert], [aria-hidden=true]") && (el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null);

/** The control a command clicks: the last visible, enabled one, so the newest message wins. */
export function commandTarget(id: string, root: ParentNode = document): HTMLElement | null {
  const all = [...root.querySelectorAll<HTMLElement>(`[data-command="${id}"]`)].reverse();
  return all.find((el) => visible(el) && !el.matches(":disabled, [aria-disabled=true], [data-disabled]")) ?? null;
}

/** Focus first, so a menu or popover opened this way returns focus to its trigger when it closes. */
export function press(el: HTMLElement) {
  el.focus({ preventScroll: true });
  el.click();
}

export function runCommand(id: string): boolean {
  const list = handlers.get(id) ?? [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!() !== false) return true;
  const target = commandTarget(id);
  if (!target) return false;
  press(target);
  return true;
}

/** Whether running the command now would do something. Handlers count as available. */
export function commandAvailable(id: string): boolean {
  return (handlers.get(id)?.length ?? 0) > 0 || commandTarget(id) !== null;
}

/**
 * The two keyboard dialogs replace each other, so pressing one shortcut inside the other never stacks them.
 * `opener` is where focus was before the first of them opened; closing returns there, not to the replaced dialog.
 */
export const useKeyboardDialog = create<{
  open: "commands" | "search" | null;
  opener: HTMLElement | null;
  toggle: (dialog: "commands" | "search") => void;
  close: () => void;
}>((set, get) => ({
  open: null,
  opener: null,
  toggle: (dialog) => {
    const { open, opener } = get();
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    set({ open: open === dialog ? null : dialog, opener: open ? opener : focused });
  },
  close: () => set({ open: null }),
}));

/** For the dialogs' `finalFocus`: nothing while the other dialog took over, else the opener if still on the page. */
export function dialogReturnFocus(): HTMLElement | boolean {
  const { open, opener } = useKeyboardDialog.getState();
  if (open) return false;
  return opener?.isConnected ? opener : true;
}

let byCombo = new Map<string, CommandDef[]>();
let singleKeys = true;
let recording = false;

/** Set while the settings page records a combo, so pressing it does not also run its command. */
export function setRecording(active: boolean) {
  recording = active;
}

export function useKeyboardSettings(): KeyboardSettings {
  return useData((s) => s.settings?.keyboard) ?? EMPTY;
}
const EMPTY: KeyboardSettings = {};

export function useBindings(): Map<string, string[]> {
  const settings = useData((s) => s.settings?.keyboard);
  const ref = useRef<{ settings: KeyboardSettings | undefined; bindings: Map<string, string[]> } | null>(null);
  if (!ref.current || ref.current.settings !== settings) ref.current = { settings, bindings: resolveBindings(settings) };
  return ref.current.bindings;
}

/** First combo of a command, for tooltips and `aria-keyshortcuts`. */
export function useShortcut(id: string): string | undefined {
  return useBindings().get(id)?.[0];
}

/** Tooltip text and `aria-keyshortcuts` for a control that has a command. */
export function useShortcutProps(command: string, label: string) {
  const combo = useShortcut(command);
  return combo ? { title: `${label} (${formatCombo(combo)})`, "aria-keyshortcuts": ariaCombo(combo) } : { title: label };
}

const EDITABLE =
  "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=range]):not([type=file]):not([type=color]), textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox], [role=combobox], [role=searchbox]";
// Widgets that handle plain keys themselves (arrows, typeahead).
const KEY_WIDGETS = "[role=menu], [role=menubar], [role=listbox], [role=tablist], [role=slider], [role=radiogroup], [role=grid], [role=tree], [role=spinbutton]";

function handle(event: KeyboardEvent, chords: boolean) {
  if (recording) return;
  if (event.isComposing || event.keyCode === 229 || event.repeat && !/Arrow|^[jk]$/i.test(event.key)) return;
  const combos = eventCombos({
    key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey,
    altGraph: event.getModifierState?.("AltGraph"),
  });
  const target = event.target instanceof Element ? event.target : document.body;
  const typing = !!target.closest(EDITABLE);
  const message = target.closest("[data-message-root]");
  const modal = document.querySelector("[role=dialog][aria-modal=true], [role=alertdialog]");
  for (const combo of combos) {
    const chord = isChord(combo);
    // Chords are handled in the capture phase, before widgets; plain keys after, so widgets can claim them.
    if (chord !== chords) continue;
    if (!chord && (event.defaultPrevented || !singleKeys && !/^F\d+$/.test(combo))) continue;
    if (typing && !firesWhileTyping(combo)) continue;
    // Message commands first: inside a focused message they take precedence over the same key elsewhere.
    const candidates = [...(byCombo.get(combo) ?? [])].sort((a, b) => Number(b.scope === "message") - Number(a.scope === "message"));
    for (const command of candidates) {
      if (typing && command.id.startsWith("arena.")) continue;
      if (command.scope === "message") {
        if (!message || (modal && !modal.contains(message))) continue;
      } else {
        if (modal && command.scope !== "global") continue;
        if (!chord && target.closest(KEY_WIDGETS)) continue;
      }
      if (runCommand(command.id)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
  }
}

/** Installs the key listeners and keeps them on the account's current bindings. Mounted once in the shell. */
export function useKeyboardDispatcher() {
  const bindings = useBindings();
  const settings = useKeyboardSettings();
  useEffect(() => {
    const next = new Map<string, CommandDef[]>();
    for (const command of COMMANDS) {
      for (const combo of bindings.get(command.id) ?? []) next.set(combo, [...(next.get(combo) ?? []), command]);
    }
    byCombo = next;
    singleKeys = settings.singleKeys !== false;
  }, [bindings, settings.singleKeys]);
  useEffect(() => {
    const capture = (event: KeyboardEvent) => handle(event, true);
    const bubble = (event: KeyboardEvent) => handle(event, false);
    window.addEventListener("keydown", capture, true);
    window.addEventListener("keydown", bubble);
    return () => {
      window.removeEventListener("keydown", capture, true);
      window.removeEventListener("keydown", bubble);
    };
  }, []);
}
