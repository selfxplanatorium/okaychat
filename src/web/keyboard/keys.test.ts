/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { browserConflict, eventCombos, firesWhileTyping, formatCombo, isChord, normalizeCombo, platform } from "./keys.js";
import { COMMANDS, resolveBindings } from "./commands.js";

const press = (key: string, code: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "altGraph", boolean>> = {}) =>
  eventCombos({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

test("normalizeCombo orders modifiers and drops Shift from symbols", () => {
  assert.equal(normalizeCombo("Shift+Alt+n"), "Alt+Shift+N");
  assert.equal(normalizeCombo("Shift+?"), "?");
  assert.equal(normalizeCombo("Mod+Plus"), "Mod+Plus");
  assert.equal(normalizeCombo("Hyper+N"), null);
  assert.equal(normalizeCombo("Alt+Alt+N"), null);
  assert.equal(normalizeCombo("Alt+"), null);
});

test("eventCombos matches letters by character and by physical key", { skip: platform === "mac" }, () => {
  assert.deepEqual(press("N", "KeyN", { altKey: true, shiftKey: true }), ["Alt+Shift+N"]);
  assert.deepEqual(press("k", "KeyK", { ctrlKey: true }), ["Mod+K"]);
  // A Cyrillic layout types another letter; the physical key still matches the binding.
  assert.ok(press("л", "KeyK", { ctrlKey: true }).includes("Mod+K"));
  // Without a modifier the physical key never stands in, so typing stays typing.
  assert.deepEqual(press("л", "KeyK"), []);
});

test("eventCombos treats symbols by character, whichever layout produced them", { skip: platform === "mac" }, () => {
  // German: / is Shift+7, ? is Shift+ß.
  assert.ok(press("/", "Digit7", { ctrlKey: true, shiftKey: true }).includes("Mod+/"));
  assert.deepEqual(press("?", "Minus", { shiftKey: true }), ["?"]);
  // US: ? is Shift+/.
  assert.deepEqual(press("?", "Slash", { shiftKey: true }), ["?"]);
});

test("eventCombos ignores AltGr, modifier-only presses, and stray Windows keys", { skip: platform === "mac" }, () => {
  assert.deepEqual(press("@", "KeyQ", { ctrlKey: true, altKey: true, altGraph: true }), ["@"]);
  assert.deepEqual(press("Shift", "ShiftLeft", { shiftKey: true }), []);
  assert.deepEqual(press("n", "KeyN", { metaKey: true }), []);
});

test("named keys keep their names", () => {
  assert.deepEqual(press("ArrowUp", "ArrowUp", { altKey: true, shiftKey: true }), ["Alt+Shift+ArrowUp"]);
  assert.deepEqual(press(" ", "Space"), ["Space"]);
  assert.deepEqual(press("F2", "F2"), ["F2"]);
});

test("only chords and function keys fire while typing", () => {
  assert.equal(isChord("Alt+Shift+N"), true);
  assert.equal(isChord("Shift+N"), false);
  assert.equal(firesWhileTyping("F2"), true);
  assert.equal(firesWhileTyping("J"), false);
  assert.equal(firesWhileTyping("Escape"), false);
});

test("browserConflict separates blocked from overridable shortcuts", () => {
  assert.equal(browserConflict("Mod+T")?.level, "blocked");
  assert.equal(browserConflict("Mod+F")?.level, "taken");
  assert.equal(browserConflict("Alt+Shift+N"), null);
});

test("no default binding clashes with a browser shortcut or another default", () => {
  assert.equal(new Set(COMMANDS.map((command) => command.id)).size, COMMANDS.length, "command ids must be unique");
  const defaults = resolveBindings(undefined);
  const seen = new Map<string, string>();
  for (const command of COMMANDS) {
    for (const combo of defaults.get(command.id) ?? []) {
      const conflict = browserConflict(combo);
      // Mod+K is the established search shortcut in web apps; the browser's web search stays on Ctrl+E/Alt+D.
      if (combo !== "Mod+K") assert.equal(conflict, null, `${command.id}: ${combo} is the browser's ${conflict?.what}`);
      const other = seen.get(combo);
      assert.equal(other, undefined, `${combo} is bound to both ${other} and ${command.id}`);
      seen.set(combo, command.id);
    }
  }
});

test("account overrides replace defaults, and an empty list unbinds", () => {
  const bindings = resolveBindings({ bindings: { "nav.newChat": ["shift+alt+q"], "app.search": [] } });
  assert.deepEqual(bindings.get("nav.newChat"), ["Alt+Shift+Q"]);
  assert.deepEqual(bindings.get("app.search"), []);
  assert.deepEqual(bindings.get("app.toggleSidebar"), ["Alt+Shift+S"]);
});

test("formatCombo spells keys for people", { skip: platform === "mac" }, () => {
  assert.equal(formatCombo("Mod+Shift+K"), "Ctrl+Shift+K");
  assert.equal(formatCombo("Alt+Shift+ArrowUp"), "Alt+Shift+↑");
});
