import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertHeaderValue,
  buildMime,
  decodeQuotedPrintable,
  decodeTransferEncoding,
  htmlToText,
  parseMime,
  sanitizeFilename,
  sanitizeMime,
} from "./mime.js";

test("header values with CR, LF, or NUL are rejected before composition", async () => {
  assert.throws(() => assertHeaderValue("Subject", "hello\r\nBcc: attacker@example.test"), /line breaks/);
  assert.throws(() => assertHeaderValue("Subject", "hello\nworld"), /line breaks/);
  await assert.rejects(
    buildMime({ from: { address: "me@example.test" }, to: [{ address: "you@example.test" }], subject: "Hi\r\nX-Evil: 1", text: "body" }),
    /line breaks/,
  );
  await assert.rejects(
    buildMime({ from: { address: "me@example.test" }, to: [{ address: "you@example.test\r\nBcc: evil@example.test" }], subject: "Hi", text: "body" }),
    /invalid address|line breaks/,
  );
});

test("builds unicode and multipart-safe messages that parse back", async () => {
  const raw = await buildMime({
    from: { address: "bob@example.test", name: "Bøb Example" },
    to: [{ address: "alice@example.test", name: "Ålice" }],
    cc: [{ address: "carol@example.test" }],
    subject: "Réunion – résumé ✅",
    text: "Hello Ålice,\n\nCafé and 日本語.\n",
    messageId: "<fixed@example.test>",
    inReplyTo: "<earlier@example.test>",
    references: ["<earlier@example.test>"],
  });
  assert.ok(raw.byteLength > 0);
  const { parsed, text } = await parseMime(raw);
  assert.equal(parsed.subject, "Réunion – résumé ✅");
  assert.match(text, /Café and 日本語/);
  assert.equal(parsed.from?.value[0]?.address, "bob@example.test");
  assert.equal(parsed.messageId, "<fixed@example.test>");
  assert.equal(parsed.inReplyTo, "<earlier@example.test>");
});

test("quoted-printable and base64 decode bytes before charset conversion", () => {
  assert.equal(decodeQuotedPrintable("caf=C3=A9 =\r\nok").toString("utf8"), "café ok");
  const base64 = Buffer.from("Grüße 日本語", "utf8").toString("base64");
  assert.equal(decodeTransferEncoding(base64, "base64"), "Grüße 日本語");
  assert.equal(decodeTransferEncoding("caf=C3=A9", "quoted-printable"), "café");
});

test("parses a multipart message with quoted-printable and base64 attachments", async () => {
  const boundary = "mix-boundary";
  const raw = [
    "From: Alice <alice@example.test>",
    "To: Bob <bob@example.test>",
    "Subject: Multipart",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Caf=C3=A9 body",
    `--${boundary}`,
    'Content-Type: application/pdf; name="report.pdf"',
    "Content-Disposition: attachment; filename=\"report.pdf\"",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("PDFDATA").toString("base64"),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const { parsed, text } = await parseMime(raw);
  assert.match(text, /Café body/);
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0]?.filename, "report.pdf");
  assert.equal(parsed.attachments[0]?.content.toString(), "PDFDATA");
});

test("attachment names and MIME types are sanitized", () => {
  assert.equal(sanitizeFilename("../../etc/passwd"), "etc_passwd");
  assert.equal(sanitizeFilename("..\\evil.exe"), "evil.exe");
  assert.equal(sanitizeFilename("\u0000"), "attachment");
  assert.equal(sanitizeMime("Text/HTML; charset=utf-8"), "text/html");
  assert.equal(sanitizeMime("garbage"), "application/octet-stream");
  assert.equal(sanitizeMime("application/pdf"), "application/pdf");
});

test("HTML mail becomes text, keeping link targets and dropping scripts", async () => {
  const text = await htmlToText('<html><body><script>alert(1)</script><p>Hello <a href="https://example.test/a">world</a></p><style>p{}</style></body></html>');
  assert.match(text, /Hello world \(https:\/\/example\.test\/a\)/);
  assert.doesNotMatch(text, /alert/);
});
