/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-settings-schema-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "settings-schema-test-secret-only-not-for-production";
const { db } = await import("./db.js");
const { settingsPatch } = await import("./settings-schema.js");
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });

test("the settings endpoint accepts only explicit known default reasoning levels", () => {
  for (const level of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.deepEqual(settingsPatch.parse({ defaultReasoningEffort: level }), { defaultReasoningEffort: level });
  }
  for (const level of ["default", "auto", null, 1]) {
    assert.equal(settingsPatch.safeParse({ defaultReasoningEffort: level }).success, false);
  }
});

test("unknown settings keys are dropped instead of reaching user settings", () => {
  const parsed = settingsPatch.safeParse({ onboardingSkipped: true, notASetting: "injected" });
  assert.equal(parsed.success, true);
  assert.equal(Object.hasOwn(parsed.success ? parsed.data : {}, "notASetting"), false);
});
