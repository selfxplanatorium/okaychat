import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import type { ToolSet } from "ai";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-email-tools-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "email-tools-test-secret-only-not-for-production";
const { db } = await import("../db.js");
const { createAccount } = await import("./accounts.js");
const { emailTools } = await import("./tools.js");
const { RISK_METADATA_KEY, UNTRUSTED_TOOL_NAMES } = await import("../prompt-injection.js");
const { startImapServer, startSmtpServer } = await import("../../../test/email/servers.ts");
const { TEST_CERT } = await import("../../../test/email/fixtures.ts");

db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("alice", "alice@example.test", "Alice", "unused", "admin", Date.now());
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => {
  db.exec("DELETE FROM email_accounts; DELETE FROM uploads; UPDATE users SET storage_limit = NULL");
});

async function execute(tools: ToolSet, name: string, input: unknown = {}) {
  const run = tools[name]?.execute;
  assert.ok(run, `${name} should be available`);
  return run(input, { toolCallId: `test-${name}`, messages: [] });
}

function envelopeBody(text: string): string {
  const end = text.lastIndexOf("\n</untrusted_data>");
  return JSON.parse(text.slice(text.lastIndexOf("\n", end - 1) + 1, end)) as string;
}

test("send and reply always need approval and carry outbound risk; delegates never receive them", () => {
  const { tools, subTools } = emailTools({ userId: "alice" });
  assert.equal(tools.email_send?.needsApproval, true);
  assert.equal(tools.email_reply?.needsApproval, true);
  assert.deepEqual(tools.email_send?.metadata, { [RISK_METADATA_KEY]: "outbound" });
  assert.deepEqual(tools.email_reply?.metadata, { [RISK_METADATA_KEY]: "outbound" });
  assert.equal(subTools.email_send, undefined);
  assert.equal(subTools.email_reply, undefined);
  for (const name of ["email_folders", "email_list", "email_search", "email_read"]) {
    assert.ok(subTools[name], `${name} is read-only`);
    assert.ok(UNTRUSTED_TOOL_NAMES.has(name), `${name} taints replayed history`);
  }
  assert.equal(subTools.email_folders?.needsApproval, undefined);
});

test("temporary chats get no email tools at all", () => {
  assert.deepEqual(emailTools({ userId: "alice", temporary: true }), { tools: {}, subTools: {} });
});

test("read and send toggles are re-checked at execution, not captured when tools were built", async () => {
  const account = await createAccount("alice", {
    label: "Work",
    address: "alice@example.test",
    password: "app-password",
    imap: { host: "127.0.0.1", port: 993, security: "tls", username: "bob@example.test" },
    smtp: { host: "127.0.0.1", port: 465, security: "tls", username: "bob@example.test" },
  });
  const { tools } = emailTools({ userId: "alice" });
  db.prepare("UPDATE email_accounts SET read_enabled = 0, send_enabled = 0 WHERE id = ?").run(account.id);
  await assert.rejects(execute(tools, "email_folders"), /Reading is turned off/i);
  await assert.rejects(execute(tools, "email_send", { to: [{ address: "bob@example.test" }], subject: "Hi", body: "Hello" }), /Sending is turned off/i);
  db.prepare("UPDATE email_accounts SET read_enabled = 1, send_enabled = 1 WHERE id = ?").run(account.id);
});

test("list results are enveloped for the model while the card keeps raw data", async () => {
  const server = await startImapServer();
  try {
    await createAccount("alice", {
      label: "Work",
      address: "alice@example.test",
      password: "app-password",
      imap: { host: "127.0.0.1", port: server.port, security: "tls", username: "bob@example.test" },
      smtp: { host: "127.0.0.1", port: 465, security: "tls", username: "bob@example.test" },
    });
    const { tools } = emailTools({ userId: "alice", tls: { ca: TEST_CERT } });
    const output = await execute(tools, "email_list", { limit: 5 });
    assert.equal(output.messages.length, 2);
    assert.equal(output.messages[0].subject, "Report attached");
    const model = tools.email_list!.toModelOutput!({ output, input: { limit: 5 }, toolCallId: "t", messages: [] } as never) as { type: string; value: string };
    assert.equal(model.type, "text");
    assert.match(model.value, /^<untrusted_data/);
    assert.match(model.value, /kind="email"/);
    const body = JSON.parse(envelopeBody(model.value)) as { messages: Array<{ subject: string }> };
    assert.equal(body.messages[0]?.subject, "Report attached");
  } finally {
    await server.close();
  }
});

test("a reply can only reach people from the original conversation and keeps the thread headers", async () => {
  const imap = await startImapServer();
  const smtp = await startSmtpServer();
  try {
    await createAccount("alice", {
      label: "Work",
      address: "bob@example.test",
      password: "app-password",
      imap: { host: "127.0.0.1", port: imap.port, security: "tls", username: "bob@example.test" },
      smtp: { host: "127.0.0.1", port: smtp.port, security: "tls", username: "bob@example.test" },
    });
    const { tools } = emailTools({ userId: "alice", tls: { ca: TEST_CERT } });
    const listed = await execute(tools, "email_list", { limit: 5 });
    const original = listed.messages.find((message: { subject: string }) => message.subject === "Hello from Alice");
    await assert.rejects(
      execute(tools, "email_reply", {
        messageId: original.id,
        to: [{ address: "attacker@example.test" }],
        subject: "Re: Hello from Alice",
        body: "Leaking data",
      }),
      /original sender|did not appear/i,
    );
    const sent = await execute(tools, "email_reply", {
      messageId: original.id,
      to: [{ address: "alice@example.test" }],
      subject: "Re: Hello from Alice",
      body: "Thanks Alice.",
    });
    assert.deepEqual(sent.to, ["alice@example.test"]);
    const raw = smtp.messages[0] ?? "";
    assert.match(raw, /In-Reply-To: <hello@example\.test>/i);
    assert.match(raw, /References: .*<hello@example\.test>/i);
    assert.doesNotMatch(raw, /attacker@example\.test/);
    assert.match(raw, /Thanks Alice\./);
  } finally {
    await imap.close();
    await smtp.close();
  }
});

test("attachments download only when named, and obey the storage quota", async () => {
  const server = await startImapServer();
  try {
    await createAccount("alice", {
      label: "Work",
      address: "alice@example.test",
      password: "app-password",
      imap: { host: "127.0.0.1", port: server.port, security: "tls", username: "bob@example.test" },
      smtp: { host: "127.0.0.1", port: 465, security: "tls", username: "bob@example.test" },
    });
    const { tools } = emailTools({ userId: "alice", tls: { ca: TEST_CERT } });
    const listed = await execute(tools, "email_list", { limit: 5 });
    const messageId = listed.messages.find((message: { subject: string }) => message.subject === "Report attached").id;
    const plain = await execute(tools, "email_read", { messageId });
    assert.equal(plain.storedAttachments.length, 0);
    assert.equal(plain.message.attachments[0].filename, "report.pdf");
    assert.equal(db.prepare("SELECT count(*) AS n FROM uploads").get()!.n, 0);

    const downloaded = await execute(tools, "email_read", { messageId, downloadAttachments: ["2"] });
    assert.equal(downloaded.storedAttachments.length, 1);
    assert.match(downloaded.storedAttachments[0].url, /^\/api\/uploads\/upl_/);
    assert.equal((db.prepare("SELECT count(*) AS n FROM uploads").get() as { n: number }).n, 1);

    db.prepare("UPDATE users SET storage_limit = 1 WHERE id = 'alice'").run();
    const blocked = await execute(tools, "email_read", { messageId, downloadAttachments: ["2"] }).then(() => null, (error: unknown) => error as Error);
    assert.match(String(blocked?.message), /Storage quota exceeded/i);
  } finally {
    await server.close();
  }
});
