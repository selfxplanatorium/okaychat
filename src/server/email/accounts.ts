import dns from "node:dns/promises";
import { isIP } from "node:net";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { EmailAccount, EmailAccountInput, EmailAuthMethod, EmailSecurity, EmailServerConfig } from "../../shared/email.js";
import { decrypt, encrypt, newId } from "../crypto.js";
import { db, tx } from "../db.js";
import { AppError } from "../errors.js";
import { BlockedAddressError, publicAddress } from "../public-fetch.js";
import { isEmailAddress } from "./mime.js";

// Email account storage. Endpoints and the password are encrypted with OKAYCHAT_SECRET. A password
// is write-only: it is never part of the public account shape, never logged, and editing a server or
// username requires entering it again so a stored secret cannot silently follow a config change.

const MAX_ACCOUNTS = 10;
const MAX_HOST = 253;
const MAX_ADDRESS = 254;
const MAX_USERNAME = 320;
const MAX_PASSWORD = 1024;
const MAX_LABEL = 60;
const MAX_SIGNATURE = 4000;

export interface StoredEmailServer {
  host: string;
  port: number;
  security: EmailSecurity;
  username: string;
}

export interface EmailSecrets {
  /** The owning user, so every connection can re-check the live admin role. */
  userId: string;
  account: EmailAccount;
  password: string;
  imap: StoredEmailServer;
  smtp: StoredEmailServer;
}

interface EmailRow {
  id: string;
  user_id: string;
  label: string;
  address: string;
  imap_enc: string;
  smtp_enc: string;
  password_enc: string;
  security_json: string;
  read_enabled: number;
  send_enabled: number;
  is_default: number;
  signature: string;
  last_check_at: number | null;
  last_check_status: "ok" | "failed" | null;
  last_check_error: string | null;
  created_at: number;
  updated_at: number;
}

function invalid(message: string, status: 400 | 404 | 409 = 400): never {
  throw new HTTPException(status, { message });
}

function mayUsePrivateHosts(userId: string): boolean {
  return (db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | undefined)?.role === "admin";
}

/** Admins may reach a LAN mail server or an internal autoconfig endpoint. */
export const canUsePrivateHosts = mayUsePrivateHosts;

const hostname = (value: string) => {
  const host = value.trim().replace(/\.$/, "").toLowerCase();
  if (!host || host.length > MAX_HOST || /[\s\r\n\0/\\@]/.test(host)) return null;
  if (isIP(host)) return host;
  if (!/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i.test(host)) return null;
  if (!host.includes(".")) return null;
  return host;
};

const address = z
  .string()
  .trim()
  .max(MAX_ADDRESS)
  .refine(isEmailAddress, "Enter a valid email address.");

const noHeader = (value: string) => !/[\r\n\0]/.test(value);

const serverInput = z.object({
  host: z.string().trim().min(1, "Enter a mail server hostname.").max(MAX_HOST),
  port: z.number().int().min(1, "Enter a port between 1 and 65535.").max(65535, "Enter a port between 1 and 65535."),
  security: z.enum(["tls", "starttls"]),
  username: z.string().trim().min(1, "Enter the username for this server.").max(MAX_USERNAME).refine(noHeader, "A username cannot contain line breaks."),
});

const accountInput = z
  .object({
    label: z.string().trim().min(1, "Enter a name for this account.").max(MAX_LABEL).refine(noHeader, "A name cannot contain line breaks."),
    address,
    password: z.string().min(1, "Enter the password or app password for this mailbox.").max(MAX_PASSWORD).refine((value) => !value.includes("\0"), "Invalid password.").optional(),
    imap: serverInput,
    smtp: serverInput,
    signature: z.string().max(MAX_SIGNATURE).optional(),
    readEnabled: z.boolean().optional(),
    sendEnabled: z.boolean().optional(),
    allowInsecureProbe: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

const patchInput = accountInput.partial();

/** The endpoints are validated and host-checked on every write, not only in the browser. */
function checkServer(server: z.infer<typeof serverInput>): StoredEmailServer {
  const host = hostname(server.host);
  if (!host) invalid("Enter a valid mail server hostname or IP address.");
  return { host: host!, port: server.port, security: server.security, username: server.username };
}

/**
 * Non-admins may only reach public addresses, like provider base URLs and MCP servers. Admins may
 * point an account at a LAN mail server. The role is read again on every connection, so an account
 * saved while the user was an admin stops reaching a LAN host after a demotion.
 */
export async function assertEmailHost(userId: string, host: string): Promise<void> {
  try {
    await emailConnectTarget(userId, host);
  } catch (error) {
    if (error instanceof BlockedAddressError) throw new AppError({ code: "forbidden", message: error.message, hint: "Choose a public mail server, or ask an administrator to connect this host." });
    throw new AppError({ code: "validation", message: "Could not resolve the mail server hostname.", hint: "Check the hostname in Settings → Email and try again.", cause: error });
  }
}

export interface EmailConnectTarget {
  /** The address the client must connect to. For non-admins it is a checked, pinned IP literal. */
  host: string;
  /** The original hostname for TLS SNI and certificate verification; absent for IP literals. */
  servername?: string;
}

/**
 * Resolves a destination at connection time. Non-admins' answers are checked and the connection is
 * pinned to the checked address, so the client's own resolver cannot be rebound between the check
 * and the connect. Admins keep the hostname so a LAN name or IP works as before.
 */
export async function emailConnectTarget(userId: string, host: string): Promise<EmailConnectTarget> {
  const bare = host.replace(/^\[|\]$/g, "");
  const literal = isIP(bare) !== 0;
  if (mayUsePrivateHosts(userId)) return { host: bare, ...(literal ? {} : { servername: bare }) };
  if (literal) {
    if (!publicAddress(bare)) throw new BlockedAddressError("Only admins can connect to local or private mail servers.");
    return { host: bare };
  }
  const addresses = await dns.lookup(bare, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length) throw new Error(`Could not resolve ${bare}.`);
  if (addresses.some(({ address: found }) => !publicAddress(found))) {
    throw new BlockedAddressError("Only admins can connect to local or private mail servers.");
  }
  return { host: addresses[0]!.address, servername: bare };
}

/**
 * A DNS lookup for socket/TLS clients that rejects private answers for non-admins at connection
 * time. Undefined for admins, who may reach a LAN server.
 */
type EmailLookup = (hostname: string, options: { all?: boolean }, callback: (error: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void) => void;

export function emailLookup(userId: string): EmailLookup | undefined {
  if (mayUsePrivateHosts(userId)) return undefined;
  return (name, options, callback) => {
    dns.lookup(name, { all: true, verbatim: true }).then((addresses) => {
      if (!addresses.length || addresses.some(({ address: found }) => !publicAddress(found))) {
        callback(new BlockedAddressError("Only admins can connect to local or private mail servers."), "", 4);
        return;
      }
      const first = addresses[0]!;
      callback(null, options.all ? addresses : first.address, first.family);
    }, () => callback(new Error(`Could not resolve ${name}.`), "", 4));
  };
}

function decryptServer(value: string): StoredEmailServer {
  // Ciphertext is our own format; a parse failure means a corrupted row, never user input.
  return JSON.parse(decrypt(value)) as StoredEmailServer;
}

function toPublic(row: EmailRow): EmailAccount {
  const security = JSON.parse(row.security_json) as { allowInsecureProbe?: boolean };
  return {
    id: row.id,
    label: row.label,
    address: row.address,
    imap: decryptServer(row.imap_enc),
    smtp: decryptServer(row.smtp_enc),
    readEnabled: !!row.read_enabled,
    sendEnabled: !!row.send_enabled,
    isDefault: !!row.is_default,
    signature: row.signature,
    allowInsecureProbe: security.allowInsecureProbe === true,
    lastCheckAt: row.last_check_at,
    lastCheckStatus: row.last_check_status,
    lastCheckError: row.last_check_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAccounts(userId: string): EmailAccount[] {
  const rows = db
    .prepare("SELECT * FROM email_accounts WHERE user_id = ? ORDER BY is_default DESC, lower(label) COLLATE NOCASE, created_at")
    .all(userId) as unknown as EmailRow[];
  return rows.map(toPublic);
}

function rowOf(userId: string, id: string): EmailRow {
  const row = db.prepare("SELECT * FROM email_accounts WHERE user_id = ? AND id = ?").get(userId, id) as EmailRow | undefined;
  if (!row) invalid("Email account not found", 404);
  return row!;
}

export function getAccount(userId: string, id: string): EmailAccount {
  return toPublic(rowOf(userId, id));
}

export function countAccounts(userId: string): number {
  return (db.prepare("SELECT count(*) AS n FROM email_accounts WHERE user_id = ?").get(userId) as { n: number }).n;
}

export function hasAccounts(userId: string): boolean {
  return !!db.prepare("SELECT 1 FROM email_accounts WHERE user_id = ? LIMIT 1").get(userId);
}

/** The account a tool uses when the model did not name one: the default, else the oldest. */
export function defaultAccount(userId: string): EmailAccount | null {
  return listAccounts(userId)[0] ?? null;
}

export function accountSecrets(userId: string, id: string): EmailSecrets {
  const row = rowOf(userId, id);
  return {
    userId,
    account: toPublic(row),
    password: decrypt(row.password_enc),
    imap: decryptServer(row.imap_enc),
    smtp: decryptServer(row.smtp_enc),
  };
}

/** Resolves one account for a tool and re-checks the live toggle at execution time. */
export function accountForRead(userId: string, id?: string): EmailAccount {
  const account = id ? getAccount(userId, id) : defaultAccount(userId);
  if (!account) invalid("No email account is connected. Add one in Settings → Email.", 400);
  if (!account.readEnabled) invalid(`Reading is turned off for ${account.address}. Turn it on in Settings → Email.`, 409);
  return account;
}

export function accountForSend(userId: string, id?: string): EmailAccount {
  const account = id ? getAccount(userId, id) : defaultAccount(userId);
  if (!account) invalid("No email account is connected. Add one in Settings → Email.", 400);
  if (!account.sendEnabled) invalid(`Sending is turned off for ${account.address}. Turn it on in Settings → Email.`, 409);
  return account;
}

async function checkHosts(userId: string, imap: StoredEmailServer, smtp: StoredEmailServer): Promise<void> {
  await assertEmailHost(userId, imap.host);
  await assertEmailHost(userId, smtp.host);
}

const draftInput = z
  .object({
    address,
    password: z.string().min(1, "Enter the password or app password for this mailbox.").max(MAX_PASSWORD).refine((value) => !value.includes("\0"), "Invalid password."),
    imap: serverInput,
    smtp: serverInput,
    allowInsecureProbe: z.boolean().optional(),
  })
  .strict();

export interface EmailDraft {
  address: string;
  password: string;
  imap: StoredEmailServer;
  smtp: StoredEmailServer;
  allowInsecureProbe: boolean;
}

/** Validates an unsaved draft for the settings Test button. Nothing is stored. */
export async function parseAccountDraft(userId: string, input: unknown): Promise<EmailDraft> {
  const parsed = draftInput.safeParse(input);
  if (!parsed.success) invalid(parsed.error.issues[0]?.message ?? "Invalid email account.");
  const data = parsed.data;
  const imap = checkServer(data.imap);
  const smtp = checkServer(data.smtp);
  await checkHosts(userId, imap, smtp);
  return { address: data.address, password: data.password, imap, smtp, allowInsecureProbe: data.allowInsecureProbe === true };
}

export async function createAccount(userId: string, input: unknown): Promise<EmailAccount> {
  const parsed = accountInput.safeParse(input);
  if (!parsed.success) invalid(parsed.error.issues[0]?.message ?? "Invalid email account.");
  const data = parsed.data;
  const password = data.password;
  if (!password) invalid("Enter the password or app password for this mailbox.");
  const imap = checkServer(data.imap);
  const smtp = checkServer(data.smtp);
  await checkHosts(userId, imap, smtp);
  if (countAccounts(userId) >= MAX_ACCOUNTS) invalid(`You can connect up to ${MAX_ACCOUNTS} email accounts.`, 409);
  const duplicate = db.prepare("SELECT 1 FROM email_accounts WHERE user_id = ? AND address = ?").get(userId, data.address);
  if (duplicate) invalid("That email address is already connected.", 409);
  const now = Date.now();
  const id = newId("eml");
  const first = countAccounts(userId) === 0;
  const isDefault = data.isDefault === true || first;
  try {
    tx(() => {
      if (isDefault) db.prepare("UPDATE email_accounts SET is_default = 0 WHERE user_id = ?").run(userId);
      db.prepare(
        `INSERT INTO email_accounts
          (id, user_id, label, address, imap_enc, smtp_enc, password_enc, security_json,
           read_enabled, send_enabled, is_default, signature, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        userId,
        data.label,
        data.address,
        encrypt(JSON.stringify(imap)),
        encrypt(JSON.stringify(smtp)),
        encrypt(password),
        JSON.stringify({ allowInsecureProbe: data.allowInsecureProbe === true }),
        Number(data.readEnabled ?? true),
        Number(data.sendEnabled ?? true),
        Number(isDefault),
        data.signature ?? "",
        now,
        now,
      );
    });
  } catch (error) {
    if (/UNIQUE constraint failed: email_accounts\.user_id, email_accounts\.address/.test(String(error))) {
      invalid("That email address is already connected.", 409);
    }
    throw error;
  }
  return getAccount(userId, id);
}

export async function updateAccount(userId: string, id: string, input: unknown): Promise<EmailAccount> {
  const parsed = patchInput.safeParse(input);
  if (!parsed.success) invalid(parsed.error.issues[0]?.message ?? "Invalid email account.");
  const row = rowOf(userId, id);
  const data = parsed.data;
  const currentImap = decryptServer(row.imap_enc);
  const currentSmtp = decryptServer(row.smtp_enc);
  const imap = data.imap ? checkServer(data.imap) : currentImap;
  const smtp = data.smtp ? checkServer(data.smtp) : currentSmtp;
  const endpointChanged =
    imap.host !== currentImap.host ||
    imap.port !== currentImap.port ||
    imap.username !== currentImap.username ||
    smtp.host !== currentSmtp.host ||
    smtp.port !== currentSmtp.port ||
    smtp.username !== currentSmtp.username;
  // Transport security is part of what a connection check tested.
  const configChanged = endpointChanged || imap.security !== currentImap.security || smtp.security !== currentSmtp.security;
  const password = data.password?.length ? data.password : undefined;
  // A stored secret never follows a new destination. The user must confirm it by re-entering it.
  if (endpointChanged && !password) {
    invalid("Enter the password again after changing a server address, port, or username. It is not sent to a new destination automatically.");
  }
  // A toggle-only patch must not fail because DNS is briefly unavailable.
  if (endpointChanged || data.imap || data.smtp) await checkHosts(userId, imap, smtp);
  if (data.address && data.address !== row.address) {
    const duplicate = db.prepare("SELECT 1 FROM email_accounts WHERE user_id = ? AND address = ? AND id != ?").get(userId, data.address, id);
    if (duplicate) invalid("That email address is already connected.", 409);
  }
  const now = Date.now();
  const nextDefault = data.isDefault ?? !!row.is_default;
  const security = data.allowInsecureProbe === undefined
    ? JSON.parse(row.security_json) as { allowInsecureProbe?: boolean }
    : { allowInsecureProbe: data.allowInsecureProbe };
  tx(() => {
    // The host check above awaits DNS; a concurrent save in that window would be overwritten with
    // this request's stale copy (a re-enabled send switch, an old password), so it wins instead.
    if (configFingerprint(rowOf(userId, id)) !== configFingerprint(row)) {
      invalid("This email account changed while saving. Reload it and try again.", 409);
    }
    if (nextDefault && !row.is_default) db.prepare("UPDATE email_accounts SET is_default = 0 WHERE user_id = ?").run(userId);
    db.prepare(
      `UPDATE email_accounts SET
        label = ?, address = ?, imap_enc = ?, smtp_enc = ?, password_enc = ?, security_json = ?,
        read_enabled = ?, send_enabled = ?, is_default = ?, signature = ?,
        last_check_at = ?, last_check_status = ?, last_check_error = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).run(
      data.label ?? row.label,
      data.address ?? row.address,
      encrypt(JSON.stringify(imap)),
      encrypt(JSON.stringify(smtp)),
      password ? encrypt(password) : row.password_enc,
      JSON.stringify({ allowInsecureProbe: security.allowInsecureProbe === true }),
      Number(data.readEnabled ?? !!row.read_enabled),
      Number(data.sendEnabled ?? !!row.send_enabled),
      Number(nextDefault),
      data.signature ?? row.signature,
      // Any config change invalidates the last successful check until it is tested again.
      configChanged || password ? null : row.last_check_at,
      configChanged || password ? null : row.last_check_status,
      configChanged || password ? null : row.last_check_error,
      now,
      id,
      userId,
    );
    // A default account cannot be turned into a non-default one without choosing a replacement.
    if (!nextDefault) ensureDefault(userId);
  });
  return getAccount(userId, id);
}

export function setDefaultAccount(userId: string, id: string): EmailAccount {
  rowOf(userId, id);
  tx(() => {
    db.prepare("UPDATE email_accounts SET is_default = 0 WHERE user_id = ?").run(userId);
    db.prepare("UPDATE email_accounts SET is_default = 1, updated_at = ? WHERE id = ? AND user_id = ?").run(Date.now(), id, userId);
  });
  return getAccount(userId, id);
}

export function deleteAccount(userId: string, id: string): void {
  const row = rowOf(userId, id);
  tx(() => {
    db.prepare("DELETE FROM email_accounts WHERE id = ? AND user_id = ?").run(id, userId);
    if (row.is_default) ensureDefault(userId);
  });
}

function ensureDefault(userId: string): void {
  const current = db.prepare("SELECT 1 FROM email_accounts WHERE user_id = ? AND is_default = 1").get(userId);
  if (current) return;
  const next = db.prepare("SELECT id FROM email_accounts WHERE user_id = ? ORDER BY created_at LIMIT 1").get(userId) as { id: string } | undefined;
  if (next) db.prepare("UPDATE email_accounts SET is_default = 1 WHERE id = ? AND user_id = ?").run(next.id, userId);
}

/** Every stored field a save or a connection check depends on; encrypted columns change on each write. */
function configFingerprint(row: EmailRow): string {
  return JSON.stringify([row.label, row.address, row.imap_enc, row.smtp_enc, row.password_enc, row.security_json, row.read_enabled, row.send_enabled, row.is_default, row.signature]);
}

/** The configuration a connection test is about to check, for `recordCheck`. */
export function checkFingerprint(userId: string, id: string): string {
  const row = rowOf(userId, id);
  return JSON.stringify([row.imap_enc, row.smtp_enc, row.password_enc]);
}

/** Stores a test result, unless the tested configuration was replaced while the test ran. */
export function recordCheck(userId: string, id: string, status: "ok" | "failed", error: string | null, tested?: string): EmailAccount {
  if (tested === undefined || checkFingerprint(userId, id) === tested) {
    db.prepare("UPDATE email_accounts SET last_check_at = ?, last_check_status = ?, last_check_error = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(
      Date.now(),
      status,
      status === "ok" ? null : (error ?? "Connection failed."),
      Date.now(),
      id,
      userId,
    );
  }
  return getAccount(userId, id);
}

/**
 * Provider auth hook. Only passwords and app passwords are supported in v1. The UI reads this list
 * instead of hardcoding the note, so adding OAuth later is one provider implementation, not a rewrite.
 */
export function authMethods(): EmailAuthMethod[] {
  return [
    { id: "password", label: "Password or app password", available: true },
    {
      id: "oauth",
      label: "Sign in with Google or Microsoft",
      available: false,
      note: "OAuth is not available yet. Create an app password with your mail provider and enter it here.",
    },
  ];
}
