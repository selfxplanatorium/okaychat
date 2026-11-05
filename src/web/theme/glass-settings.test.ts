import test from "node:test";
import assert from "node:assert/strict";
import { GLASS_DEFAULTS, GLASS_PRESET_VALUES, GLASS_RANGES } from "../../shared/appearance";
import { clampGlassValue, effectiveFrost, familyAlpha, glassPresetPatch, glassResetPatch, glassTokens, glassValuePatch, sanitizeGlass, solidFamilies, visibleGlassPreset } from "./glass";

test("standard is default; presets replace tuple and preserve unrelated settings",()=>{
  assert.equal(GLASS_DEFAULTS.glassPreset,"standard"); assert.deepEqual(glassPresetPatch("bold"),{glassPreset:"bold",...GLASS_PRESET_VALUES.bold});
  assert.equal(visibleGlassPreset(GLASS_PRESET_VALUES.standard),"standard");
  assert.equal(visibleGlassPreset({...GLASS_PRESET_VALUES.standard,glassFrost:13}),"custom");
});
test("inclusive clamp boundaries and malformed local values normalize safely",()=>{
  for(const [key,range] of Object.entries(GLASS_RANGES) as [keyof typeof GLASS_RANGES,typeof GLASS_RANGES[keyof typeof GLASS_RANGES]][]) {
    assert.equal(clampGlassValue(key,range.min),range.min); assert.equal(clampGlassValue(key,range.max),range.max);
    assert.equal(clampGlassValue(key,range.min-1),range.min); assert.equal(clampGlassValue(key,range.max+1),range.max);
    assert.equal(clampGlassValue(key,Number.NaN),GLASS_DEFAULTS[key]);
  }
  const normalized=sanitizeGlass({glassBend:99,glassFrost:NaN,glassPerformance:"wat",glassSidebar:false,glassCards:"no"});
  assert.equal(normalized.glassBend,GLASS_RANGES.glassBend.max); assert.equal(normalized.glassFrost,GLASS_DEFAULTS.glassFrost);
  assert.equal(normalized.glassPerformance,"auto"); assert.equal(normalized.glassSidebar,false); assert.equal(normalized.glassCards,GLASS_DEFAULTS.glassCards);
});
test("value patches derive preset from the complete tuple and reset preserves standard",()=>{
  assert.deepEqual(glassValuePatch(GLASS_PRESET_VALUES.standard,"glassBend",GLASS_PRESET_VALUES.bold.glassBend),{glassBend:GLASS_PRESET_VALUES.bold.glassBend,glassPreset:"custom"});
  assert.equal(glassResetPatch().glassOpacity,50); assert.equal(glassResetPatch().glassPreset,"standard");
});
test("dark frost, family alpha offsets, disabled families and tokens",()=>{
  assert.equal(effectiveFrost(24,true),24); assert.equal(effectiveFrost(12,true),16);
  assert.equal(familyAlpha("sidebar",50),75); assert.equal(familyAlpha("composer",50),80); assert.equal(familyAlpha("card",50),90);
  assert.deepEqual(solidFamilies({...GLASS_DEFAULTS,glassCards:false}),["cards"]);
  assert.equal(glassTokens(GLASS_PRESET_VALUES.standard)["--oc-glass-frost"],"12px");
});
