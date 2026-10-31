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
  /** Every protocol command line received, for assertions about what was actually sent. */
  commands: string[];
  /** Sockets accepted (after TLS for implicit-TLS servers). A blocked client must leave this at 0. */
  connections: number;
}

const line = (socket: net.Socket, value: string) => socket.write(`${value}\r\n`);

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------

const ENVELOPES: Record<number, string> = {
  1: '("Tue, 02 Jan 2024 10:00:00 +0000" "Hello from Alice" (("Alice" NIL "alice" "example.test")) (("Alice" NIL "alice" "example.test")) (("Alice" NIL "alice" "example.test")) (("Bob" NIL "bob" "example.test")) NIL NIL NIL "<hello@example.test>")',
  2: '("Wed, 03 Jan 2024 11:30:00 +0000" "Report attached" (("Carol" NIL "carol" "example.test")) (("Carol" NIL "carol" "example.test")) (("Carol" NIL "carol" "example.test")) (("Bob" NIL "bob" "example.test")) NIL NIL NIL "<report@example.test>")',
  3: '("Thu, 04 Jan 2024 09:00:00 +0000" "Latin1 message" (("Alice" NIL "alice" "example.test")) (("Alice" NIL "alice" "example.test")) (("Alice" NIL "alice" "example.test")) (("Bob" NIL "bob" "example.test")) NIL NIL NIL "<latin1@example.test>")',
};

const BODY: Record<number, string | Buffer> = {
  1: "First message body.",
  2: "Second message body.\r\nSee the attached report.",
  // ISO-8859-1 bytes: "Café au lait".
  3: Buffer.from("Caf\xe9 au lait", "latin1"),
};

const HEADERS: Record<number, string> = {
  1: "Message-ID: <hello@example.test>\r\nIn-Reply-To: <earlier@example.test>\r\nReferences: <earlier@example.test>\r\nReply-To: Alice <alice@example.test>\r\n",
  2: "Message-ID: <report@example.test>\r\nReferences: <hello@example.test> <earlier@example.test>\r\n",
  3: "Message-ID: <latin1@example.test>\r\nContent-Type: text/plain; charset=\"ISO-8859-1\"\r\nContent-Transfer-Encoding: 7bit\r\n",
};

const STRUCTURE: Record<number, string> = {
  1: '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 19 1 NIL NIL NIL NIL)',
  2: '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 42 2 NIL NIL NIL NIL)("APPLICATION" "PDF" ("NAME" "report.pdf") NIL NIL "BASE64" 12 NIL ("ATTACHMENT" ("FILENAME" "report.pdf")) NIL NIL) "MIXED" ("BOUNDARY" "b1") NIL NIL NIL)',
  3: '("TEXT" "PLAIN" ("CHARSET" "ISO-8859-1") NIL NIL "7BIT" 12 1 NIL NIL NIL NIL)',
};

const FLAGS: Record<number, string> = { 1: "\\Seen", 2: "", 3: "\\Seen" };
const ATTACHMENT = Buffer.from("PDFDATA").toString("base64");

function imapSession(socket: net.Socket, credentials: { user: string; password: string }, state: { startTls: boolean; secure: boolean; latin1?: boolean; commands?: string[] }, greet = true) {
  let buffer = "";
  let selected = false;
  const exposed = state.latin1 ? [1, 2, 3] : [1, 2];
  const write = (value: string) => { if (!socket.destroyed) socket.write(value); };
  const fetch = (tag: string, _uidMode: boolean, set: string, items: string) => {
    const uids = set === "1:*" ? exposed : set.split(",").map((value) => Number(value.split(":")[0])).filter((value) => uidsFor(value));
    const sections = [...items.matchAll(/BODY(?:\.PEEK)?\[([^\]]+)\](?:<[^>]*>)?/gi)].map((match) => match[1]!);
    for (const uid of uids) {
      const seq = uid;
      const parts: string[] = [`UID ${uid}`];
      if (/FLAGS/.test(items)) parts.push(`FLAGS (${FLAGS[uid] ?? ""})`);
      if (/ENVELOPE/.test(items)) parts.push(`ENVELOPE ${ENVELOPES[uid]}`);
      if (/INTERNALDATE/.test(items)) parts.push(`INTERNALDATE "02-Jan-2024 10:00:00 +0000"`);
      if (/RFC822\.SIZE/.test(items)) parts.push(`RFC822.SIZE ${uid === 1 ? 19 : 60}`);
      if (/BODYSTRUCTURE/.test(items)) parts.push(`BODYSTRUCTURE ${STRUCTURE[uid]}`);
      const literalFor = (section: string): string | Buffer | null => {
        const key = section.toUpperCase();
        if (key === "1" || key === "TEXT") return BODY[uid];
        if (key === "2") return ATTACHMENT;
        if (key === "1.MIME") return 'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n';
        if (key === "2.MIME") return 'Content-Type: application/pdf; name="report.pdf"\r\nContent-Disposition: attachment; filename="report.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n';
        if (key === "HEADER") return HEADERS[uid] ?? "";
        if (key.startsWith("HEADER.FIELDS")) return HEADERS[uid] ?? "";
        return null;
      };
      write(`* ${seq} FETCH (${parts.join(" ")}`);
      for (const section of sections) {
        const data = literalFor(section);
        if (data === null) continue;
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
        write(` BODY[${section}] {${buffer.byteLength}}\r\n`);
        // Write the bytes themselves: socket.write(string) would encode them as UTF-8 and
        // corrupt a non-UTF-8 fixture before the client ever sees it.
        if (!socket.destroyed) socket.write(buffer);
      }
      write(")\r\n");
    }
    write(`${tag} OK FETCH completed\r\n`);
  };
  const uidsFor = (uid: number) => exposed.includes(uid);

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
      state.commands?.push(command);
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
          line(socket, `* ${exposed.length} EXISTS`);
          line(socket, "* OK [UIDVALIDITY 42] UIDs valid");
          line(socket, "* OK [UIDNEXT 3] Predicted next UID");
          line(socket, "* FLAGS (\\Seen \\Flagged)");
          line(socket, "* OK [PERMANENTFLAGS (\\Seen \\Flagged)] Limited");
          line(socket, `${tag} OK [READ-WRITE] SELECT completed`);
          break;
        case "SEARCH":
          if (!selected) { line(socket, `${tag} BAD No mailbox selected`); break; }
          line(socket, `* SEARCH ${exposed.join(" ")}`);
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
            line(socket, `* SEARCH ${exposed.join(" ")}`);
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

export async function startImapServer(opts: { user?: string; password?: string; starttls?: boolean; offerTls?: boolean; latin1?: boolean } = {}): Promise<MockServer> {
  const credentials = { user: opts.user ?? "bob@example.test", password: opts.password ?? "app-password" };
  const commands: string[] = [];
  let connections = 0;
  const session = (socket: net.Socket, startTls: boolean) => {
    connections += 1;
    imapSession(socket, credentials, { startTls, secure: !startTls, latin1: opts.latin1 === true, commands });
  };
  if (opts.starttls) {
    const server = net.createServer((socket) => session(socket, opts.offerTls !== false));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      port: (server.address() as net.AddressInfo).port,
      messages: [],
      commands,
      get connections() { return connections; },
      close: () => new Promise((resolve) => server.close(() => resolve())),
    };
  }
  const server = tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, (socket) => session(socket, false));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    messages: [],
    commands,
    get connections() { return connections; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

function smtpSession(socket: net.Socket, opts: { user: string; password: string; starttls: boolean; offerTls: boolean; messages: string[]; commands: string[] }, state: { secure: boolean }, greet = true) {
  let buffer = "";
  let dataMode = false;
  let data = "";
  let awaitingAuth = false;
  let authenticated = false;
  const line = (value: string) => socket.write(`${value}\r\n`);
  const authPlain = (payload: string): boolean => {
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    const parts = decoded.split("\0");
    return parts.length >= 3 && parts[1] === opts.user && parts[2] === opts.password;
  };

  const continueProcessing = () => {
    for (;;) {
      const index = buffer.indexOf("\r\n");
      if (index < 0) return;
      const command = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      opts.commands.push(command);
      if (awaitingAuth) {
        awaitingAuth = false;
        if (authPlain(command.trim())) { authenticated = true; line("235 2.7.0 authenticated"); }
        else line("535 5.7.8 Authentication credentials invalid");
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
        if (authPlain(payload)) { authenticated = true; line("235 2.7.0 authenticated"); }
        else line("535 5.7.8 Authentication credentials invalid");
        continue;
      }
      if (upper.startsWith("MAIL FROM")) {
        if (!authenticated) { line("530 5.7.0 Authentication required"); continue; }
        line("250 2.1.0 ok");
        continue;
      }
      if (upper.startsWith("RCPT TO")) {
        if (!authenticated) { line("530 5.7.0 Authentication required"); continue; }
        line("250 2.1.5 ok");
        continue;
      }
      if (upper === "DATA") {
        if (!authenticated) { line("530 5.7.0 Authentication required"); continue; }
        dataMode = true;
        line("354 End data with <CR><LF>.<CR><LF>");
        return;
      }
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
  const commands: string[] = [];
  let connections = 0;
  const config = { user: opts.user ?? "bob@example.test", password: opts.password ?? "app-password", starttls: opts.starttls === true, offerTls: opts.offerTls !== false, messages, commands };
  const session = (socket: net.Socket, secure: boolean) => {
    connections += 1;
    smtpSession(socket, config, { secure });
  };
  const server = opts.starttls
    ? net.createServer((socket) => session(socket, false))
    : tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, (socket) => session(socket, true));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    messages,
    commands,
    get connections() { return connections; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
