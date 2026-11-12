import test from "node:test";
import assert from "node:assert/strict";
import { appearanceSchema, isMessageLayout, parseAppearancePatch } from "./appearance";

test("message layout defaults to timeline, accepts only its two values, and patches only when sent", () => {
  assert.equal(appearanceSchema.shape.messageLayout.parse(undefined), "timeline");
  for (const value of ["timeline", "bubbles"]) assert.equal(appearanceSchema.shape.messageLayout.safeParse(value).success, true);
  for (const value of ["bubble", "chat", null, 1]) assert.equal(appearanceSchema.shape.messageLayout.safeParse(value).success, false, String(value));
  assert.deepEqual(parseAppearancePatch({ messageLayout: "bubbles" }), { success: true, data: { messageLayout: "bubbles" } });
  assert.deepEqual(parseAppearancePatch({ messageLayout: "timeline", chatWidth: "wide" }), { success: true, data: { messageLayout: "timeline", chatWidth: "wide" } });
  assert.deepEqual(parseAppearancePatch({ messageLayout: "bubble" }), { success: false });
  assert.equal(isMessageLayout("bubbles"), true);
  assert.equal(isMessageLayout("bubble"), false);
  assert.equal(isMessageLayout(undefined), false);
});

test("a snapshot written before the message layout existed parses as timeline", () => {
  const legacy = {
    theme: "t3code", mode: "system", halves: null, customThemes: [], glassOpacity: 80, appearanceContrast: 100,
    panelAnimationDurationMs: 180, chatWidth: "comfortable", fontFamilySans: "", fontFamilyComposer: "", fontFamilyCode: "",
    fontSizePrompt: 15, fontSizeCode: 13, fontSmoothing: true, wordWrap: true, typographyAdvanced: false,
  };
  const parsed = appearanceSchema.parse(legacy);
  assert.equal(parsed.messageLayout, "timeline");
});
