import test from "node:test";
import assert from "node:assert/strict";
import { assignLeases, createDowngradeMonitor, effectiveGlass, isLowEnd, mapDensity, TIER_BUDGETS } from "./glass-policy";

const env = (overrides = {}) => ({ forcedColors:false, reducedTransparency:false, reducedMotion:false, motionOff:false, backdropFilter:true, coarsePointer:false, ...overrides });
const prefs = (glassPerformance:"auto"|"high"|"balanced"|"css"|"off" = "auto", glassOpacity=50) => ({glassPerformance,glassOpacity});

test("hard policy precedence and CSS/solid downgrades",()=>{
  assert.deepEqual(effectiveGlass(prefs("high"),env()).tier,"high");
  assert.equal(effectiveGlass(prefs("high"),env({forcedColors:true,reducedTransparency:true,reducedMotion:true})).reason,"forced-colors");
  assert.equal(effectiveGlass(prefs("high",100),env()).reason,"opaque");
  assert.equal(effectiveGlass(prefs("high"),env({reducedMotion:true})).tier,"solid");
  assert.equal(effectiveGlass(prefs("high"),env({motionOff:true})).tier,"css");
  assert.equal(effectiveGlass(prefs("high"),env({backdropFilter:false})).tier,"solid");
  assert.equal(effectiveGlass(prefs("off"),env()).tier,"solid");
  assert.equal(effectiveGlass(prefs("css"),env()).tier,"css");
});

test("auto selection and low-end signals include inclusive thresholds",()=>{
  assert.equal(isLowEnd({deviceMemory:4}),true); assert.equal(isLowEnd({hardwareConcurrency:4}),true); assert.equal(isLowEnd({saveData:true}),true);
  assert.equal(isLowEnd({deviceMemory:4.1,hardwareConcurrency:5,saveData:false}),false);
  assert.equal(effectiveGlass(prefs(),env()).tier,"balanced");
  assert.equal(effectiveGlass(prefs(),env({deviceMemory:8,hardwareConcurrency:8})).tier,"high");
  assert.equal(effectiveGlass(prefs("high"),env({deviceMemory:4})).tier,"css");
  assert.equal(effectiveGlass(prefs("high"),env({downgrade:"balanced"})).tier,"balanced");
});

test("lease ordering, stable ties, visibility, source and pixel budgets",()=>{
  const c=(id: string,priority: number,order: number,sourceId: string | null="route",sourcePixels=100,extra={})=>({id,priority,order,control:false,sourceId,sourcePixels,visible:true,suspended:false,...extra});
  assert.deepEqual([...assignLeases([c("low",10,0),c("top",100,1),c("tie2",50,2),c("tie1",50,1)],"balanced")], ["top"]);
  assert.deepEqual([...assignLeases([c("hidden",100,0,"a",10,{visible:false}),c("bad",90,1,null),c("large",80,2,"a",800001)],"balanced")],[]);
  assert.equal(assignLeases([c("a",90,0,"a"),c("b",80,1,"b")],"balanced").size,1);
  assert.equal(assignLeases([c("modal",100,0),c("composer",80,1,"b")],"high").size,2);
  assert.equal(TIER_BUDGETS.css.sources,0);
});

test("map density refuses invalid or below-half-resolution sizes",()=>{
  assert.equal(mapDensity(0,100,2,"high"),null);
  assert.equal(mapDensity(100,100,2,"high"),1.5);
  assert.equal(mapDensity(2000,2000,1,"balanced"),null);
});

test("downgrade monitor counts only active visible samples and never upgrades",()=>{
  const m=createDowngradeMonitor("high");
  for(let i=0;i<20;i++) m.frame(30,{active:false,visible:true}); assert.equal(m.tier,"high");
  for(let i=0;i<9;i++) m.frame(25,{active:true,visible:true}); assert.equal(m.frame(25,{active:true,visible:true}),"balanced");
  assert.equal(m.frame(100,{active:true,visible:true}),null);
  for(let i=0;i<2;i++) m.window(61,{active:true,visible:true}); assert.equal(m.tier,"css");
});
