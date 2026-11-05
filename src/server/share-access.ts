import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { clientKey } from "./auth.js";
import { sha256 } from "./crypto.js";
import { env } from "./env.js";

/**
 * The unlock cookie for a password-protected share. It is HttpOnly, scoped to that one link's public
 * path, and HMAC-bound to the current password hash, expiry, and issue time: changing the password or
 * expiry makes every earlier cookie invalid, and a copied one stops working after 12 hours.
 */

export const SHARE_COOKIE_TTL_SECONDS = 12 * 60 * 60;

/** One cookie per link, so several password-protected links can be open at once. */
export function shareCookieName(token: string): string {
  return `okc_share_${sha256(token).slice(0, 16)}`;
}

interface CookieShare {
  token: string;
  password_hash: string | null;
  expires_at: number | null;
}

function mac(share: CookieShare, issuedAt: number): Buffer {
  return createHmac("sha256", env.secret)
    .update(`share:${share.token}:${share.password_hash ?? ""}:${share.expires_at ?? 0}:${issuedAt}`)
    .digest();
}

export function shareCookieValue(share: CookieShare): string {
  const issuedAt = Date.now();
  return `v1.${issuedAt}.${mac(share, issuedAt).toString("base64url")}`;
}

/** True while the cookie was issued for this exact password/expiry and is younger than 12 hours. */
export function verifyShareCookie(value: string | undefined, share: CookieShare): boolean {
  if (!value) return false;
  const [version, issued, digest] = value.split(".");
  if (version !== "v1" || !issued || !digest) return false;
  const issuedAt = Number(issued);
  if (!Number.isFinite(issuedAt) || issuedAt + SHARE_COOKIE_TTL_SECONDS * 1000 <= Date.now()) return false;
  const expected = mac(share, issuedAt);
  const given = Buffer.from(digest, "base64url");
  // Fixed-length comparison: a wrong version or a truncated digest must not leak timing.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** True when the browser reached us over HTTPS, including through a TLS-terminating proxy. */
function isHttps(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  return (proto ?? new URL(c.req.url).protocol.replace(":", "")) === "https";
}

/** Scoped to the link's own public path, so one unlock never covers another link. */
export function setShareCookie(c: Context, share: CookieShare, maxAgeSeconds: number): void {
  setCookie(c, shareCookieName(share.token), shareCookieValue(share), {
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttps(c),
    path: `/api/public/shares/${share.token}`,
    maxAge: Math.max(1, Math.floor(maxAgeSeconds)),
  });
}

export function clearShareCookie(c: Context, share: CookieShare): void {
  deleteCookie(c, shareCookieName(share.token), { path: `/api/public/shares/${share.token}` });
}

export function shareCookie(c: Context, share: CookieShare): string | undefined {
  return getCookie(c, shareCookieName(share.token));
}

/** Rate-limit key: one link plus one client address. */
export const unlockKey = (c: Context, token: string): string => `share:${token}:${clientKey(c)}`;
