/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SETTINGS_ANCHOR_PREFIX, SETTINGS_DESTINATIONS, settingsHref, type SettingsDestination } from "./settings-link.js";

test("settings links name their section and carry anchors as a focus query", () => {
  assert.equal(settingsHref("providers"), "/settings/providers");
  assert.equal(settingsHref("memory"), "/settings/memory");
  assert.equal(settingsHref("keyboard"), "/settings/keyboard");
  assert.equal(settingsHref("compaction"), "/settings/general?focus=compaction");
  assert.equal(settingsHref("webTools"), "/settings/general?focus=web-tools");
  assert.equal(settingsHref("webSearchLimit"), "/settings/general?focus=web-search-limit");
});

test("every anchor in the helper exists as a focusable row in its settings page", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "components", "settings", "GeneralSettings.tsx"), "utf8");
  for (const destination of Object.values(SETTINGS_DESTINATIONS) as SettingsDestination[]) {
    if (!destination.anchor) continue;
    assert.equal(destination.section, "general", `${destination.anchor} needs a file mapping in this test`);
    assert.ok(
      source.includes(`id="${SETTINGS_ANCHOR_PREFIX}${destination.anchor}"`),
      `GeneralSettings.tsx must render id="${SETTINGS_ANCHOR_PREFIX}${destination.anchor}"`,
    );
  }
});

test("every destination section is a page SettingsLayout renders", () => {
  const layout = readFileSync(join(import.meta.dirname, "..", "components", "settings", "SettingsLayout.tsx"), "utf8");
  for (const destination of Object.values(SETTINGS_DESTINATIONS) as SettingsDestination[]) {
    assert.ok(layout.includes(`\n  ${destination.section}: `), `SettingsLayout must map ${destination.section}`);
  }
});
