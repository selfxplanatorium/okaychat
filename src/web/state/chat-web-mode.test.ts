import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { chatWebMode, useChatWebStore } from "./chat-web-mode";

beforeEach(() => useChatWebStore.setState({ byId: {} }));

const local = { id: "local" };
const mode = (item = local, webTools = true) => chatWebMode(useChatWebStore.getState().byId, item, webTools);

test("default follows web tools; choosing either mode replaces the other", () => {
  assert.equal(mode(), "search");
  assert.equal(mode(local, false), "off");
  const { toggle } = useChatWebStore.getState();
  toggle(local, "research", true);
  assert.equal(mode(), "research");
  toggle(local, "search", true);
  assert.equal(mode(), "search");
  toggle(local, "search", true);
  assert.equal(mode(), "off");
  toggle(local, "research", true);
  toggle(local, "research", true);
  assert.equal(mode(), "off");
  // An explicit off choice survives a later change to the account default.
  assert.equal(mode(local, false), "off");
  assert.equal(mode(), "off");
});

test("a new chat keeps its chosen mode after receiving a remote id", () => {
  const { toggle, bind } = useChatWebStore.getState();
  const remote = { id: "local", remoteId: "saved" };
  toggle(local, "research", true);
  bind(local.id, "saved");
  assert.equal(mode(remote), "research");
  toggle(remote, "search", true);
  assert.equal(mode(remote), "search");
  assert.equal(mode({ id: "saved" }), "search");
  assert.equal(mode({ id: "another" }), "search");
  assert.equal(mode({ id: "another" }, false), "off");
});

test("binding an untouched chat keeps the account default live", () => {
  useChatWebStore.getState().bind("local", "saved");
  assert.equal(mode({ id: "saved" }), "search");
  assert.equal(mode({ id: "saved" }, false), "off");
});
