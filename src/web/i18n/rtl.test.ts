/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { UI_LOCALES } from "@shared/ui-locales";
import { textDirection } from "./index.js";

// RTL readiness ratchet. Logical properties (`ms-*`, `ps-*`, `start-*`, `text-start`) flip with `dir`,
// physical ones (`ml-*`, `left-*`, `text-left`) do not. Every new UI file joins this list.
const RTL_CHECKED_FILES = [
  "components/chat/VideoPlayer.tsx",
  "components/chat/VideoToolCard.tsx",
  "components/chat/VideoMessageDetails.tsx",
  "components/settings/VideoServicesSettings.tsx",
  "components/chat/MessageTranslation.tsx",
  "components/chat/TranslationDialog.tsx",
  "components/channels/ChannelPresenceDot.tsx",
  "components/channels/ChannelTypingIndicator.tsx",
  "components/channels/RoomArchiveDialog.tsx",
  "components/channels/RoomArchiveRoster.tsx",
  "components/webhooks/WebhookEditor.tsx",
  "components/webhooks/WebhookTestPreview.tsx",
  "components/webhooks/WebhookDeliveryLog.tsx",
  "components/settings/WebhookSettings.tsx",
  "components/settings/AdminWebhooks.tsx",
  "components/settings/TokenCreditBalanceCard.tsx",
  "components/settings/TokenCreditAdminDialog.tsx",
];

const FORBIDDEN = [
  /\b(?:ml|mr|pl|pr)-/,
  /\b(?:left|right)-\d/,
  /text-left/,
  /text-right/,
  /border-l-/,
  /border-r-/,
  /rounded-l-/,
  /rounded-r-/,
  /space-x-/,
];

test("translation UI uses logical direction properties", () => {
  const webRoot = join(import.meta.dirname, "..");
  const offenders: string[] = [];
  for (const file of RTL_CHECKED_FILES) {
    const text = readFileSync(join(webRoot, file), "utf8");
    for (const pattern of FORBIDDEN) {
      const match = pattern.exec(text);
      if (match) offenders.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("direction resolution is script-aware and not forced to ltr", () => {
  assert.equal(textDirection("ar"), "rtl");
  assert.equal(textDirection("he-IL"), "rtl");
  const info = new Intl.Locale("az-Arab") as Intl.Locale & { getTextInfo?: () => { direction?: string } };
  if (typeof info.getTextInfo === "function") {
    assert.equal(textDirection("az-Arab"), "rtl");
    assert.equal(textDirection("az-Latn"), "ltr");
  }
  // No RTL language ships yet; every registered row resolves ltr through the same resolver.
  for (const row of UI_LOCALES) assert.equal(textDirection(row.tag), "ltr");
});
