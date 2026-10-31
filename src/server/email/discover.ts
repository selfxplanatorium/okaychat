import dns from "node:dns/promises";
import net from "node:net";
import { isIP } from "node:net";
import tls, { type ConnectionOptions } from "node:tls";
import { DOMParser, type Document as XmlDocument, type Element as XmlElement } from "@xmldom/xmldom";
import type {
  EmailConfidence,
  EmailDiscoveryAttempt,
  EmailDiscoveryResult,
  EmailDiscoveryServer,
  EmailSecurity,
} from "../../shared/email.js";
import { publicFetch, readCapped } from "../public-fetch.js";
import { canUsePrivateHosts, emailLookup, assertEmailHost } from "./accounts.js";
import { EmailError, mapEmailError } from "./errors.js";

// Ordered server discovery. Each stage fills whichever side (IMAP/SMTP) is still missing; the first
// result wins, so a known provider or a published autoconfig document is never overridden by a
// guess. Every stage reports a short progress line, and the caller gets editable servers, never a
// black box. See docs/implementation/email.md#discovery.

const HTTP_TIMEOUT = 8_000;
const PROBE_TIMEOUT = 6_000;
const MAX_XML_BYTES = 512 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_LINE = 4_000;
const MAX_QUEUED_LINES = 40;
const MAX_HTTP_REDIRECTS = 4;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

type Side = "imap" | "smtp";
type Security = EmailSecurity;

interface Found {
  server: EmailDiscoveryServer;
  source: string;
  confidence: EmailConfidence;
}

export interface Preset {
  imap: EmailDiscoveryServer;
  smtp: EmailDiscoveryServer;
  source: string;
  confidence: EmailConfidence;
  notes?: string[];
}

function normalizeEmail(email: string): { email: string; local: string; domain: string } | null {
  const value = email.trim().toLowerCase();
  const match = /^([^\s@<>]{1,64})@([a-z0-9.-]{1,253})$/.exec(value);
  if (!match || match[2]!.startsWith(".") || match[2]!.endsWith(".")) return null;
  return { email: value, local: match[1]!, domain: match[2]! };
}

const host = (value: string | undefined | null): string | null => {
  const cleaned = (value ?? "").trim().replace(/\.$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!cleaned || cleaned.length > 253 || /[\s\r\n\0/\\@]/.test(cleaned)) return null;
  if (isIP(cleaned)) return cleaned;
  if (!/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i.test(cleaned) || !cleaned.includes(".")) return null;
  return cleaned;
};

const port = (value: unknown, fallback: number): number => {
  const number = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(number) && number > 0 && number <= 65535 ? number : fallback;
};

function substitute(template: string | undefined, email: { email: string; local: string; domain: string }): string {
  return (template ?? "")
    .replaceAll("%EMAILADDRESS%", email.email)
    .replaceAll("%EMAILLOCALPART%", email.local)
    .replaceAll("%EMAILDOMAIN%", email.domain)
    .replaceAll("%REALNAME%", email.local)
    .replace(/[\r\n\0]/g, "")
    .trim();
}

function securityOf(socketType: string | undefined): Security | null {
  const value = (socketType ?? "").trim().toLowerCase();
  if (value === "ssl" || value === "tls") return "tls";
  if (value === "starttls") return "starttls";
  return null;
}

function serverOf(input: { host: string | null; port: unknown; security: Security | null; username: string; defaultPort: number }): EmailDiscoveryServer | null {
  if (!input.host || !input.security) return null;
  return { host: input.host, port: port(input.port, input.defaultPort), security: input.security, username: input.username.slice(0, 320) };
}

// ---------------------------------------------------------------------------
// Known providers
// ---------------------------------------------------------------------------

export function presetFor(rawEmail: string): Preset | "bridge" | null {
  const email = normalizeEmail(rawEmail);
  if (!email) return null;
  const { domain, email: address } = email;
  const server = (h: string, p: number, security: Security): EmailDiscoveryServer => ({ host: h, port: p, security, username: address });
  const preset = (imap: EmailDiscoveryServer, smtp: EmailDiscoveryServer, source: string, notes?: string[]): Preset => ({ imap, smtp, source, confidence: "high", notes });
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return preset(server("imap.gmail.com", 993, "tls"), server("smtp.gmail.com", 465, "tls"), "Gmail", [
      "Gmail needs an app password when two-step verification is on. OAuth sign-in is not available yet.",
    ]);
  }
  if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(domain)) {
    return preset(server("outlook.office365.com", 993, "tls"), server("smtp-mail.outlook.com", 587, "starttls"), "Outlook.com", [
      "Microsoft may require an app password when two-step verification is on. OAuth sign-in is not available yet.",
    ]);
  }
  if (domain === "icloud.com" || domain === "me.com") {
    return preset(server("imap.mail.me.com", 993, "tls"), server("smtp.mail.me.com", 587, "starttls"), "iCloud Mail", [
      "iCloud needs an app-specific password created at appleid.apple.com.",
    ]);
  }
  if (domain.startsWith("yahoo.")) {
    return preset(server("imap.mail.yahoo.com", 993, "tls"), server("smtp.mail.yahoo.com", 465, "tls"), "Yahoo Mail", [
      "Yahoo needs an app password from Account Security.",
    ]);
  }
  if (domain === "fastmail.com" || domain === "fastmail.fm") {
    return preset(server("imap.fastmail.com", 993, "tls"), server("smtp.fastmail.com", 465, "tls"), "Fastmail", [
      "Fastmail needs an app password with IMAP and SMTP access.",
    ]);
  }
  if (domain.startsWith("gmx.")) {
    return preset(server("imap.gmx.net", 993, "tls"), server("mail.gmx.net", 587, "starttls"), "GMX");
  }
  if (domain === "proton.me" || domain === "protonmail.com" || domain === "pm.me") {
    return "bridge";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Autoconfig XML (Thunderbird and Microsoft)
// ---------------------------------------------------------------------------

function localName(node: { localName?: string | null; nodeName: string }): string {
  return (node.localName || node.nodeName || "").toLowerCase();
}

function elements(doc: XmlDocument | XmlElement, name: string): XmlElement[] {
  const wanted = name.toLowerCase();
  const out: XmlElement[] = [];
  const visit = (node: Node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      const element = child as unknown as XmlElement;
      if (localName(element) === wanted) out.push(element);
      visit(child);
    }
  };
  visit(doc as unknown as Node);
  return out;
}

function childText(parent: XmlElement | undefined, name: string): string | undefined {
  if (!parent) return undefined;
  const found = elements(parent, name)[0];
  return found?.textContent?.trim() || undefined;
}

function parseXml(text: string): XmlDocument {
  const problems: string[] = [];
  const doc = new DOMParser({
    onError(level, message) {
      if (level !== "warning") problems.push(String(message));
    },
  }).parseFromString(text, "text/xml");
  if (problems.length || !doc.documentElement) throw new Error("The autoconfig document is not valid XML.");
  return doc;
}

export interface AutoconfigResult {
  imap: EmailDiscoveryServer | null;
  smtp: EmailDiscoveryServer | null;
  notes: string[];
}

/** Thunderbird `mail/config-v1.1.xml`, including namespaced documents and username substitutions. */
export function parseAutoconfigXml(xml: string, rawEmail: string): AutoconfigResult {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error("Enter a valid email address.");
  const doc = parseXml(xml);
  const provider = elements(doc, "emailProvider")[0];
  if (!provider) throw new Error("The autoconfig document has no email provider.");
  const notes: string[] = [];
  const pick = (tag: "incomingServer" | "outgoingServer", type: Side, defaultPort: number): EmailDiscoveryServer | null => {
    const nodes = elements(provider, tag).filter((node) => (node.getAttribute("type") ?? "").toLowerCase() === type);
    for (const node of nodes) {
      const authentication = (childText(node, "authentication") ?? "").toLowerCase();
      if (authentication.includes("oauth") && !authentication.includes("password")) {
        notes.push("This provider's published configuration only offers OAuth, which is not available yet. Use an app password with manual settings.");
        continue;
      }
      const server = serverOf({
        host: host(substitute(childText(node, "hostname"), email)),
        port: childText(node, "port"),
        security: securityOf(childText(node, "socketType")),
        username: substitute(childText(node, "username"), email) || email.email,
        defaultPort,
      });
      if (server) return server;
    }
    return null;
  };
  return {
    imap: pick("incomingServer", "imap", 993),
    smtp: pick("outgoingServer", "smtp", 587),
    notes,
  };
}

/** Microsoft Autodiscover XML (`<Protocol><Type>IMAP</Type>...`). */
export function parseAutodiscoverXml(xml: string, rawEmail: string): AutoconfigResult {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error("Enter a valid email address.");
  const doc = parseXml(xml);
  const notes: string[] = [];
  let imap: EmailDiscoveryServer | null = null;
  let smtp: EmailDiscoveryServer | null = null;
  for (const protocol of elements(doc, "Protocol")) {
    const type = (childText(protocol, "Type") ?? "").toLowerCase();
    if (type !== "imap" && type !== "smtp") continue;
    const ssl = (childText(protocol, "SSL") ?? "").toLowerCase();
    const encryption = (childText(protocol, "Encryption") ?? "").toLowerCase();
    const security: Security | null = ssl === "on" || ssl === "true" || encryption.includes("ssl") ? "tls" : ssl === "off" || ssl === "false" ? "starttls" : null;
    if (!security) continue;
    const server = serverOf({
      host: host(childText(protocol, "Server")),
      port: childText(protocol, "Port"),
      security,
      username: substitute(childText(protocol, "LoginName"), email) || email.email,
      defaultPort: type === "imap" ? 993 : 587,
    });
    if (!server) continue;
    if (type === "imap" && !imap) imap = server;
    if (type === "smtp" && !smtp) smtp = server;
  }
  if (!imap && !smtp) notes.push("The Autodiscover response did not include password-based IMAP or SMTP settings.");
  return { imap, smtp, notes };
}

/** The JSON Autodiscover response, which may wrap the protocol object. */
export function parseAutodiscoverJson(json: unknown, rawEmail: string): AutoconfigResult {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error("Enter a valid email address.");
  const result: AutoconfigResult = { imap: null, smtp: null, notes: [] };
  const visited = new Set<unknown>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    const record = value as Record<string, unknown>;
    const type = String(record.Protocol ?? record.protocol ?? record.Type ?? record.type ?? "").toLowerCase();
    if ((type === "imap" || type === "smtp") && (record.Server ?? record.server)) {
      const ssl = String(record.SSL ?? record.ssl ?? record.Encryption ?? "").toLowerCase();
      const numericPort = port(record.Port ?? record.port, type === "imap" ? 993 : 587);
      const security: Security | null = ssl === "on" || ssl === "true" || ssl.includes("ssl") ? "tls" : ssl === "off" || ssl === "false" ? "starttls" : numericPort === 993 || numericPort === 465 ? "tls" : "starttls";
      const server = serverOf({
        host: host(String(record.Server ?? record.server ?? "")),
        port: numericPort,
        security,
        username: substitute(String(record.Username ?? record.LoginName ?? record.username ?? ""), email) || email.email,
        defaultPort: type === "imap" ? 993 : 587,
      });
      if (server && type === "imap" && !result.imap) result.imap = server;
      if (server && type === "smtp" && !result.smtp) result.smtp = server;
      return;
    }
    for (const entry of Object.values(record)) walk(entry);
  };
  walk(json);
  if (!result.imap && !result.smtp) result.notes.push("The Autodiscover response did not include password-based IMAP or SMTP settings.");
  return result;
}

// ---------------------------------------------------------------------------
// RFC 6186 SRV
// ---------------------------------------------------------------------------

export interface SrvRecord {
  name: string;
  port: number;
  priority: number;
  weight: number;
}

export function srvServers(records: { imaps: SrvRecord[]; imap: SrvRecord[]; submissions: SrvRecord[]; submission: SrvRecord[] }, rawEmail: string): { imap: EmailDiscoveryServer[]; smtp: EmailDiscoveryServer[] } {
  const email = normalizeEmail(rawEmail);
  if (!email) return { imap: [], smtp: [] };
  // Lower priority wins; higher weight wins within a priority (RFC 2782 order is close enough for a first try).
  const order = (records: SrvRecord[]) => [...records].sort((a, b) => a.priority - b.priority || b.weight - a.weight);
  const make = (record: SrvRecord, security: Security, side: Side): EmailDiscoveryServer | null => {
    const target = host(record.name);
    const fallback = side === "imap" ? (security === "tls" ? 993 : 143) : security === "tls" ? 465 : 587;
    return target ? { host: target, port: port(record.port, fallback), security, username: email.email } : null;
  };
  return {
    imap: [...order(records.imaps).map((record) => make(record, "tls", "imap")), ...order(records.imap).map((record) => make(record, "starttls", "imap"))].filter((value): value is EmailDiscoveryServer => !!value),
    smtp: [...order(records.submissions).map((record) => make(record, "tls", "smtp")), ...order(records.submission).map((record) => make(record, "starttls", "smtp"))].filter((value): value is EmailDiscoveryServer => !!value),
  };
}

async function resolveSrvOrEmpty(name: string, signal?: AbortSignal): Promise<SrvRecord[]> {
  if (signal?.aborted) throw abortReason(signal);
  try {
    return await new Promise<SrvRecord[]>((resolve, reject) => {
      const onAbort = () => reject(abortReason(signal!));
      signal?.addEventListener("abort", onAbort, { once: true });
      dns.resolveSrv(name).then(
        (records) => { signal?.removeEventListener("abort", onAbort); resolve(records.map((record) => ({ name: record.name, port: record.port, priority: record.priority, weight: record.weight }))); },
        () => { signal?.removeEventListener("abort", onAbort); resolve([]); },
      );
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return [];
  }
}

// ---------------------------------------------------------------------------
// Hostname heuristics and real TLS probes
// ---------------------------------------------------------------------------

export interface ProbeCandidate extends EmailDiscoveryServer {
  side: Side;
}

/** Exactly the hostnames the brief lists, in the order they are tried. */
export function heuristicCandidates(domain: string): ProbeCandidate[] {
  return [
    { side: "imap", host: `imap.${domain}`, port: 993, security: "tls", username: "" },
    { side: "imap", host: `mail.${domain}`, port: 993, security: "tls", username: "" },
    { side: "imap", host: `imap.${domain}`, port: 143, security: "starttls", username: "" },
    { side: "smtp", host: `smtp.${domain}`, port: 465, security: "tls", username: "" },
    { side: "smtp", host: `smtp.${domain}`, port: 587, security: "starttls", username: "" },
    { side: "smtp", host: `mail.${domain}`, port: 465, security: "tls", username: "" },
  ];
}

class LineReader {
  private buffer = "";
  private lines: string[] = [];
  private waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  private error: Error | null = null;
  constructor(private readonly socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.pump();
      // Only a partial line (no newline yet) is bounded here; complete lines were consumed above.
      if (!this.error && this.buffer.length > MAX_LINE) this.fail(new Error("The server sent an oversized response line."));
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("The connection closed early.")));
  }
  private fail(error: Error): void {
    if (this.error) return;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
  private pump(): void {
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > MAX_LINE) {
        this.fail(new Error("The server sent an oversized response line."));
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
      else if (this.lines.length >= MAX_QUEUED_LINES) {
        // A server can otherwise flood lines faster than a probe reads them.
        this.fail(new Error("The server sent too many response lines."));
        return;
      } else this.lines.push(line);
    }
  }
  read(): Promise<string> {
    const buffered = this.lines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("The mail server probe was cancelled.");
}

/** Reads one line, but rejects as soon as the caller's deadline or request signal aborts. */
function readLine(reader: LineReader, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (line) => { signal.removeEventListener("abort", onAbort); resolve(line); },
      (error: Error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/** A DNS/guard helper cannot cancel its resolver, but a probe must stop waiting on it. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/**
 * One deadline for the whole probe: DNS/connect, greeting, EHLO, STARTTLS, and the TLS handshake.
 * Without it a server that accepts a socket and then never writes keeps the discovery wizard waiting
 * forever. The caller's request signal is forwarded too.
 */
async function withProbeDeadline<T>(run: (signal: AbortSignal) => Promise<T>, external?: AbortSignal, ms = PROBE_TIMEOUT): Promise<T> {
  if (external?.aborted) throw abortReason(external);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("The mail server probe timed out.")), ms);
  const forward = () => controller.abort(abortReason(external!));
  external?.addEventListener("abort", forward, { once: true });
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", forward);
  }
}

function guardedLookup(userId: string) {
  return emailLookup(userId);
}

async function secureSocket(userId: string, candidate: ProbeCandidate, signal: AbortSignal, tlsOptions?: ConnectionOptions): Promise<tls.TLSSocket> {
  await abortable(assertEmailHost(userId, candidate.host), signal);
  if (signal.aborted) throw abortReason(signal);
  const lookup = guardedLookup(userId) as ConnectionOptions["lookup"];
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const attempt = tls.connect({
      host: candidate.host,
      port: candidate.port,
      servername: isIP(candidate.host) ? undefined : candidate.host,
      rejectUnauthorized: true,
      lookup,
      ...tlsOptions,
    });
    let onAbort: () => void = () => {};
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const fail = (error: Error) => { cleanup(); attempt.destroy(); reject(error); };
    onAbort = () => fail(abortReason(signal));
    attempt.once("secureConnect", () => { cleanup(); attempt.off("error", fail); resolve(attempt); });
    attempt.once("error", fail);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function plainSocket(userId: string, candidate: ProbeCandidate, signal: AbortSignal): Promise<net.Socket> {
  await abortable(assertEmailHost(userId, candidate.host), signal);
  if (signal.aborted) throw abortReason(signal);
  const lookup = guardedLookup(userId);
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection({ host: candidate.host, port: candidate.port, lookup } as unknown as net.NetConnectOpts);
    let onAbort: () => void = () => {};
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const fail = (error: Error) => { cleanup(); socket.destroy(); reject(error); };
    onAbort = () => fail(abortReason(signal));
    socket.once("connect", () => { cleanup(); socket.off("error", fail); resolve(socket); });
    socket.once("error", fail);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function upgrade(socket: net.Socket, candidate: ProbeCandidate, signal: AbortSignal, tlsOptions?: ConnectionOptions): Promise<tls.TLSSocket> {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const upgraded = tls.connect({
      socket,
      servername: isIP(candidate.host) ? undefined : candidate.host,
      rejectUnauthorized: true,
      ...tlsOptions,
    });
    let onAbort: () => void = () => {};
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const fail = (error: Error) => { cleanup(); upgraded.destroy(); reject(error); };
    onAbort = () => fail(abortReason(signal));
    upgraded.once("secureConnect", () => { cleanup(); upgraded.off("error", fail); resolve(upgraded); });
    upgraded.once("error", fail);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function probeImapTls(userId: string, candidate: ProbeCandidate, signal: AbortSignal, tlsOptions?: ConnectionOptions): Promise<void> {
  const socket = await secureSocket(userId, candidate, signal, tlsOptions);
  try {
    const reader = new LineReader(socket);
    const greeting = await readLine(reader, signal);
    if (!/^\*\s+(OK|PREAUTH)/i.test(greeting)) throw new EmailError("protocol", "The server did not answer as an IMAP server.");
  } finally {
    socket.destroy();
  }
}

async function probeSmtpTls(userId: string, candidate: ProbeCandidate, signal: AbortSignal, tlsOptions?: ConnectionOptions): Promise<void> {
  const socket = await secureSocket(userId, candidate, signal, tlsOptions);
  try {
    const reader = new LineReader(socket);
    const greeting = await readLine(reader, signal);
    if (!/^220[\s-]/.test(greeting)) throw new EmailError("protocol", "The server did not answer as an SMTP server.");
  } finally {
    socket.destroy();
  }
}

async function probeImapStartTls(userId: string, candidate: ProbeCandidate, signal: AbortSignal, tlsOptions?: ConnectionOptions): Promise<void> {
  const socket = await plainSocket(userId, candidate, signal);
  let upgraded: tls.TLSSocket | null = null;
  try {
    const reader = new LineReader(socket);
    const greeting = await readLine(reader, signal);
    if (!/^\*\s+OK/i.test(greeting)) throw new EmailError("protocol", "The server did not answer as an IMAP server.");
    socket.write("a1 STARTTLS\r\n");
    for (;;) {
      const line = await readLine(reader, signal);
      if (/^a1\s+(OK|BAD|NO)/i.test(line)) {
        if (!/^a1\s+OK/i.test(line)) throw new EmailError("protocol", "The IMAP server refused STARTTLS; refusing to sign in without encryption.");
        break;
      }
    }
    upgraded = await upgrade(socket, candidate, signal, tlsOptions);
    // A successful verified handshake is enough; no credentials are sent during discovery.
  } finally {
    (upgraded ?? socket).destroy();
  }
}

async function probeSmtpStartTls(userId: string, candidate: ProbeCandidate, signal: AbortSignal, tlsOptions?: ConnectionOptions): Promise<void> {
  const socket = await plainSocket(userId, candidate, signal);
  let upgraded: tls.TLSSocket | null = null;
  try {
    const reader = new LineReader(socket);
    const greeting = await readLine(reader, signal);
    if (!/^220[\s-]/.test(greeting)) throw new EmailError("protocol", "The server did not answer as an SMTP server.");
    socket.write("EHLO okaychat.local\r\n");
    let offersTls = false;
    for (;;) {
      const line = await readLine(reader, signal);
      if (/^250[\s-]/i.test(line) && /STARTTLS/i.test(line)) offersTls = true;
      if (/^250\s/.test(line)) break;
      if (!/^250-/i.test(line)) throw new EmailError("protocol", "The SMTP server did not answer EHLO.");
    }
    if (!offersTls) throw new EmailError("protocol", "The SMTP server does not offer STARTTLS; refusing to sign in without encryption.");
    socket.write("STARTTLS\r\n");
    const ready = await readLine(reader, signal);
    if (!/^220[\s-]/.test(ready)) throw new EmailError("protocol", "The SMTP server refused STARTTLS; refusing to sign in without encryption.");
    upgraded = await upgrade(socket, candidate, signal, tlsOptions);
  } finally {
    (upgraded ?? socket).destroy();
  }
}

export async function probeServer(
  userId: string,
  candidate: ProbeCandidate,
  tlsOptions?: ConnectionOptions,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  try {
    await withProbeDeadline(async (signal) => {
      if (candidate.side === "imap") {
        if (candidate.security === "tls") await probeImapTls(userId, candidate, signal, tlsOptions);
        else await probeImapStartTls(userId, candidate, signal, tlsOptions);
      } else if (candidate.security === "tls") {
        await probeSmtpTls(userId, candidate, signal, tlsOptions);
      } else {
        await probeSmtpStartTls(userId, candidate, signal, tlsOptions);
      }
    }, opts.signal, opts.timeoutMs ?? PROBE_TIMEOUT);
  } catch (error) {
    throw mapEmailError(error, candidate.side === "imap" ? "IMAP server" : "SMTP server");
  }
}

/** Unauthenticated plaintext banner check, only when the user opted in to insecure probing. */
async function plainBanner(userId: string, candidate: ProbeCandidate, external?: AbortSignal): Promise<boolean> {
  const holder: { socket: net.Socket | null } = { socket: null };
  try {
    return await withProbeDeadline(async (signal) => {
      holder.socket = await plainSocket(userId, candidate, signal);
      const reader = new LineReader(holder.socket);
      const greeting = await readLine(reader, signal);
      return candidate.side === "imap" ? /^\*\s+(OK|PREAUTH)/i.test(greeting) : /^220[\s-]/.test(greeting);
    }, external);
  } catch {
    return false;
  } finally {
    holder.socket?.destroy();
  }
}

// ---------------------------------------------------------------------------
// HTTP discovery documents
// ---------------------------------------------------------------------------

/** Exported for tests: every hop is bounded, and TLS can never be downgraded. */
export async function fetchBounded(userId: string, url: string, init: RequestInit, max: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (new URL(url).protocol !== "https:") throw new Error("Discovery documents must use HTTPS.");
  const request = canUsePrivateHosts(userId) ? fetch : publicFetch;
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(HTTP_TIMEOUT)]) : AbortSignal.timeout(HTTP_TIMEOUT);
  let target = url;
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers);
  for (let hop = 0; hop <= MAX_HTTP_REDIRECTS; hop++) {
    const response = await request(target, { ...init, method, body, headers, signal: combined, redirect: "manual" });
    if (!REDIRECT_STATUS.has(response.status)) {
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      return readCapped(response, max, "The discovery document is larger than the limit.");
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("The discovery document redirected without a location.");
    if (hop === MAX_HTTP_REDIRECTS) throw new Error("The discovery document redirected too many times.");
    const next = new URL(location, target);
    // TLS downgrade would let a network attacker rewrite server settings and steal credentials.
    if (next.protocol !== "https:") throw new Error("The discovery document redirected to an insecure address.");
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers.delete("content-type");
      headers.delete("content-length");
    }
    target = next.href;
  }
  throw new Error("The discovery document redirected too many times.");
}

const THUNDERBIRD_URLS = (domain: string, email: string) => [
  `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
  `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
  `https://autoconfig.thunderbird.net/v1.1/${domain}`,
];

function autodiscoverXmlBody(email: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">
  <Request>
    <EMailAddress>${email.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</EMailAddress>
    <AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema>
  </Request>
</Autodiscover>`;
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

export interface DiscoveryOptions {
  userId: string;
  email: string;
  allowInsecureProbe?: boolean;
  signal?: AbortSignal;
  /** Receives every short progress line as it happens. */
  onAttempt?: (attempt: EmailDiscoveryAttempt) => void;
  /** Test seam for TLS certificates; the app never passes this. */
  tls?: ConnectionOptions;
  /** Test seam for the total per-probe deadline. */
  probeTimeout?: number;
}

export async function discoverEmail(opts: DiscoveryOptions): Promise<EmailDiscoveryResult> {
  const email = normalizeEmail(opts.email);
  if (!email) throw new EmailError("protocol", "Enter a valid email address.");
  const attempts: EmailDiscoveryAttempt[] = [];
  const notes: string[] = [];
  const found: { imap: Found | null; smtp: Found | null } = { imap: null, smtp: null };
  const report = (attempt: EmailDiscoveryAttempt) => {
    attempts.push(attempt);
    opts.onAttempt?.(attempt);
  };
  const both = () => !!found.imap && !!found.smtp;
  const consider = async (side: Side, server: EmailDiscoveryServer | null | undefined, source: string, confidence: EmailConfidence, detail?: string) => {
    if (!server) return false;
    // Check the destination before accepting it: an accepted private or unresolvable candidate would
    // otherwise end the chain early and leave nothing once it is dropped at the end.
    try {
      await assertEmailHost(opts.userId, server.host);
    } catch (error) {
      report({ stage: "probe", status: "failed", label: `${side === "imap" ? "IMAP" : "SMTP"} ${server.host}:${server.port}`, detail: `${source}: ${(error as Error).message}` });
      return false;
    }
    if (side === "imap" && !found.imap) found.imap = { server, source, confidence };
    if (side === "smtp" && !found.smtp) found.smtp = { server, source, confidence };
    report({ stage: "probe", status: "ok", label: `${side === "imap" ? "IMAP" : "SMTP"} ${server.host}:${server.port}`, detail: detail ?? `${source} configuration`, confidence });
    return true;
  };
  const mergeConfig = async (stage: "thunderbird" | "microsoft", source: string, result: AutoconfigResult) => {
    for (const note of result.notes) if (!notes.includes(note)) notes.push(note);
    const got: string[] = [];
    if (result.imap && !found.imap && await consider("imap", result.imap, source, "medium")) got.push("IMAP");
    if (result.smtp && !found.smtp && await consider("smtp", result.smtp, source, "medium")) got.push("SMTP");
    report({
      stage,
      status: got.length ? "ok" : "skipped",
      label: source,
      detail: got.length ? `Found ${got.join(" and ")} settings.` : "No usable password-based settings.",
      ...(got.length ? { confidence: "medium" as EmailConfidence } : {}),
    });
  };

  const checkAbort = () => opts.signal?.throwIfAborted();

  // 1. Known providers.
  checkAbort();
  const preset = presetFor(email.email);
  if (preset === "bridge") {
    report({ stage: "preset", status: "ok", label: "Proton Mail", detail: "Proton needs the Proton Mail Bridge desktop app; there is no direct IMAP server.", confidence: "high" });
    notes.push(
      "Proton Mail does not offer direct IMAP or SMTP. Run Proton Mail Bridge on this server, then connect to 127.0.0.1:1143 (IMAP, STARTTLS) and 127.0.0.1:1025 (SMTP, STARTTLS) with the Bridge username and password. Only an admin can reach a local address.",
    );
    const result: EmailDiscoveryResult = { email: email.email, imap: null, smtp: null, source: "Proton Mail", confidence: "high", attempts, notes, needsBridge: true };
    return result;
  }
  if (preset) {
    for (const note of preset.notes ?? []) notes.push(note);
    report({ stage: "preset", status: "ok", label: preset.source, detail: `Known servers for ${email.domain}.`, confidence: preset.confidence });
    await consider("imap", preset.imap, preset.source, preset.confidence);
    await consider("smtp", preset.smtp, preset.source, preset.confidence);
  } else {
    report({ stage: "preset", status: "skipped", label: "Known providers", detail: "No built-in preset for this domain." });
  }

  // 2. Thunderbird autoconfig XML.
  for (const url of THUNDERBIRD_URLS(email.domain, email.email)) {
    checkAbort();
    if (both()) break;
    report({ stage: "thunderbird", status: "running", label: "Thunderbird autoconfig", detail: url });
    try {
      const bytes = await fetchBounded(opts.userId, url, { headers: { Accept: "application/xml,text/xml" } }, MAX_XML_BYTES, opts.signal);
      const parsed = parseAutoconfigXml(new TextDecoder().decode(bytes), email.email);
      await mergeConfig("thunderbird", "Thunderbird autoconfig", parsed);
    } catch (error) {
      const message = (error as Error).message || "No autoconfig document.";
      report({ stage: "thunderbird", status: "failed", label: "Thunderbird autoconfig", detail: `${url}: ${message}` });
    }
  }

  // 3. Microsoft Autodiscover: XML POST, then the JSON endpoint.
  if (!both()) {
    checkAbort();
    const base = `https://autodiscover.${email.domain}/autodiscover`;
    report({ stage: "microsoft", status: "running", label: "Microsoft Autodiscover", detail: `${base}/autodiscover.xml` });
    try {
      const bytes = await fetchBounded(opts.userId, `${base}/autodiscover.xml`, {
        method: "POST",
        headers: { "Content-Type": "text/xml; charset=utf-8", Accept: "application/xml,text/xml" },
        body: autodiscoverXmlBody(email.email),
      }, MAX_XML_BYTES, opts.signal);
      await mergeConfig("microsoft", "Microsoft Autodiscover", parseAutodiscoverXml(new TextDecoder().decode(bytes), email.email));
    } catch (error) {
      report({ stage: "microsoft", status: "failed", label: "Microsoft Autodiscover", detail: `${(error as Error).message || "No XML response."}` });
    }
  }
  if (!both()) {
    checkAbort();
    const url = `https://autodiscover.${email.domain}/autodiscover/autodiscover.json?Email=${encodeURIComponent(email.email)}&Protocol=IMAP`;
    report({ stage: "microsoft", status: "running", label: "Microsoft Autodiscover JSON", detail: url });
    try {
      const bytes = await fetchBounded(opts.userId, url, { headers: { Accept: "application/json" } }, MAX_JSON_BYTES, opts.signal);
      await mergeConfig("microsoft", "Microsoft Autodiscover JSON", parseAutodiscoverJson(JSON.parse(new TextDecoder().decode(bytes)), email.email));
    } catch (error) {
      report({ stage: "microsoft", status: "failed", label: "Microsoft Autodiscover JSON", detail: `${(error as Error).message || "No JSON response."}` });
    }
  }

  // 4. RFC 6186 SRV records.
  if (!both()) {
    checkAbort();
    report({ stage: "srv", status: "running", label: "RFC 6186 SRV records", detail: email.domain });
    try {
      const records = {
        imaps: await resolveSrvOrEmpty(`_imaps._tcp.${email.domain}`, opts.signal),
        imap: await resolveSrvOrEmpty(`_imap._tcp.${email.domain}`, opts.signal),
        submissions: await resolveSrvOrEmpty(`_submissions._tcp.${email.domain}`, opts.signal),
        submission: await resolveSrvOrEmpty(`_submission._tcp.${email.domain}`, opts.signal),
      };
      const servers = srvServers(records, email.email);
      const got: string[] = [];
      for (const server of servers.imap) if (!found.imap && await consider("imap", server, "SRV record", "medium")) { got.push("IMAP"); break; }
      for (const server of servers.smtp) if (!found.smtp && await consider("smtp", server, "SRV record", "medium")) { got.push("SMTP"); break; }
      report({ stage: "srv", status: got.length ? "ok" : "skipped", label: "RFC 6186 SRV records", detail: got.length ? `Found ${got.join(" and ")} records.` : "No SRV records published." });
    } catch (error) {
      report({ stage: "srv", status: "failed", label: "RFC 6186 SRV records", detail: (error as Error).message });
    }
  }

  // 5. Hostname guesses, verified with a real TLS/STARTTLS probe.
  if (!both()) {
    for (const candidate of heuristicCandidates(email.domain)) {
      checkAbort();
      if (candidate.side === "imap" ? !!found.imap : !!found.smtp) continue;
      report({ stage: "heuristic", status: "running", label: `${candidate.side.toUpperCase()} ${candidate.host}:${candidate.port}`, detail: candidate.security === "starttls" ? "Checking STARTTLS" : "Checking TLS" });
      try {
        await probeServer(opts.userId, candidate, opts.tls, { signal: opts.signal, timeoutMs: opts.probeTimeout });
        const { side, ...server } = candidate;
        await consider(side, { ...server, username: email.email }, "Guessed server", "low", "Server answered over verified TLS.");
      } catch (error) {
        report({ stage: "heuristic", status: "failed", label: `${candidate.side.toUpperCase()} ${candidate.host}:${candidate.port}`, detail: (error as Error).message });
      }
      if (both()) break;
    }
  }

  // Optional plaintext banner diagnostic. Never a usable result and never followed by credentials.
  if (opts.allowInsecureProbe && (!found.imap || !found.smtp)) {
    const side = !found.imap ? "imap" : "smtp";
    const diagnostic: ProbeCandidate = side === "imap"
      ? { side, host: `imap.${email.domain}`, port: 143, security: "starttls", username: email.email }
      : { side, host: `smtp.${email.domain}`, port: 587, security: "starttls", username: email.email };
    report({ stage: "probe", status: "running", label: "Unauthenticated plaintext check", detail: `${diagnostic.host}:${diagnostic.port}` });
    if (await plainBanner(opts.userId, diagnostic, opts.signal)) {
      notes.push(
        `A mail service answered in plaintext on ${diagnostic.host}:${diagnostic.port}. okaychat still requires TLS for sign-in; use a server and port with a valid certificate.`,
      );
      report({ stage: "probe", status: "ok", label: "Unauthenticated plaintext check", detail: "Service detected; TLS is still required." });
    } else {
      report({ stage: "probe", status: "failed", label: "Unauthenticated plaintext check", detail: "No service answered." });
    }
  }

  // A published document or SRV record can name a private address. Non-admins may only reach the
  // public internet, so drop such a result instead of letting it reach the Test button.
  for (const side of ["imap", "smtp"] as const) {
    const candidate = found[side];
    if (!candidate) continue;
    try {
      await assertEmailHost(opts.userId, candidate.server.host);
    } catch (error) {
      notes.push(`${side.toUpperCase()} ${candidate.server.host} was ignored: ${(error as Error).message}`);
      found[side] = null;
    }
  }
  if (!found.imap && !found.smtp) {
    notes.push("No server settings were found. Enter the IMAP and SMTP servers from your provider's help page, then test the connection.");
  } else if (!found.imap || !found.smtp) {
    notes.push(`Only ${found.imap ? "IMAP" : "SMTP"} settings were found. Fill in the other server manually before saving.`);
  }
  const confidence: EmailConfidence | null = found.imap && found.smtp
    ? (found.imap.confidence === "high" || found.smtp.confidence === "high" ? "high" : found.imap.confidence === "medium" || found.smtp.confidence === "medium" ? "medium" : "low")
    : found.imap?.confidence ?? found.smtp?.confidence ?? null;
  const result: EmailDiscoveryResult = {
    email: email.email,
    imap: found.imap?.server ?? null,
    smtp: found.smtp?.server ?? null,
    source: found.imap?.source && found.imap.source === found.smtp?.source ? found.imap.source : [found.imap?.source, found.smtp?.source].filter((value): value is string => !!value).join(" + ") || null,
    confidence,
    attempts,
    notes,
  };
  return result;
}
