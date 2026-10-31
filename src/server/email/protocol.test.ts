import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
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
const { downloadAttachment, encodeMessageId, listFolders, listMessages, readMessage, searchMessages, verifyAccount, attachmentsOf } = await import("./imap.js");
const { sendEmail, verifySmtp } = await import("./smtp.js");
const { probeServer } = await import("./discover.js");
const { parseMime } = await import("./mime.js");
const { mapEmailError } = await import("./errors.js");
const { db } = await import("../db.js");
db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("admin", "admin@example.test", "Admin", "unused", "admin", Date.now());

// These tests drive real node:net/node:tls mock servers. They cover TLS and STARTTLS connections,
// authentication, listing, searching, reading, attachment streaming, SMTP send, and both the
// certificate check and STARTTLS fail-closed behavior. No external network or provider is involved.

const tls = { ca: TEST_CERT };

function secrets(id: string, imapPort: number, smtpPort: number, imapSecurity: "tls" | "starttls" = "tls", smtpSecurity: "tls" | "starttls" = "tls", userId = "admin"): EmailSecrets {
  return {
    userId,
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

test("SMTP sends exactly the approved recipients and body, without appending anything", async () => {
  const smtp = await startSmtpServer();
  const config = secrets("smtp-send", 1, smtp.port);
  try {
    const body = "See you at noon.\n\n-- \nBob";
    const sent = await sendEmail(config, {
      to: [{ address: "alice@example.test", name: "Alice" }],
      cc: [{ address: "carol@example.test" }],
      subject: "Lunch",
      text: body,
    }, { tls });
    assert.equal(sent.to.length, 1);
    assert.deepEqual(sent.cc, ["carol@example.test"]);
    assert.deepEqual(sent.accepted, ["alice@example.test", "carol@example.test"]);
    const message = smtp.messages[0] ?? "";
    assert.match(message, /To: Alice <alice@example.test>/i);
    assert.match(message, /Cc: carol@example.test/i);
    assert.match(message, /See you at noon\./);
    const { text } = await parseMime(message);
    assert.equal((text.match(/-- \nBob/g) ?? []).length, 1, "the signature is sent exactly once, as reviewed");
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

test("a demoted user cannot reach a saved admin account's private host, before any connection", async () => {
  const imap = await startImapServer();
  const smtp = await startSmtpServer();
  try {
    const config = secrets("demoted", imap.port, smtp.port, "tls", "tls", "bob");
    await assert.rejects(listFolders(config, tls), (error: unknown) => error instanceof EmailError && /Only admins/i.test(error.message));
    await assert.rejects(
      sendEmail(config, { to: [{ address: "alice@example.test" }], subject: "Nope", text: "Hello" }, { tls }),
      (error: unknown) => error instanceof EmailError && /Only admins/i.test(error.message),
    );
    await assert.rejects(verifySmtp(config, tls), /Only admins/i);
    const messageId = encodeMessageId("INBOX", "42", 1);
    await assert.rejects(readMessage(config, messageId, tls), /Only admins/i, "reply/original reads are guarded");
    await assert.rejects(downloadAttachment(config, messageId, "2", undefined, tls), /Only admins/i, "attachment downloads are guarded");
    await assert.rejects(verifyAccount(config, { tls }), /Only admins/i, "the settings test is guarded");
    assert.equal(imap.connections, 0, "no IMAP socket was opened");
    assert.equal(smtp.connections, 0, "no SMTP socket was opened");
  } finally {
    await imap.close();
    await smtp.close();
  }
});

test("a non-UTF-8 text body is decoded with its declared charset", async () => {
  const server = await startImapServer({ latin1: true });
  try {
    const config = secrets("latin1", server.port, 1);
    const listed = await listMessages(config, { limit: 10 }, tls);
    const message = listed.messages.find((entry) => entry.subject === "Latin1 message");
    assert.ok(message);
    const read = await readMessage(config, message.id, tls);
    assert.equal(read.message.body, "Café au lait");
  } finally {
    await server.close();
  }
});

test("a named text part is an attachment, never the body", () => {
  const structure = {
    type: "text/plain",
    parameters: { charset: "utf-8", name: "notes.txt" },
    part: "1",
  } as never;
  const attachments = attachmentsOf(structure);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]?.filename, "notes.txt");
});

test("a probe that never receives a greeting times out and closes the socket", async () => {
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted += 1;
    socket.on("error", () => socket.destroy());
    // Deliberately silent: no greeting, no newline, no close.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const started = Date.now();
    await assert.rejects(
      probeServer("admin", { side: "imap", host: "127.0.0.1", port, security: "starttls", username: "" }, undefined, { timeoutMs: 150 }),
      /timed out|did not answer|unexpected/i,
    );
    assert.ok(Date.now() - started < 3_000, "the total probe deadline covered the silent greeting");
    assert.equal(accepted, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a probe honours the caller's abort signal", async () => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const controller = new AbortController();
  try {
    const probe = probeServer("admin", { side: "smtp", host: "127.0.0.1", port, security: "tls", username: "" }, undefined, { signal: controller.signal, timeoutMs: 5_000 });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(probe);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("SMTP authentication is actually checked, and a wrong password maps to the auth error", async () => {
  const smtp = await startSmtpServer();
  try {
    const wrong = secrets("smtp-wrong", 1, smtp.port);
    wrong.password = "not-the-password";
    await assert.rejects(
      sendEmail(wrong, { to: [{ address: "alice@example.test" }], subject: "Hi", text: "Hello" }, { tls }),
      (error: unknown) => error instanceof EmailError && error.code === "auth",
    );
    assert.ok(smtp.commands.some((command) => /^AUTH PLAIN/i.test(command)));
    assert.equal(smtp.messages.length, 0);

    const ok = secrets("smtp-ok", 1, smtp.port);
    await sendEmail(ok, { to: [{ address: "alice@example.test" }], subject: "Hi", text: "Hello" }, { tls });
    assert.equal(smtp.messages.length, 1);
  } finally {
    await smtp.close();
  }
});

test("STARTTLS refusal happens before AUTH, so credentials never cross plaintext", async () => {
  const smtp = await startSmtpServer({ starttls: true, offerTls: false });
  try {
    const config = secrets("smtp-no-auth", 1, smtp.port, "tls", "starttls");
    await assert.rejects(sendEmail(config, { to: [{ address: "alice@example.test" }], subject: "Hi", text: "Hello" }, { tls }));
    assert.equal(smtp.commands.some((command) => /^AUTH/i.test(command)), false, "no AUTH was sent before TLS");
  } finally {
    await smtp.close();
  }
});

test("error mapping names certificate, unreachable, auth, and rate limit without echoing the reply", () => {
  assert.equal(mapEmailError(Object.assign(new Error("bad"), { code: "CERT_HAS_EXPIRED" })).code, "certificate");
  assert.equal(mapEmailError(Object.assign(new Error("connect"), { code: "ECONNREFUSED" })).code, "unreachable");
  assert.equal(mapEmailError({ authenticationFailed: true, message: "LOGIN failed for secret-user" }).code, "auth");
  assert.equal(mapEmailError(new Error("421 too many requests, try again later")).code, "rate_limited");
  assert.doesNotMatch(mapEmailError({ authenticationFailed: true, message: "LOGIN failed for secret-user" }).message, /secret-user/);
});
