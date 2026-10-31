import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-email-protocol-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "email-protocol-test-secret-only-not-for-production";
after(() => rmSync(dataDir, { recursive: true, force: true }));
import type { EmailSecrets } from "./accounts.js";
import { startImapServer, startSmtpServer } from "../../../test/email/servers.js";
import { TEST_CERT } from "../../../test/email/fixtures.js";

const { EmailError } = await import("./errors.js");
const { downloadAttachment, listFolders, listMessages, readMessage, searchMessages, verifyAccount } = await import("./imap.js");
const { sendEmail, verifySmtp } = await import("./smtp.js");
const { probeServer } = await import("./discover.js");
const { db } = await import("../db.js");
db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("admin", "admin@example.test", "Admin", "unused", "admin", Date.now());

// These tests drive real node:net/node:tls mock servers. They cover TLS and STARTTLS connections,
// authentication, listing, searching, reading, attachment streaming, SMTP send, and both the
// certificate check and STARTTLS fail-closed behavior. No external network or provider is involved.

const tls = { ca: TEST_CERT };

function secrets(id: string, imapPort: number, smtpPort: number, imapSecurity: "tls" | "starttls" = "tls", smtpSecurity: "tls" | "starttls" = "tls"): EmailSecrets {
  return {
    account: {
      id,
      label: "Test",
      address: "bob@example.test",
      imap: { host: "127.0.0.1", port: imapPort, security: imapSecurity, username: "bob@example.test" },
      smtp: { host: "127.0.0.1", port: smtpPort, security: smtpSecurity, username: "bob@example.test" },
      readEnabled: true,
      sendEnabled: true,
      isDefault: true,
      signature: "Bob",
      allowInsecureProbe: false,
      lastCheckAt: null,
      lastCheckStatus: null,
      lastCheckError: null,
      createdAt: 1,
      updatedAt: 1,
    },
    password: "app-password",
    imap: { host: "127.0.0.1", port: imapPort, security: imapSecurity, username: "bob@example.test" },
    smtp: { host: "127.0.0.1", port: smtpPort, security: smtpSecurity, username: "bob@example.test" },
  };
}

test("IMAP over verified TLS lists folders and messages, searches, reads, and streams an attachment", async () => {
  const imap = await startImapServer();
  const smtp = await startSmtpServer();
  try {
    const config = secrets("imap-basic", imap.port, smtp.port);
    const folders = await listFolders(config, tls);
    assert.deepEqual(folders.map((folder) => folder.path), ["INBOX", "INBOX/Projects"]);

    const listed = await listMessages(config, { limit: 10 }, tls);
    assert.equal(listed.messages.length, 2);
    assert.equal(listed.messages[0]?.uid, 2);
    assert.equal(listed.messages[0]?.subject, "Report attached");
    assert.equal(listed.messages[0]?.unread, true);
    assert.equal(listed.messages[0]?.hasAttachments, true);
    assert.equal(listed.messages[1]?.unread, false);

    const found = await searchMessages(config, { text: "report" }, tls);
    assert.equal(found.messages.length, 2);

    const first = await readMessage(config, listed.messages[1]!.id, tls);
    assert.equal(first.message.subject, "Hello from Alice");
    assert.match(first.message.body, /First message body/);
    assert.equal(first.message.messageId, "<hello@example.test>");
    assert.equal(first.message.inReplyTo, "<earlier@example.test>");
    assert.deepEqual(first.message.references, ["<earlier@example.test>"]);
    assert.equal(first.message.replyTo[0]?.name, "Alice");

    const second = await readMessage(config, listed.messages[0]!.id, tls);
    assert.equal(second.message.attachments.length, 1);
    assert.equal(second.message.attachments[0]?.filename, "report.pdf");
    assert.equal(second.message.attachments[0]?.part, "2");

    const attachment = await downloadAttachment(config, listed.messages[0]!.id, "2", undefined, tls);
    assert.equal(attachment.filename, "report.pdf");
    assert.equal(attachment.mime, "application/pdf");
    assert.equal(Buffer.from(attachment.data).toString(), "PDFDATA");
  } finally {
    await imap.close();
    await smtp.close();
  }
});

test("IMAP and SMTP over STARTTLS require the upgrade and verify the certificate", async () => {
  const imap = await startImapServer({ starttls: true });
  const smtp = await startSmtpServer({ starttls: true });
  try {
    const config = secrets("imap-starttls", imap.port, smtp.port, "starttls", "starttls");
    const folders = await listFolders(config, tls);
    assert.equal(folders.length, 2);
    await verifySmtp(config, tls);

    const sent = await sendEmail(config, { to: [{ address: "alice@example.test" }], subject: "StartTLS", text: "Hello" }, { tls });
    assert.deepEqual(sent.accepted, ["alice@example.test"]);
    assert.match(smtp.messages[0] ?? "", /Subject: StartTLS/);
  } finally {
    await imap.close();
    await smtp.close();
  }
});

test("a server without STARTTLS is refused instead of sending credentials in cleartext", async () => {
  const imap = await startImapServer({ starttls: true, offerTls: false });
  const smtp = await startSmtpServer({ starttls: true, offerTls: false });
  try {
    const config = secrets("imap-no-starttls", imap.port, smtp.port, "starttls", "starttls");
    await assert.rejects(listFolders(config, tls), (error: unknown) => error instanceof EmailError && (error.code === "protocol" || error.code === "auth"));
    await assert.rejects(verifySmtp(config, tls), (error: unknown) => error instanceof EmailError && error.code === "protocol");
  } finally {
    await imap.close();
    await smtp.close();
  }
});

test("a self-signed certificate is rejected unless explicitly trusted by the test", async () => {
  const imap = await startImapServer();
  const smtp = await startSmtpServer();
  try {
    const config = secrets("imap-cert", imap.port, smtp.port);
    await assert.rejects(listFolders(config), (error: unknown) => error instanceof EmailError && error.code === "certificate");
    await assert.rejects(
      sendEmail(config, { to: [{ address: "alice@example.test" }], subject: "Nope", text: "Hello" }),
      (error: unknown) => error instanceof EmailError && error.code === "certificate",
    );
    await assert.rejects(verifySmtp(config), (error: unknown) => error instanceof EmailError && error.code === "certificate");
  } finally {
    await imap.close();
    await smtp.close();
  }
});

test("SMTP sends exactly the approved recipients and body", async () => {
  const smtp = await startSmtpServer();
  const config = secrets("smtp-send", 1, smtp.port);
  try {
    const sent = await sendEmail(config, {
      to: [{ address: "alice@example.test", name: "Alice" }],
      cc: [{ address: "carol@example.test" }],
      subject: "Lunch",
      text: "See you at noon.",
    }, { tls });
    assert.equal(sent.to.length, 1);
    assert.deepEqual(sent.cc, ["carol@example.test"]);
    assert.deepEqual(sent.accepted, ["alice@example.test", "carol@example.test"]);
    const message = smtp.messages[0] ?? "";
    assert.match(message, /To: Alice <alice@example.test>/i);
    assert.match(message, /Cc: carol@example.test/i);
    assert.match(message, /See you at noon\./);
    assert.match(message, /Bob/);
  } finally {
    await smtp.close();
  }
});

test("probes verify TLS and STARTTLS and reject private hosts for non-admins", async () => {
  const imap = await startImapServer({ starttls: true });
  const smtp = await startSmtpServer({ starttls: true });
  try {
    await probeServer("admin", { side: "imap", host: "127.0.0.1", port: imap.port, security: "starttls", username: "" }, tls);
    await probeServer("admin", { side: "smtp", host: "127.0.0.1", port: smtp.port, security: "starttls", username: "" }, tls);
    await assert.rejects(
      probeServer("nobody", { side: "imap", host: "127.0.0.1", port: imap.port, security: "starttls", username: "" }, tls),
      /Only admins/i,
    );
  } finally {
    await imap.close();
    await smtp.close();
  }
});

test("verifyAccount checks both IMAP and SMTP", async () => {
  const imap = await startImapServer();
  const smtp = await startSmtpServer();
  try {
    const result = await verifyAccount(secrets("verify", imap.port, smtp.port), { tls });
    assert.equal(result.folders, 2);
  } finally {
    await imap.close();
    await smtp.close();
  }
});
