import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-email-discover-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "email-discover-test-secret-only-not-for-production";
const { db } = await import("../db.js");
const { assertEmailHost } = await import("./accounts.js");
const {
  discoverEmail,
  fetchBounded,
  heuristicCandidates,
  parseAutoconfigXml,
  parseAutodiscoverJson,
  parseAutodiscoverXml,
  presetFor,
  srvServers,
} = await import("./discover.js");

db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("admin", "admin@example.test", "Admin", "unused", "admin", Date.now());
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1" xmlns="urn:example:autoconfig">
  <emailProvider id="example.test">
    <domain>example.test</domain>
    <incomingServer type="imap">
      <hostname>imap.%EMAILDOMAIN%</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILLOCALPART%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.test</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

test("known providers are first, with their real servers and the Proton Bridge explanation", () => {
  assert.deepEqual(presetFor("someone@gmail.com"), {
    imap: { host: "imap.gmail.com", port: 993, security: "tls", username: "someone@gmail.com" },
    smtp: { host: "smtp.gmail.com", port: 465, security: "tls", username: "someone@gmail.com" },
    source: "Gmail",
    confidence: "high",
    notes: ["Gmail needs an app password when two-step verification is on. OAuth sign-in is not available yet."],
  });
  assert.equal(presetFor("someone@googlemail.com")?.source, "Gmail");
  assert.equal(presetFor("someone@outlook.com")?.imap.host, "outlook.office365.com");
  assert.equal(presetFor("someone@hotmail.com")?.smtp.host, "smtp-mail.outlook.com");
  assert.equal(presetFor("someone@icloud.com")?.imap.host, "imap.mail.me.com");
  assert.equal(presetFor("someone@me.com")?.smtp.port, 587);
  assert.equal(presetFor("someone@yahoo.co.uk")?.imap.host, "imap.mail.yahoo.com");
  assert.equal(presetFor("someone@fastmail.com")?.smtp.host, "smtp.fastmail.com");
  assert.equal(presetFor("someone@gmx.net")?.imap.host, "imap.gmx.net");
  assert.equal(presetFor("someone@proton.me"), "bridge");
  assert.equal(presetFor("someone@unknown.test"), null);
});

test("Thunderbird autoconfig XML handles namespaces, substitutions, SSL, and STARTTLS", () => {
  const parsed = parseAutoconfigXml(XML, "alice@example.test");
  assert.deepEqual(parsed.imap, { host: "imap.example.test", port: 993, security: "tls", username: "alice" });
  assert.deepEqual(parsed.smtp, { host: "smtp.example.test", port: 587, security: "starttls", username: "alice@example.test" });
});

test("autoconfig without a usable socket type or with OAuth only is not a false success", () => {
  const xml = `<clientConfig><emailProvider><incomingServer type="imap">
    <hostname>imap.example.test</hostname><port>993</port><socketType>plain</socketType>
    <authentication>OAuth2</authentication></incomingServer></emailProvider></clientConfig>`;
  const parsed = parseAutoconfigXml(xml, "alice@example.test");
  assert.equal(parsed.imap, null);
  assert.ok(parsed.notes.some((note) => /OAuth/i.test(note)));
});

test("Microsoft Autodiscover XML and nested JSON are parsed", () => {
  const xml = `<?xml version="1.0"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
    <Response><Account><Protocol>
      <Type>IMAP</Type><Server>mail.example.test</Server><Port>993</Port><SSL>on</SSL><LoginName>%EMAILADDRESS%</LoginName>
    </Protocol><Protocol>
      <Type>SMTP</Type><Server>mail.example.test</Server><Port>587</Port><SSL>off</SSL><LoginName>%EMAILADDRESS%</LoginName>
    </Protocol></Account></Response></Autodiscover>`;
  const parsed = parseAutodiscoverXml(xml, "alice@example.test");
  assert.deepEqual(parsed.imap, { host: "mail.example.test", port: 993, security: "tls", username: "alice@example.test" });
  assert.deepEqual(parsed.smtp, { host: "mail.example.test", port: 587, security: "starttls", username: "alice@example.test" });

  const json = parseAutodiscoverJson({ Response: { Account: { Protocol: { Protocol: "IMAP", Server: "json.example.test", Port: 993, SSL: true, Username: "%EMAILADDRESS%" } } } }, "alice@example.test");
  assert.deepEqual(json.imap, { host: "json.example.test", port: 993, security: "tls", username: "alice@example.test" });
  assert.equal(json.smtp, null);
});

test("RFC 6186 SRV answers prefer secure records and keep their ports", () => {
  const servers = srvServers({
    imaps: [{ name: "imap-primary.example.test.", port: 993, priority: 10, weight: 5 }],
    imap: [{ name: "imap-old.example.test.", port: 143, priority: 20, weight: 1 }],
    submissions: [{ name: "smtp.example.test.", port: 465, priority: 10, weight: 1 }],
    submission: [{ name: "smtp-old.example.test.", port: 587, priority: 30, weight: 1 }],
  }, "alice@example.test");
  assert.equal(servers.imap[0]?.host, "imap-primary.example.test");
  assert.equal(servers.imap[0]?.security, "tls");
  assert.equal(servers.imap[1]?.host, "imap-old.example.test");
  assert.equal(servers.imap[1]?.security, "starttls");
  assert.equal(servers.smtp[0]?.port, 465);
  assert.equal(servers.smtp[1]?.port, 587);

  const ordered = srvServers({
    imaps: [
      { name: "low.example.test.", port: 993, priority: 20, weight: 1 },
      { name: "high.example.test.", port: 993, priority: 10, weight: 1 },
    ],
    imap: [],
    submissions: [],
    submission: [],
  }, "alice@example.test");
  assert.deepEqual(ordered.imap.map((server) => server.host), ["high.example.test", "low.example.test"]);
});

test("hostname heuristics are exactly the brief's order", () => {
  assert.deepEqual(heuristicCandidates("example.test").map((candidate) => `${candidate.side} ${candidate.host}:${candidate.port} ${candidate.security}`), [
    "imap imap.example.test:993 tls",
    "imap mail.example.test:993 tls",
    "imap imap.example.test:143 starttls",
    "smtp smtp.example.test:465 tls",
    "smtp smtp.example.test:587 starttls",
    "smtp mail.example.test:465 tls",
  ]);
});

test("a preset discovery returns high confidence and does not guess over it", async () => {
  const result = await discoverEmail({ userId: "admin", email: "someone@gmail.com" });
  assert.equal(result.source, "Gmail");
  assert.equal(result.confidence, "high");
  assert.equal(result.imap?.host, "imap.gmail.com");
  assert.equal(result.smtp?.host, "smtp.gmail.com");
  assert.ok(result.attempts.some((attempt) => attempt.stage === "preset" && attempt.status === "ok"));
  assert.ok(result.notes.some((note) => /app password/i.test(note)));
  // Later stages are skipped because both sides are already known.
  assert.equal(result.attempts.some((attempt) => attempt.stage === "heuristic" && attempt.status === "running"), false);
});

test("Proton explains the Bridge instead of pretending IMAP works", async () => {
  const result = await discoverEmail({ userId: "admin", email: "someone@proton.me" });
  assert.equal(result.needsBridge, true);
  assert.equal(result.imap, null);
  assert.equal(result.smtp, null);
  assert.ok(result.notes.some((note) => /Bridge/i.test(note)));
});

test("discovered hosts are refused for non-admins when private", async () => {
  await assert.rejects(assertEmailHost("nobody", "127.0.0.1"), /Only admins/i);
  await assertEmailHost("admin", "127.0.0.1");
});

test("discovery documents refuse an HTTPS downgrade and stop after bounded redirects", async (t: TestContext) => {
  await assert.rejects(fetchBounded("admin", "http://autoconfig.example.test/config.xml", {}, 1024), /must use HTTPS/i);
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 302, headers: { location: "http://insecure.example.test/config.xml" } }));
  await assert.rejects(fetchBounded("admin", "https://autoconfig.example.test/config.xml", {}, 1024), /insecure address/i);

  let hop = 0;
  t.mock.method(globalThis, "fetch", async () => {
    hop += 1;
    return new Response(null, { status: 302, headers: { location: `https://autoconfig.example.test/hop-${hop}.xml` } });
  });
  await assert.rejects(fetchBounded("admin", "https://autoconfig.example.test/start.xml", {}, 1024), /redirected too many times/i);
  assert.equal(hop, 5, "the initial request plus four redirects");

  t.mock.method(globalThis, "fetch", async () => new Response("<clientConfig/>", { status: 200, headers: { "content-type": "application/xml" } }));
  const bytes = await fetchBounded("admin", "https://autoconfig.example.test/final.xml", {}, 1024);
  assert.match(new TextDecoder().decode(bytes), /clientConfig/);
});
