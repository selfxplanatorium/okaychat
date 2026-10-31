import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-email-accounts-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "email-accounts-test-secret-only-not-for-production";
const { db } = await import("../db.js");
const { decrypt, sha256 } = await import("../crypto.js");
const { assertEmailHost, accountSecrets, createAccount, deleteAccount, getAccount, listAccounts, setDefaultAccount, updateAccount } = await import("./accounts.js");

for (const [id, role] of [["alice", "admin"], ["bob", "user"]] as const) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", role, Date.now());
}
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => { db.exec("DELETE FROM email_accounts"); });

const input = (overrides: Record<string, unknown> = {}) => ({
  label: "Work mail",
  address: "alice@example.test",
  password: "app-secret-password",
  imap: { host: "127.0.0.1", port: 993, security: "tls", username: "alice@example.test" },
  smtp: { host: "127.0.0.1", port: 465, security: "tls", username: "alice@example.test" },
  signature: "Alice",
  ...overrides,
});

test("stores encrypted endpoints and password, and returns no secret", async () => {
  const created = await createAccount("alice", input());
  assert.equal(created.address, "alice@example.test");
  assert.equal(created.imap.host, "127.0.0.1");
  assert.equal(created.isDefault, true);
  assert.equal(created.readEnabled, true);
  assert.equal(created.sendEnabled, true);
  assert.equal(created.signature, "Alice");
  assert.equal(JSON.stringify(created).includes("app-secret-password"), false);
  const row = db.prepare("SELECT imap_enc, smtp_enc, password_enc FROM email_accounts WHERE id = ?").get(created.id) as { imap_enc: string; smtp_enc: string; password_enc: string };
  assert.ok(!row.imap_enc.includes("127.0.0.1"));
  assert.ok(!row.password_enc.includes("app-secret-password"));
  assert.equal(decrypt(row.password_enc), "app-secret-password");
  const secrets = accountSecrets("alice", created.id);
  assert.equal(secrets.userId, "alice");
  assert.equal(secrets.password, "app-secret-password");
  assert.deepEqual(secrets.imap, { host: "127.0.0.1", port: 993, security: "tls", username: "alice@example.test" });
  assert.doesNotMatch(JSON.stringify(listAccounts("alice")), /app-secret-password/);
});

test("another account cannot read, edit, or delete it", async () => {
  const created = await createAccount("alice", input());
  assert.throws(() => getAccount("bob", created.id), /not found/i);
  await assert.rejects(updateAccount("bob", created.id, { label: "Mine" }), /not found/i);
  assert.throws(() => deleteAccount("bob", created.id), /not found/i);
  assert.equal(listAccounts("bob").length, 0);
  assert.equal(listAccounts("alice").length, 1);
});

test("a blank password on edit keeps the stored one; changing a server or username requires it again", async () => {
  const created = await createAccount("alice", input());
  const edited = await updateAccount("alice", created.id, { label: "Renamed", signature: "New signature" });
  assert.equal(edited.label, "Renamed");
  assert.equal(accountSecrets("alice", created.id).password, "app-secret-password");
  await assert.rejects(updateAccount("alice", created.id, { imap: { ...created.imap, host: "127.0.0.2" } }), /password again/i);
  const changed = await updateAccount("alice", created.id, {
    imap: { ...created.imap, host: "127.0.0.2" },
    password: "new-password",
  });
  assert.equal(changed.imap.host, "127.0.0.2");
  assert.equal(accountSecrets("alice", created.id).password, "new-password");
});

test("default selection follows the account and is never left empty", async () => {
  const first = await createAccount("alice", input());
  const second = await createAccount("alice", input({ address: "second@example.test", label: "Second", imap: { ...input().imap as object, username: "second@example.test" } }));
  assert.equal(first.isDefault, true);
  assert.equal(second.isDefault, false);
  const promoted = setDefaultAccount("alice", second.id);
  assert.equal(promoted.isDefault, true);
  assert.equal(getAccount("alice", first.id).isDefault, false);
  deleteAccount("alice", second.id);
  assert.equal(getAccount("alice", first.id).isDefault, true);
});

test("validates hosts, ports, addresses, headers, and the account cap", async () => {
  await assert.rejects(createAccount("alice", input({ address: "not-an-address" })), /valid email address/i);
  for (const address of ["a@b.test,c@d.test", '"a"@b.test', "a(b)@c.test", "a@b.test;c@d.test"]) {
    await assert.rejects(createAccount("alice", input({ address })), /valid email address/i, address);
  }
  await assert.rejects(createAccount("alice", input({ label: "Line\nBreak" })), /line breaks/i);
  await assert.rejects(createAccount("alice", input({ imap: { host: "localhost", port: 993, security: "tls", username: "a@b.test" } })), /valid mail server/i);
  await assert.rejects(createAccount("alice", input({ imap: { host: "127.0.0.1", port: 0, security: "tls", username: "a@b.test" } })), /port between/i);
  await assert.rejects(createAccount("alice", input({ password: "" })), /password/i);
  for (let i = 0; i < 10; i++) await createAccount("alice", input({ address: `account${i}@example.test` }));
  await assert.rejects(createAccount("alice", input({ address: "one-too-many@example.test" })), /up to 10/i);
});

test("host guard allows an admin a LAN server but refuses a non-admin", async () => {
  await assertEmailHost("alice", "127.0.0.1");
  await assert.rejects(assertEmailHost("bob", "127.0.0.1"), /Only admins/i);
  await assert.rejects(assertEmailHost("bob", "10.0.0.5"), /Only admins/i);
  assert.ok(sha256("x").length === 64);
});
