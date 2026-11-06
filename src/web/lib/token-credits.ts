import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_TOKEN_CREDIT, type TokenCreditAuditEntry, type TokenCreditBalance } from "@shared/token-credits";
import { t, type PlainMessageKey } from "@/i18n";
import { formatNumber } from "@/i18n/format";
import { api, ApiError } from "@/lib/api";
import { errorText } from "@/lib/error-text";

/** One page of the append-only allowance history. */
export interface CreditAuditPage {
  rows: TokenCreditAuditEntry[];
  nextCursor: number | null;
}

export interface CreditMutationResult {
  balance: TokenCreditBalance;
}

const adminBalancePath = (userId: string) => `/admin/users/${encodeURIComponent(userId)}/credits`;

const STATUSES: ReadonlySet<string> = new Set(["unlimited", "available", "exhausted", "usage_unknown"]);

/** A malformed or unmounted response must read as unavailable, never as a zero or unlimited balance. */
export function isTokenCreditBalance(value: unknown): value is TokenCreditBalance {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const numeric = (field: unknown) => typeof field === "number" && Number.isSafeInteger(field) && field >= 0;
  return (record.creditTokens === null || numeric(record.creditTokens))
    && numeric(record.consumedTokens)
    && (record.remainingTokens === null || numeric(record.remainingTokens))
    && numeric(record.unknownRequests)
    && numeric(record.period)
    && numeric(record.periodStartedAt)
    && record.resetPolicy === "manual"
    && numeric(record.version)
    && typeof record.status === "string" && STATUSES.has(record.status)
    && numeric(record.activeOperations)
    && numeric(record.asOf);
}

const expectBalance = (value: unknown): TokenCreditBalance => {
  if (!isTokenCreditBalance(value)) throw new Error("Invalid credit balance.");
  return value;
};

const expectMutation = async (request: Promise<unknown>): Promise<CreditMutationResult> => {
  const value = await request;
  if (typeof value !== "object" || value === null || !isTokenCreditBalance((value as { balance?: unknown }).balance)) {
    throw new Error("Invalid credit mutation result.");
  }
  return value as CreditMutationResult;
};

export const getCreditBalance = () => api<unknown>("/credits").then(expectBalance);

export const getAdminCreditBalance = (userId: string) =>
  api<unknown>(adminBalancePath(userId)).then(expectBalance);

export const getCreditAudit = (userId: string, before?: number, limit = 50) =>
  api<CreditAuditPage>(`${adminBalancePath(userId)}/audit?limit=${limit}${before === undefined ? "" : `&before=${before}`}`);

export const setAdminCredit = (userId: string, body: { creditTokens: number | null; expectedVersion: number; mutationId: string; reason: string }) =>
  expectMutation(api<unknown>(adminBalancePath(userId), { method: "PATCH", json: body }));

export const resetAdminCredit = (userId: string, body: { expectedVersion: number; mutationId: string; reason: string; acknowledgeUnknown: boolean }) =>
  expectMutation(api<unknown>(`${adminBalancePath(userId)}/reset`, { method: "POST", json: body }));

/**
 * A UUID for one allowance mutation. `crypto.randomUUID` needs a secure origin, and this app is
 * regularly served over plain HTTP on a tailnet, so build one from `getRandomValues` instead.
 * The id is not a secret; it only lets an identical retry deduplicate on the server.
 */
export function creditMutationId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A blank or non-integer amount is invalid; `null` means Unlimited. */
export function parseCreditAmount(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/u.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKEN_CREDIT ? value : undefined;
}

export const creditAmountText = (creditTokens: number | null) =>
  creditTokens === null ? t("credits.unlimited") : formatNumber(creditTokens);

const ACTION_KEYS = {
  set: "credits.setAction",
  clear: "credits.clearAction",
  reset: "credits.resetAction",
} as const satisfies Record<TokenCreditAuditEntry["action"], PlainMessageKey>;

export const creditActionKey = (action: TokenCreditAuditEntry["action"]): PlainMessageKey => ACTION_KEYS[action];

/** Stable credit codes keep their authored allowance text even when a mutation or fetch fails. */
export function creditErrorText(cause: unknown, fallback: PlainMessageKey): string {
  if (cause instanceof ApiError) {
    const code: string = cause.code;
    if (code === "conflict") return t("credits.conflict");
    if (code === "token_credit_busy") return t("credits.busy");
    if (code === "token_credit_exhausted") return t("credits.exhausted");
    if (code === "token_credit_usage_unknown") return t("credits.unknown");
    if (code === "token_credit_unmetered") return t("credits.unmetered");
  }
  return errorText(cause, fallback);
}

/**
 * The account's own balance: fetched on mount and window focus, then polled every 15 s only while
 * the page is visible and the server reports an active operation. Nothing is cached in storage.
 */
export function useTokenCreditBalance() {
  const [balance, setBalance] = useState<TokenCreditBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++request.current;
    try {
      const next = await getCreditBalance();
      if (seq !== request.current) return;
      setBalance(next);
      setFailed(false);
    } catch {
      if (seq === request.current) setFailed(true);
    } finally {
      if (seq === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const focus = () => void reload();
    const visibility = () => {
      if (document.visibilityState === "visible") void reload();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [reload]);

  useEffect(() => {
    // A timer that never fetches while idle: the snapshot also refreshes on focus and mount.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if ((balance?.activeOperations ?? 0) > 0) void reload();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [balance?.activeOperations, reload]);

  return { balance, loading, failed, reload };
}
