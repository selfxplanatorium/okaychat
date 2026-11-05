/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SETTINGS_ANCHOR_PREFIX, SETTINGS_DESTINATIONS, settingsHref, focusSettingAnchor, type SettingsDestination } from "./settings-link.js";

test("settings links name their section and carry anchors as a focus query", () => {
  assert.equal(settingsHref("providers"), "/settings/providers");
  assert.equal(settingsHref("memory"), "/settings/memory");
  assert.equal(settingsHref("email"), "/settings/email");
  assert.equal(settingsHref("keyboard"), "/settings/keyboard");
  assert.equal(settingsHref("compaction"), "/settings/general?focus=compaction");
  assert.equal(settingsHref("webTools"), "/settings/general?focus=web-tools");
  assert.equal(settingsHref("webSearchLimit"), "/settings/general?focus=web-search-limit");
  assert.equal(settingsHref("channelActivity"), "/settings/general?focus=channel-activity");
  assert.equal(settingsHref("webhooks"), "/settings/webhooks");
  assert.equal(settingsHref("webhookDeliveries", { endpoint: "wh_1" }), "/settings/webhooks?endpoint=wh_1");
});

test("every anchor in the helper exists as a focusable row in its settings page", () => {
  const apiAccessDir = join(import.meta.dirname, "..", "components", "settings", "api-access");
  const apiAccessSource = readdirSync(apiAccessDir)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => readFileSync(join(apiAccessDir, name), "utf8"))
    .join("\n");
  const files: Record<string, string> = {
    general: ["GeneralSettings.tsx", "VideoServicesSettings.tsx"].map(file => readFileSync(join(import.meta.dirname, "..", "components", "settings", file), "utf8")).join("\n"),
    apiAccess: apiAccessSource,
  };
  for (const destination of Object.values(SETTINGS_DESTINATIONS) as SettingsDestination[]) {
    if (!destination.anchor) continue;
    const source = files[destination.section];
    assert.ok(source, `${destination.anchor} needs a file mapping in this test`);
    assert.ok(
      source.includes(`id="${SETTINGS_ANCHOR_PREFIX}${destination.anchor}"`),
      `${destination.section} must render id="${SETTINGS_ANCHOR_PREFIX}${destination.anchor}"`,
    );
  }
});

test("every destination section is a page SettingsLayout renders", () => {
  const layout = readFileSync(join(import.meta.dirname, "..", "components", "settings", "SettingsLayout.tsx"), "utf8");
  for (const destination of Object.values(SETTINGS_DESTINATIONS) as SettingsDestination[]) {
    assert.ok(layout.includes(`\n  ${destination.section}: `), `SettingsLayout must map ${destination.section}`);
  }
});

test("focusing a settings link scrolls to its control without a second focus scroll", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const calls: unknown[] = [];
  const target = {
    scrollIntoView: (options: unknown) => calls.push(["scroll", options]),
    focus: (options: unknown) => calls.push(["focus", options]),
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    getElementById: (id: string) => id === "setting-compaction" ? target : null,
  } });
  try {
    assert.equal(focusSettingAnchor("missing"), false);
    assert.deepEqual(calls, []);
    assert.equal(focusSettingAnchor("compaction"), true);
    assert.deepEqual(calls, [["scroll", { block: "center" }], ["focus", { preventScroll: true }]]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
