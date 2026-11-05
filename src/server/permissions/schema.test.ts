import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
const directory = mkdtempSync(join(tmpdir(), "okaychat-permissions-"));
process.env.OKAYCHAT_DATA_DIR = directory;
process.env.OKAYCHAT_SECRET = "permission-test-secret-only-not-for-production";
after(() => rmSync(directory, { recursive: true, force: true }));
const { changeSchema, parseStrictJson, policyDocumentSchema, promptRuleSchema } = await import("./schema.js");

test("policy schema is strict and accepts explicit null/zero boundaries",()=>{
 assert.equal(policyDocumentSchema.safeParse({version:1,features:{code:false},limits:{maxSearches:0,outputTokens:null}}).success,true);
 for(const value of [{version:2},{version:1,extra:true},{version:1,features:{unknown:true}},{version:1,limits:{maxSteps:0}},{version:1,limits:{maxSteps:1.5}},{version:1,limits:{maxSteps:"4"}}]) assert.equal(policyDocumentSchema.safeParse(value).success,false,JSON.stringify(value));
});
test("strict JSON rejects duplicate keys and trailing content",()=>{
 assert.throws(()=>parseStrictJson('{"version":1,"version":1}'));
 assert.throws(()=>parseStrictJson('{"x":1} false'));
});
test("prompt rules preserve whitespace and normalize only CRLF; append must be nonempty",()=>{
 assert.deepEqual(promptRuleSchema.parse({mode:"replace",text:"  a\r\nb  "}),{mode:"replace",text:"  a\nb  "});
 assert.equal(promptRuleSchema.safeParse({mode:"append",text:" \n "}).success,false);
});
test("change destinations require strict valid destinations",()=>{
 const good={kind:"policy",subject:{kind:"user",id:"u"},modelRef:"provider/model/with/slash",document:{version:1}};
 assert.equal(changeSchema.safeParse(good).success,true);
 assert.equal(changeSchema.safeParse({...good,extra:1}).success,false);
 assert.equal(changeSchema.safeParse({...good,modelRef:"model"}).success,false);
});
