import test from "node:test";
import assert from "node:assert/strict";
import { appearanceSchema, GLASS_DEFAULTS, GLASS_PRESET_VALUES, GLASS_RANGES, parseAppearancePatch } from "./appearance";

test("Glass schema defaults, accepted enums and inclusive numeric boundaries",()=>{
  for(const [key,range] of Object.entries(GLASS_RANGES) as [keyof typeof GLASS_RANGES,typeof GLASS_RANGES[keyof typeof GLASS_RANGES]][]) {
    assert.equal(appearanceSchema.shape[key].safeParse(range.min).success,true);
    assert.equal(appearanceSchema.shape[key].safeParse(range.max).success,true);
    assert.equal(appearanceSchema.shape[key].safeParse(range.min-0.01).success,false);
    assert.equal(appearanceSchema.shape[key].safeParse(range.max+0.01).success,false);
  }
  const defaults=appearanceSchema.shape;
  assert.equal(defaults.glassPreset.parse(undefined),"standard"); assert.equal(defaults.glassPerformance.parse(undefined),"auto");
  assert.deepEqual(GLASS_PRESET_VALUES.standard,{glassBend:0.18,glassDispersion:0.12,glassFrost:12,glassRimShine:0.12,glassTint:3});
  assert.deepEqual(["glassSidebar","glassComposer","glassOverlays","glassCards","glassToolbars","glassControls"].map(k=>defaults[k as keyof typeof defaults].parse(undefined)),Array(6).fill(true));
  assert.equal(Reflect.get(GLASS_DEFAULTS, "glassOpacity"),undefined);
});

test("partial PATCH does not materialize omitted defaults and rejects invalid values",()=>{
  assert.deepEqual(parseAppearancePatch({glassFrost:16}),{success:true,data:{glassFrost:16}});
  assert.deepEqual(parseAppearancePatch({glassPerformance:"css"}),{success:true,data:{glassPerformance:"css"}});
  assert.deepEqual(parseAppearancePatch({glassFrost:25}),{success:false});
  assert.deepEqual(parseAppearancePatch({glassBend:NaN}),{success:false});
});

test('all Glass keys reject wrong types and nonfinite numbers without filling PATCH defaults', () => {
  assert.deepEqual(parseAppearancePatch({}), { success: true, data: {} });
  assert.deepEqual(parseAppearancePatch({ glassOpacity: 63 }), { success: true, data: { glassOpacity: 63 } });
  for (const key of Object.keys(GLASS_RANGES)) {
    for (const value of [null, NaN, Infinity, -Infinity, '1', true]) {
      assert.deepEqual(parseAppearancePatch({ [key]: value }), { success: false }, `${key}: ${String(value)}`);
    }
  }
  for (const key of ['glassSidebar', 'glassComposer', 'glassOverlays', 'glassCards', 'glassToolbars', 'glassControls']) {
    for (const value of [null, 0, 1, 'false', []]) assert.deepEqual(parseAppearancePatch({ [key]: value }), { success: false });
  }
  for (const key of ['glassPerformance', 'glassPreset']) {
    for (const value of [null, 1, true, 'unknown']) assert.deepEqual(parseAppearancePatch({ [key]: value }), { success: false });
  }
});
