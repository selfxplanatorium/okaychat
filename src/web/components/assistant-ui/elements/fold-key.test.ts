import assert from "node:assert/strict";
import { test } from "node:test";
import { emailResultKey } from "./fold-key.js";

// Regression for the folding bug: email_read/send/reply cards were added to messageGroupBy but had
// no result key, so foldWork collapsed them into the work log once the reply completed.
test("an email read keeps one card per opaque message id", () => {
  const first = emailResultKey("email_read", "call-1", { messageId: "opaque-one" });
  const second = emailResultKey("email_read", "call-2", { messageId: "opaque-two" });
  assert.equal(first, "email-read:default:opaque-one");
  assert.notEqual(first, second);
  assert.notEqual(emailResultKey("email_read", "call-1", { accountId: "work", messageId: "same" }), emailResultKey("email_read", "call-2", { accountId: "personal", messageId: "same" }));
  assert.equal(emailResultKey("email_read", "call-3", {}), undefined);
});

test("each send and reply is its own outcome", () => {
  const args = { from: "me@example.test", to: [{ address: "you@example.test" }], subject: "Hi", body: "Hello" };
  assert.equal(emailResultKey("email_send", "send-1", args), "email_send:send-1");
  assert.notEqual(emailResultKey("email_send", "send-1", args), emailResultKey("email_send", "send-2", args));
  assert.equal(emailResultKey("email_reply", "reply-1", args), "email_reply:reply-1");
  assert.equal(emailResultKey("email_list", "list-1", args), undefined);
});
