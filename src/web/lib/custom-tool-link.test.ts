import assert from "node:assert/strict";
import { test } from "node:test";
import { customToolsHref, parseCustomToolsLink } from "./custom-tool-link.js";

test("custom tool links round-trip tool, draft and panel values", () => {
  assert.equal(customToolsHref(), "/plugins?tab=tools");
  assert.equal(customToolsHref({ toolId: "ct_a b" }), "/plugins?tab=tools&tool=ct_a+b");
  assert.equal(customToolsHref({ newKind: "http" }), "/plugins?tab=tools&new=http");
  assert.equal(customToolsHref({ toolId: "ct_1", panel: "test" }), "/plugins?tab=tools&tool=ct_1&panel=test");
  assert.throws(() => customToolsHref({ toolId: "ct_1", newKind: "python" }));
  assert.deepEqual(parseCustomToolsLink("?tab=tools&tool=ct_1&panel=test"), { toolId: "ct_1", newKind: null, panel: "test", invalid: false });
  assert.deepEqual(parseCustomToolsLink("?tab=tools&new=python"), { toolId: null, newKind: "python", panel: null, invalid: false });
  assert.equal(parseCustomToolsLink("?tab=tools&new=bogus").invalid, true);
  assert.equal(parseCustomToolsLink("?tab=tools&tool=ct_1&new=http").invalid, true);
});
