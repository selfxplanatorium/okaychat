import net from "node:net";
import tls from "node:tls";
import { TEST_CERT, TEST_KEY } from "./fixtures.js";

// In-process mock IMAP and SMTP servers for deterministic protocol tests. They speak enough of
// each protocol for imapflow and nodemailer, and never touch the network beyond loopback. STARTTLS
// servers upgrade in place so the clients' fail-closed behavior can be exercised.

export interface MockServer {
  port: number;
  close: () => Promise<void>;
  /** SMTP: messages received through DATA. */
  messages: string[];
}

const line = (socket: net.Socket, value: string) => socket.write(`${value}\r\n`);

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------

const ENVELOPES = {
  1: '("Tue, 02 Jan 2024 10:00:00 +0000" "Hello from Alice" (("Alice" NIL "alice" "example.test")) (("Alice" NIL "alice" "example.test")) (("Alice" NIL "alice" "example.test")) (("Bob" NIL "bob" "example.test")) NIL NIL NIL "<hello@example.test>")',
  2: '("Wed, 03 Jan 2024 11:30:00 +0000" "Report attached" (("Carol" NIL "carol" "example.test")) (("Carol" NIL "carol" "example.test")) (("Carol" NIL "carol" "example.test")) (("Bob" NIL "bob" "example.test")) NIL NIL NIL "<report@example.test>")',
} as const;

const BODY = {
  1: "First message body.",
  2: "Second message body.\r\nSee the attached report.",
} as const;

const HEADERS = {
  1: "Message-ID: <hello@example.test>\r\nIn-Reply-To: <earlier@example.test>\r\nReferences: <earlier@example.test>\r\nReply-To: Alice <alice@example.test>\r\n",
  2: "Message-ID: <report@example.test>\r\nReferences: <hello@example.test> <earlier@example.test>\r\n",
} as const;

const STRUCTURE = {
  1: '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 19 1 NIL NIL NIL NIL)',
  2: '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 42 2 NIL NIL NIL NIL)("APPLICATION" "PDF" ("NAME" "report.pdf") NIL NIL "BASE64" 12 NIL ("ATTACHMENT" ("FILENAME" "report.pdf")) NIL NIL) "MIXED" ("BOUNDARY" "b1") NIL NIL NIL)',
} as const;

const FLAGS = { 1: "\\Seen", 2: "" } as const;
const ATTACHMENT = Buffer.from("PDFDATA").toString("base64");

function imapSession(socket: net.Socket, credentials: { user: string; password: string }, state: { startTls: boolean; secure: boolean }, greet = true) {
  let buffer = "";
  let selected = false;
  const write = (value: string) => { if (!socket.destroyed) socket.write(value); };
  const fetch = (tag: string, _uidMode: boolean, set: string, items: string) => {
    const uids = set === "1:*" ? [1, 2] : set.split(",").map((value) => Number(value.split(":")[0])).filter((value) => uidsFor(value));
    const sections = [...items.matchAll(/BODY(?:\.PEEK)?\[([^\]]+)\](?:<[^>]*>)?/gi)].map((match) => match[1]!);
    for (const uid of uids) {
      const seq = uid;
      const parts: string[] = [`UID ${uid}`];
      if (/FLAGS/.test(items)) parts.push(`FLAGS (${FLAGS[uid as 1 | 2] ?? ""})`);
      if (/ENVELOPE/.test(items)) parts.push(`ENVELOPE ${ENVELOPES[uid as 1 | 2]}`);
      if (/INTERNALDATE/.test(items)) parts.push(`INTERNALDATE "02-Jan-2024 10:00:00 +0000"`);
      if (/RFC822\.SIZE/.test(items)) parts.push(`RFC822.SIZE ${uid === 1 ? 19 : 60}`);
      if (/BODYSTRUCTURE/.test(items)) parts.push(`BODYSTRUCTURE ${STRUCTURE[uid as 1 | 2]}`);
      const literalFor = (section: string): string | Buffer | null => {
        const key = section.toUpperCase();
        if (key === "1" || key === "TEXT") return BODY[uid as 1 | 2];
        if (key === "2") return ATTACHMENT;
        if (key === "1.MIME") return 'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n';
        if (key === "2.MIME") return 'Content-Type: application/pdf; name="report.pdf"\r\nContent-Disposition: attachment; filename="report.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n';
        if (key === "HEADER") return HEADERS[uid as 1 | 2] ?? "";
        if (key.startsWith("HEADER.FIELDS")) return HEADERS[uid as 1 | 2] ?? "";
        return null;
      };
      write(`* ${seq} FETCH (${parts.join(" ")}`);
      for (const section of sections) {
        const data = literalFor(section);
        if (data === null) continue;
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
        write(` BODY[${section}] {${buffer.byteLength}}\r\n`);
        write(buffer.toString("binary"));
      }
      write(")\r\n");
    }
    write(`${tag} OK FETCH completed\r\n`);
  };
  const uidsFor = (uid: number) => uid === 1 || uid === 2;

  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    for (;;) {
      const index = buffer.indexOf("\r\n");
      if (index < 0) return;
      const command = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const match = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(command);
      if (!match) continue;
      const [, tag, verb, rest = ""] = match;
      switch (verb!.toUpperCase()) {
        case "CAPABILITY":
          line(socket, `* CAPABILITY IMAP4rev1${state.startTls && !state.secure ? " STARTTLS" : ""}`);
          line(socket, `${tag} OK CAPABILITY completed`);
          break;
        case "STARTTLS": {
          if (!state.startTls || state.secure) { line(socket, `${tag} BAD STARTTLS not available`); break; }
          line(socket, `${tag} OK Begin TLS`);
          socket.removeAllListeners("data");
          const secure = new tls.TLSSocket(socket, { isServer: true, key: TEST_KEY, cert: TEST_CERT });
          state.secure = true;
          secure.once("secure", () => imapSession(secure as unknown as net.Socket, credentials, state, false));
          secure.on("error", () => socket.destroy());
          break;
        }
        case "LOGIN": {
          const values = [...rest.matchAll(/"([^"]*)"|(\S+)/g)].map((entry) => entry[1] ?? entry[2] ?? "");
          if (values[0] === credentials.user && values[1] === credentials.password) line(socket, `${tag} OK LOGIN completed`);
          else line(socket, `${tag} NO [AUTHENTICATIONFAILED] Authentication failed`);
          break;
        }
        case "LIST": {
          // `LIST "" ""` is the delimiter/namespace query; answering with folders there would make
          // the client treat the first folder as a namespace prefix.
          if (/^(""|'') +(""|'')$/.test(rest.trim())) {
            line(socket, '* LIST (\\Noselect) "/" ""');
          } else {
            line(socket, '* LIST (\\HasNoChildren) "/" "INBOX"');
            line(socket, '* LIST () "/" "INBOX/Projects"');
          }
          line(socket, `${tag} OK LIST completed`);
          break;
        }
        case "SELECT":
        case "EXAMINE":
          selected = true;
          line(socket, "* 2 EXISTS");
          line(socket, "* OK [UIDVALIDITY 42] UIDs valid");
          line(socket, "* OK [UIDNEXT 3] Predicted next UID");
          line(socket, "* FLAGS (\\Seen \\Flagged)");
          line(socket, "* OK [PERMANENTFLAGS (\\Seen \\Flagged)] Limited");
          line(socket, `${tag} OK [READ-WRITE] SELECT completed`);
          break;
        case "SEARCH":
          if (!selected) { line(socket, `${tag} BAD No mailbox selected`); break; }
          line(socket, "* SEARCH 1 2");
          line(socket, `${tag} OK SEARCH completed`);
          break;
        case "FETCH":
          if (!selected) { line(socket, `${tag} BAD No mailbox selected`); break; }
          fetch(tag!, false, rest.split(/\s+/)[0] ?? "1:*", rest);
          break;
        case "UID": {
          const sub = rest.trim().split(/\s+/, 2);
          if (sub[0]?.toUpperCase() === "FETCH") fetch(tag!, true, sub[1] ?? "1:*", rest);
          else if (sub[0]?.toUpperCase() === "SEARCH") {
            line(socket, "* SEARCH 1 2");
            line(socket, `${tag} OK SEARCH completed`);
          } else line(socket, `${tag} OK UID ${sub[0] ?? ""} completed`);
          break;
        }
        case "NOOP":
          line(socket, `${tag} OK NOOP completed`);
          break;
        case "LOGOUT":
          line(socket, "* BYE Logging out");
          line(socket, `${tag} OK LOGOUT completed`);
          socket.end();
          break;
        default:
          line(socket, `${tag} OK ${verb} completed`);
      }
    }
  };

  socket.on("data", onData);
  socket.on("error", () => socket.destroy());
  if (greet) line(socket, "* OK mock IMAP ready");
}

export async function startImapServer(opts: { user?: string; password?: string; starttls?: boolean; offerTls?: boolean } = {}): Promise<MockServer> {
  const credentials = { user: opts.user ?? "bob@example.test", password: opts.password ?? "app-password" };
  if (opts.starttls) {
    const server = net.createServer((socket) => imapSession(socket, credentials, { startTls: opts.offerTls !== false, secure: false }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      port: (server.address() as net.AddressInfo).port,
      messages: [],
      close: () => new Promise((resolve) => server.close(() => resolve())),
    };
  }
  const server = tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, (socket) => imapSession(socket, credentials, { startTls: false, secure: true }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    messages: [],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

function smtpSession(socket: net.Socket, opts: { user: string; password: string; starttls: boolean; offerTls: boolean; messages: string[] }, state: { secure: boolean }, greet = true) {
  let buffer = "";
  let dataMode = false;
  let data = "";
  let awaitingAuth = false;
  const line = (value: string) => socket.write(`${value}\r\n`);

  const continueProcessing = () => {
    for (;;) {
      const index = buffer.indexOf("\r\n");
      if (index < 0) return;
      const command = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (awaitingAuth) {
        awaitingAuth = false;
        line("235 2.7.0 authenticated");
        continue;
      }
      const upper = command.toUpperCase();
      if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
        line("250-mock greets you");
        if (opts.starttls && opts.offerTls && !state.secure) line("250-STARTTLS");
        line("250 AUTH PLAIN");
        continue;
      }
      if (upper === "STARTTLS") {
        if (!opts.starttls || !opts.offerTls || state.secure) { line("454 TLS not available"); continue; }
        line("220 2.0.0 Ready to start TLS");
        socket.removeAllListeners("data");
        const secure = new tls.TLSSocket(socket, { isServer: true, key: TEST_KEY, cert: TEST_CERT });
        secure.once("secure", () => smtpSession(secure as unknown as net.Socket, opts, { secure: true }, false));
        secure.on("error", () => socket.destroy());
        return;
      }
      if (upper.startsWith("AUTH PLAIN")) {
        const payload = command.slice("AUTH PLAIN".length).trim();
        if (!payload) { awaitingAuth = true; line("334 "); continue; }
        line("235 2.7.0 authenticated");
        continue;
      }
      if (upper.startsWith("MAIL FROM")) { line("250 2.1.0 ok"); continue; }
      if (upper.startsWith("RCPT TO")) { line("250 2.1.5 ok"); continue; }
      if (upper === "DATA") { dataMode = true; line("354 End data with <CR><LF>.<CR><LF>"); return; }
      if (upper === "RSET") { line("250 2.0.0 reset"); continue; }
      if (upper === "NOOP") { line("250 2.0.0 ok"); continue; }
      if (upper === "QUIT") { line("221 2.0.0 bye"); socket.end(); return; }
      line("250 2.0.0 ok");
    }
  };

  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    if (dataMode) {
      const end = buffer.indexOf("\r\n.\r\n");
      if (end < 0) return;
      data += buffer.slice(0, end);
      buffer = buffer.slice(end + 5);
      opts.messages.push(data);
      data = "";
      dataMode = false;
      line("250 2.0.0 queued");
    }
    continueProcessing();
  };

  socket.on("data", onData);
  socket.on("error", () => socket.destroy());
  if (greet) line("220 mock SMTP ready");
}

export async function startSmtpServer(opts: { user?: string; password?: string; starttls?: boolean; offerTls?: boolean } = {}): Promise<MockServer> {
  const messages: string[] = [];
  const config = { user: opts.user ?? "bob@example.test", password: opts.password ?? "app-password", starttls: opts.starttls === true, offerTls: opts.offerTls !== false, messages };
  const server = opts.starttls
    ? net.createServer((socket) => smtpSession(socket, config, { secure: false }))
    : tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, (socket) => smtpSession(socket, config, { secure: true }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    messages,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
