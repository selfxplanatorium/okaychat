// Friendly, actionable errors for IMAP/SMTP/discovery. Library errors are mapped by shape, and
// authentication failures never echo the server's reply, which can quote credentials.

export type EmailErrorCode =
  | "auth"
  | "unreachable"
  | "certificate"
  | "connections"
  | "too_large"
  | "rate_limited"
  | "not_found"
  | "protocol"
  | "disabled";

export class EmailError extends Error {
  constructor(
    readonly code: EmailErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const TLS_CODES = [
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "HOSTNAME_MISMATCH",
  "ERR_SSL_WRONG_VERSION_NUMBER",
];

export function mapEmailError(error: unknown, context = "mail server"): EmailError {
  if (error instanceof EmailError) return error;
  const value = error as { code?: string; message?: string; authenticationFailed?: boolean; responseText?: string } | undefined;
  const code = value?.code ?? "";
  const message = value?.message ?? String(error);
  const text = `${code} ${message} ${value?.responseText ?? ""}`;
  if (/Only admins can connect/i.test(message)) return new EmailError("protocol", message, { cause: error });
  if (value?.authenticationFailed || /AUTHENTICATIONFAILED|AUTHENTICATE failed|LOGIN failed|invalid credentials|authentication credentials invalid|authentication failed|auth failed|LOGINDISABLED|\b535\b/i.test(text)) {
    return new EmailError(
      "auth",
      `The ${context} rejected the sign-in for this account. Check the email address and password. Gmail, Outlook, iCloud, and Yahoo need an app password, not your normal password.`,
    );
  }
  if (TLS_CODES.some((known) => code.includes(known)) || /certificate|self[- ]signed|altnames?|TLS handshake/i.test(text)) {
    return new EmailError("certificate", `The ${context} TLS certificate could not be verified. Check the server hostname; self-signed certificates are not accepted.`);
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|socket hang up|Greeting never received|Connection not available/i.test(text)) {
    return new EmailError("unreachable", `Could not reach the ${context}. Check the hostname and port, and whether the server allows connections from this machine.`);
  }
  if (/too many connections|maximum number of connections|connection limit|UNAVAILABLE/i.test(text)) {
    return new EmailError("connections", `The ${context} refused another connection because too many are open. Wait a moment and try again.`);
  }
  if (/too large|maxBytes|size limit|larger than/i.test(text)) {
    return new EmailError("too_large", "That message or attachment is larger than the size limit.");
  }
  if (/rate.?limit|throttl|too many requests|try again later/i.test(text)) {
    return new EmailError("rate_limited", `The ${context} is rate limiting this account. Wait a few minutes and try again.`);
  }
  if (/not found|does not exist|NONEXISTENT|no such mailbox/i.test(text)) {
    return new EmailError("not_found", `That folder or message no longer exists on the ${context}.`);
  }
  return new EmailError("protocol", `The ${context} returned an unexpected response. Try again, or check the server settings.`, { cause: error });
}
