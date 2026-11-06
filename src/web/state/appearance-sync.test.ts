/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserAppearance } from "../../shared/appearance.js";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
}, configurable: true });
const { appearancePatch } = await import("./appearance-sync.js");
const { DEFAULT_APPEARANCE } = await import("./appearance.js");
const { applyMessageLayout } = await import("../theme/settings.js");

const { fontSizeInterface: _device, ...synced } = DEFAULT_APPEARANCE;
const base: UserAppearance = { ...synced, theme: "", mode: "system", halves: null, customThemes: [] };

test("an unchanged snapshot produces no patch", () => {
  assert.deepEqual(appearancePatch(base, { ...base }), {});
});

test("the patch carries exactly the changed fields", () => {
  assert.equal(base.messageLayout, "timeline");
  assert.deepEqual(appearancePatch(base, { ...base, messageLayout: "bubbles" }), { messageLayout: "bubbles" });
  assert.deepEqual(appearancePatch(base, { ...base, messageLayout: "bubbles", chatWidth: "wide" }), { messageLayout: "bubbles", chatWidth: "wide" });
});

test("nested values compare structurally, not by reference", () => {
  const a: UserAppearance = { ...base, halves: { light: "ocean" }, motionOff: ["icons"], customThemes: [{ id: "x", label: "X", appearance: "dark", colors: {} }] };
  const b: UserAppearance = { ...a, halves: { light: "ocean" }, motionOff: ["icons"], customThemes: [{ id: "x", label: "X", appearance: "dark", colors: {} }] };
  assert.deepEqual(appearancePatch(a, b), {});
  assert.deepEqual(appearancePatch(a, { ...b, motionOff: ["icons", "loading"] }), { motionOff: ["icons", "loading"] });
});

test("the layout attribute falls back to timeline for an invalid value", () => {
  const root = { dataset: {} as DOMStringMap } as unknown as HTMLElement;
  applyMessageLayout(root, "bubbles");
  assert.equal(root.dataset.messageLayout, "bubbles");
  applyMessageLayout(root, "bubble" as never);
  assert.equal(root.dataset.messageLayout, "timeline");
});
