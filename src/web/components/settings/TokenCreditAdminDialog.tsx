import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TokenCreditAuditEntry, TokenCreditBalance } from "@shared/token-credits";
import type { AdminUser } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { formatDate, formatDateTime, formatNumber } from "@/i18n/format";
import { ApiError } from "@/lib/api";
import {
  creditActionKey,
  creditAmountText,
  creditErrorText,
  creditMutationId,
  getAdminCreditBalance,
  getCreditAudit,
  parseCreditAmount,
  resetAdminCredit,
  setAdminCredit,
} from "@/lib/token-credits";
import { useDirectory } from "./Audience";

type Busy = "save" | "reset" | "more" | null;

function Snapshot({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm font-semibold break-words tabular-nums">{value}</dd>
      {hint && <dd className="text-muted-foreground mt-0.5 text-xs">{hint}</dd>}
    </div>
  );
}

function AuditHistory({
  entries,
  cursor,
  busy,
  onMore,
}: {
  entries: TokenCreditAuditEntry[];
  cursor: number | null;
  busy: boolean;
  onMore: () => void;
}) {
  const { users } = useDirectory();
  const actorName = (actorId: string | null) => {
    if (!actorId) return t("credits.deletedActor");
    return users.find((candidate) => candidate.id === actorId)?.name ?? t("credits.deletedActor");
  };
  return (
    <section className="grid gap-2 border-t pt-4" aria-label={t("credits.audit")}>
      <h3 className="text-sm font-medium">{t("credits.audit")}</h3>
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t("credits.auditEmpty")}</p>
      ) : (
        <ScrollArea className="max-h-64" viewportProps={{ tabIndex: 0 }}>
          <ul aria-label={t("credits.audit")} className="flex flex-col gap-2 pe-3">
            {entries.map((entry) => (
              <AuditRow key={entry.id} entry={entry} actor={actorName(entry.actorId)} />
            ))}
          </ul>
        </ScrollArea>
      )}
      {cursor !== null && (
        <Button type="button" size="sm" variant="outline" className="self-start" disabled={busy} onClick={onMore}>
          {busy && <Loader2Icon className="animate-spin" />}
          {t("common.loadMore")}
        </Button>
      )}
    </section>
  );
}

function AuditRow({ entry, actor }: { entry: TokenCreditAuditEntry; actor: string }) {
  return (
    <li className="bg-muted/40 rounded-lg px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-medium">{t(creditActionKey(entry.action))}</span>
        <time dateTime={new Date(entry.createdAt).toISOString()} className="text-muted-foreground tabular-nums">
          {formatDateTime(entry.createdAt)}
        </time>
      </div>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        <dt className="text-muted-foreground">{t("credits.change")}</dt>
        <dd className="min-w-0 break-words tabular-nums">
          {creditAmountText(entry.before.creditTokens)} → {creditAmountText(entry.after.creditTokens)}
        </dd>
        <dt className="text-muted-foreground">{t("credits.used")}</dt>
        <dd className="tabular-nums">
          {formatNumber(entry.before.consumedTokens)} → {formatNumber(entry.after.consumedTokens)}
        </dd>
        <dd className="text-muted-foreground col-span-2 tabular-nums">{t("credits.period", { period: entry.after.period })}</dd>
        <dd className="text-muted-foreground col-span-2 tabular-nums">{t("credits.unknownCount", { count: entry.after.unknownRequests })}</dd>
        <dt className="text-muted-foreground">{t("credits.actor")}</dt>
        <dd className="min-w-0 break-words">{actor}</dd>
        <dt className="text-muted-foreground">{t("credits.reason")}</dt>
        <dd className="min-w-0 break-words">{entry.reason}</dd>
      </dl>
    </li>
  );
}

/**
 * Admin configuration for one account's manual token allowance. Every open fetches a fresh
 * snapshot and the first audit page; mutations compare-and-set on the fetched version. A conflict
 * refreshes the visible values without discarding the administrator's unsaved fields.
 */
export function TokenCreditAdminDialog({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const [shown, setShown] = useState(user);
  const [balance, setBalance] = useState<TokenCreditBalance | null>(null);
  const [audit, setAudit] = useState<TokenCreditAuditEntry[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [unlimited, setUnlimited] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [resetReason, setResetReason] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef(0);
  const mutation = useRef<{ key: string; id: string } | null>(null);
  const previousUser = useRef<AdminUser | null>(null);
  const [openSeq, setOpenSeq] = useState(0);

  // A fresh open always reloads, even when the same row is picked again: the last dialog state is
  // kept only so the close animation has content.
  if (user !== previousUser.current) {
    previousUser.current = user;
    if (user) {
      setShown(user);
      setBalance(null);
      setAudit([]);
      setCursor(null);
      setLoadFailed(false);
      setLoading(true);
      setUnlimited(false);
      setAmount("");
      setReason("");
      setResetOpen(false);
      setResetReason("");
      setAcknowledge(false);
      setError(null);
      setNotice(null);
      mutation.current = null;
      setOpenSeq((seq) => seq + 1);
    }
  }

  const load = useCallback(async (userId: string, keepDraft: boolean) => {
    const seq = ++request.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const next = await getAdminCreditBalance(userId);
      if (seq !== request.current) return;
      setBalance(next);
      if (!keepDraft) {
        setUnlimited(next.creditTokens === null);
        setAmount(next.creditTokens === null ? "" : String(next.creditTokens));
      }
      // Editing must not wait for history, and a history failure must not hide a usable balance.
      if (seq === request.current) setLoading(false);
      const page = await getCreditAudit(userId).catch(() => null);
      if (seq !== request.current || !page) return;
      setAudit(page.rows);
      setCursor(page.nextCursor);
    } catch {
      if (seq === request.current) setLoadFailed(true);
    } finally {
      if (seq === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (openSeq > 0 && shown) void load(shown.id, false);
  }, [openSeq, shown, load]);

  const mutationId = (key: string) => {
    if (mutation.current?.key === key) return mutation.current.id;
    const id = creditMutationId();
    mutation.current = { key, id };
    return id;
  };

  const refreshAudit = async (userId: string) => {
    try {
      const page = await getCreditAudit(userId);
      setAudit(page.rows);
      setCursor(page.nextCursor);
    } catch {
      // The mutation already succeeded; a stale history is better than a false failure.
    }
  };

  const closeable = busy === null;

  const save = async () => {
    if (!shown || !balance || busy || balance.activeOperations > 0) return;
    const credit = unlimited ? null : parseCreditAmount(amount);
    if (credit === undefined) return setError(t("credits.invalid"));
    const cleanReason = reason.trim();
    if (!cleanReason) return setError(t("credits.reasonRequired"));

    setBusy("save");
    setError(null);
    setNotice(null);
    const key = JSON.stringify({ credit, version: balance.version, reason: cleanReason });
    try {
      const result = await setAdminCredit(shown.id, {
        creditTokens: credit,
        expectedVersion: balance.version,
        mutationId: mutationId(key),
        reason: cleanReason,
      });
      mutation.current = null;
      setBalance(result.balance);
      setUnlimited(result.balance.creditTokens === null);
      setAmount(result.balance.creditTokens === null ? "" : String(result.balance.creditTokens));
      setReason("");
      setNotice(t("credits.saved"));
      void refreshAudit(shown.id);
    } catch (cause) {
      const code = cause instanceof ApiError ? String(cause.code) : "";
      if (code === "conflict") {
        setError(t("credits.conflict"));
        await load(shown.id, true);
      } else if (code === "token_credit_busy") {
        setError(t("credits.busy"));
        await load(shown.id, true);
      } else {
        setError(creditErrorText(cause, "credits.unavailable"));
      }
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    if (!shown || !balance || busy || balance.activeOperations > 0) return;
    const cleanReason = resetReason.trim();
    if (!cleanReason) return setError(t("credits.reasonRequired"));
    if (balance.unknownRequests > 0 && !acknowledge) return setError(t("credits.acknowledgeRequired"));

    setBusy("reset");
    setError(null);
    setNotice(null);
    const key = JSON.stringify({ reset: balance.version, reason: cleanReason, acknowledge });
    try {
      const result = await resetAdminCredit(shown.id, {
        expectedVersion: balance.version,
        mutationId: mutationId(key),
        reason: cleanReason,
        acknowledgeUnknown: acknowledge,
      });
      mutation.current = null;
      setBalance(result.balance);
      setUnlimited(result.balance.creditTokens === null);
      setAmount(result.balance.creditTokens === null ? "" : String(result.balance.creditTokens));
      setResetOpen(false);
      setResetReason("");
      setAcknowledge(false);
      setNotice(t("credits.saved"));
      void refreshAudit(shown.id);
    } catch (cause) {
      const code = cause instanceof ApiError ? String(cause.code) : "";
      if (code === "conflict") {
        setError(t("credits.conflict"));
        await load(shown.id, true);
      } else if (code === "token_credit_busy") {
        setError(t("credits.busy"));
        await load(shown.id, true);
      } else {
        setError(creditErrorText(cause, "credits.unavailable"));
      }
    } finally {
      setBusy(null);
    }
  };

  const loadMore = async () => {
    if (!shown || cursor === null || busy) return;
    setBusy("more");
    setError(null);
    try {
      const page = await getCreditAudit(shown.id, cursor);
      setAudit((rows) => [...rows, ...page.rows]);
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(creditErrorText(cause, "credits.unavailable"));
    } finally {
      setBusy(null);
    }
  };

  const canMutate = !!balance && !loading && busy === null && balance.activeOperations === 0;

  return (
    <Dialog open={user !== null} onOpenChange={(next) => !next && closeable && onClose()}>
      <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">{t("credits.title")}</DialogTitle>
          <DialogDescription>
            {shown ? `${shown.name} · ${shown.email}` : ""}
          </DialogDescription>
        </DialogHeader>

        {!shown ? null : loading && !balance ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2Icon aria-hidden className="size-4 animate-spin" />
            {t("common.loading")}
          </p>
        ) : loadFailed && !balance ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted-foreground min-w-0 flex-1">{t("credits.unavailable")}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void load(shown.id, false)}>
              {t("common.retry")}
            </Button>
          </div>
        ) : balance ? (
          <>
            <dl className="bg-muted/40 grid grid-cols-2 gap-3 rounded-lg border px-3 py-2.5 sm:grid-cols-3">
              <Snapshot label={t("credits.allowance")} value={creditAmountText(balance.creditTokens)} />
              <Snapshot label={t("credits.used")} value={formatNumber(balance.consumedTokens)} />
              <Snapshot
                label={t("credits.remaining")}
                value={balance.remainingTokens === null ? t("credits.unlimited") : formatNumber(balance.remainingTokens)}
              />
              <div className="text-muted-foreground col-span-full flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <span>{t("credits.since", { date: formatDate(balance.periodStartedAt) })}</span>
                <span>{t("credits.manual")}</span>
                {balance.unknownRequests > 0 && <span className="tabular-nums">{t("credits.unknownCount", { count: balance.unknownRequests })}</span>}
                {balance.creditTokens !== null && balance.consumedTokens > balance.creditTokens && (
                  <span className="tabular-nums">{t("credits.overshoot", { count: balance.consumedTokens - balance.creditTokens })}</span>
                )}
                {balance.activeOperations > 0 && <span>{t("credits.active")}</span>}
              </div>
            </dl>

            <form
              id="credit-edit-form"
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <label htmlFor="credit-amount" className="text-sm font-medium">
                {t("credits.edit")}
              </label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  id="credit-amount"
                  className="sm:max-w-56"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="off"
                  value={amount}
                  disabled={unlimited || busy !== null}
                  aria-describedby="credit-allowance-help"
                  onChange={(event) => setAmount(event.currentTarget.value)}
                />
                <label className="flex min-h-9 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="accent-primary size-4"
                    checked={unlimited}
                    disabled={busy !== null}
                    onChange={(event) => setUnlimited(event.currentTarget.checked)}
                  />
                  {t("credits.unlimited")}
                </label>
              </div>
              <div id="credit-allowance-help" className="text-muted-foreground grid gap-1 text-xs">
                <p>{t("credits.keepUsed")}</p>
                {unlimited && <p>{t("credits.clearNote")}</p>}
              </div>
              {balance.creditTokens === null && balance.unknownRequests > 0 && !unlimited && (
                <p className="text-destructive text-xs">{t("credits.unknownHold")}</p>
              )}

              <label htmlFor="credit-reason" className="mt-1 text-sm font-medium">
                {t("credits.reason")}
              </label>
              <Textarea
                id="credit-reason"
                className="min-h-14"
                value={reason}
                maxLength={500}
                disabled={busy !== null}
                onChange={(event) => setReason(event.currentTarget.value)}
              />

              <div className="bg-muted/40 rounded-lg border px-3 py-2 text-xs">
                <p className="font-medium">{t("credits.restrictions")}</p>
                <p className="text-muted-foreground mt-1">{t("credits.keywordOnly")}</p>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={!canMutate || busy === "save"}>
                  {busy === "save" && <Loader2Icon className="animate-spin" />}
                  {t("common.save")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canMutate || resetOpen}
                  onClick={() => {
                    setResetOpen(true);
                    setResetReason("");
                    setAcknowledge(false);
                    setError(null);
                  }}
                >
                  {t("credits.reset")}
                </Button>
              </div>
            </form>

            {resetOpen && (
              <div role="group" aria-labelledby="credit-reset-title" className="border-destructive/30 bg-destructive/5 grid gap-2 rounded-lg border px-3 py-3">
                <p id="credit-reset-title" className="text-sm font-medium">
                  {t("credits.reset")}
                </p>
                <p className="text-sm">{t("credits.resetConfirm", { used: formatNumber(balance.consumedTokens) })}</p>
                <dl className="text-muted-foreground grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <dt>{t("credits.used")}</dt>
                    <dd className="text-foreground tabular-nums">{formatNumber(balance.consumedTokens)} → 0</dd>
                  </div>
                  <div>
                    <dt>{t("credits.allowance")}</dt>
                    <dd className="text-foreground tabular-nums">{creditAmountText(balance.creditTokens)}</dd>
                  </div>
                  <div>
                    <dt>{t("credits.period", { period: balance.period })}</dt>
                    <dd className="text-foreground tabular-nums">→ {t("credits.period", { period: balance.period + 1 })}</dd>
                  </div>
                </dl>
                <p className="text-muted-foreground text-xs">{t("credits.resetNote")}</p>
                <label htmlFor="credit-reset-reason" className="mt-1 text-sm font-medium">
                  {t("credits.reason")}
                </label>
                <Textarea
                  id="credit-reset-reason"
                  className="min-h-14"
                  value={resetReason}
                  maxLength={500}
                  disabled={busy !== null}
                  onChange={(event) => setResetReason(event.currentTarget.value)}
                />
                {balance.unknownRequests > 0 && (
                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="accent-primary mt-0.5 size-4 shrink-0"
                      checked={acknowledge}
                      disabled={busy !== null}
                      onChange={(event) => setAcknowledge(event.currentTarget.checked)}
                    />
                    {t("credits.acknowledgeUnknown")}
                  </label>
                )}
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => {
                      setResetOpen(false);
                      setResetReason("");
                      setAcknowledge(false);
                      setError(null);
                    }}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button type="button" variant="destructive" size="sm" disabled={!canMutate || busy === "reset"} onClick={() => void reset()}>
                    {busy === "reset" && <Loader2Icon className="animate-spin" />}
                    {t("credits.reset")}
                  </Button>
                </div>
              </div>
            )}

            <AuditHistory entries={audit} cursor={cursor} busy={busy === "more"} onMore={() => void loadMore()} />
          </>
        ) : null}

        <div aria-live="polite" aria-atomic="true" className="min-h-5 text-sm">
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : (
            <p className="text-muted-foreground">{notice}</p>
          )}
        </div>

        <DialogFooter>
          <DialogClose type="button" disabled={!closeable} render={<Button variant="outline" />}>
            {t("common.close")}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
