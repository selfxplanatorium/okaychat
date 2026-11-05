import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePolicy, type PolicyDocument, type PolicyLayer } from "../../shared/permissions.js";

const row = (kind: "everyone"|"group"|"user", id: string, modelRef: string|null, document: Omit<PolicyDocument, "version">): PolicyLayer => ({subject:{kind,id},modelRef,document:{version:1,...document}});
test("precedence, selector specificity and group resolution ignore row order", () => {
  const layers=[row("everyone","",null,{features:{code:true},limits:{maxSteps:40}}),row("everyone","", "p/m",{features:{code:false}}),row("group","z",null,{features:{code:true},limits:{maxSteps:20}}),row("group","a",null,{features:{code:false},limits:{maxSteps:null}}),row("user","u",null,{features:{code:true},limits:{maxSteps:null}}),row("user","u","p/m",{features:{code:false}})];
  for (const permutation of [layers,[...layers].reverse(),[layers[2]!,layers[0]!,layers[4]!,layers[1]!,layers[5]!,layers[3]!]]) {
    const result=resolvePolicy(permutation,"p/m"); assert.equal(result.features.code,false); assert.equal(result.limits.maxSteps,50); assert.equal(result.modelAllowed,true);
  }
  assert.equal(resolvePolicy(layers.slice(0,4),"p/m").features.code,false);
});

test("null is unbounded for limits; aggregate and exact-model buckets coexist",()=>{
 const result=resolvePolicy([row("everyone","",null,{limits:{operationsPerMinute:12,concurrentOperations:5}}),row("user","u","p/model",{})],"p/model");
 assert.equal(result.buckets.aggregate.operationsPerMinute,12);
 assert.equal(result.buckets.model,null);
 const both=resolvePolicy([row("everyone","",null,{limits:{operationsPerMinute:12}}),row("user","u","p/model",{limits:{operationsPerMinute:4}})],"p/model");
 assert.equal(both.buckets.aggregate.operationsPerMinute,12); assert.equal(both.buckets.model?.operationsPerMinute,4);
});

test("group membership changes are reflected and hard caps cannot be relaxed",()=>{
 const base=row("everyone","",null,{limits:{concurrentTurns:null,maxSearches:null}}); const deny=row("group","g",null,{features:{webFetch:false}});
 assert.equal(resolvePolicy([base,deny],null).features.webFetch,false);
 assert.equal(resolvePolicy([base],null).features.webFetch,true);
 assert.equal(resolvePolicy([base],null).limits.concurrentTurns,4);
});
