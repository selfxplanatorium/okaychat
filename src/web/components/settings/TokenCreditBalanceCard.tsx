import { CircleAlertIcon } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { formatDate, formatNumber } from "@/i18n/format";
import { settingsHref } from "@/lib/settings-link";
import { useTokenCreditBalance } from "@/lib/token-credits";
import { SettingsSection } from "./SettingsUI";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="text-muted-foreground text-xs">{hint}</dd>}
    </div>
  );
}

/**
 * The finite allowance snapshot, shared by Usage and Account. Unlimited accounts render nothing:
 * an absent allowance is not a zero balance. The server remains authoritative, so no debit is
 * applied here and the last good value lives only in this mounted component.
 */
export function TokenCreditBalanceCard({ showUsageLink = true }: { showUsageLink?: boolean }) {
  const { balance, loading, failed, reload } = useTokenCreditBalance();

  if (!balance && !failed && loading) return null;

  if (failed) {
    return (
      <SettingsSection title={t("credits.title")} description={t("credits.manual")}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm">
          <CircleAlertIcon aria-hidden className="text-destructive size-4 shrink-0" />
          <span className="text-muted-foreground min-w-0 flex-1">{t("credits.unavailable")}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void reload()}>
            {t("common.retry")}
          </Button>
        </div>
      </SettingsSection>
    );
  }

  if (!balance || balance.creditTokens === null) return null;

  const unknown = balance.status === "usage_unknown";
  const credit = balance.creditTokens;
  const remaining = balance.remainingTokens ?? 0;
  const overshoot = Math.max(0, balance.consumedTokens - credit);

  return (
    <SettingsSection title={t("credits.title")} description={t("credits.manual")}>
      {unknown && (
        <div className="flex items-start gap-2.5 px-4 py-3">
          <CircleAlertIcon aria-hidden className="text-destructive mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("credits.incomplete")}</p>
            <p className="text-muted-foreground mt-0.5 text-xs">{t("credits.unknown")}</p>
            <p className="text-muted-foreground mt-1 text-xs tabular-nums">
              {t("credits.unknownCount", { count: balance.unknownRequests })}
            </p>
          </div>
        </div>
      )}

      <dl className="grid grid-cols-2 sm:grid-cols-3 sm:divide-x">
        <Stat
          label={unknown ? t("credits.reportedRemaining") : t("credits.remaining")}
          value={formatNumber(remaining)}
        />
        <Stat
          label={unknown ? t("credits.reportedUsed") : t("credits.used")}
          value={formatNumber(balance.consumedTokens)}
        />
        <Stat
          label={t("credits.allowance")}
          value={formatNumber(credit)}
          hint={t("credits.since", { date: formatDate(balance.periodStartedAt) })}
        />
      </dl>

      {overshoot > 0 && (
        <p className="text-muted-foreground px-4 py-3 text-xs tabular-nums">
          {t("credits.overshoot", { count: overshoot })}
        </p>
      )}

      {balance.activeOperations > 0 && (
        <p className="text-muted-foreground px-4 py-3 text-xs">{t("credits.active")}</p>
      )}

      <p className="text-muted-foreground px-4 py-3 text-xs">{t("credits.accounting")}</p>

      {balance.status === "exhausted" && (
        <div className="flex items-start gap-2.5 px-4 py-3">
          <CircleAlertIcon aria-hidden className="text-destructive mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm">{t("credits.exhausted")}</p>
            {showUsageLink && (
              <Link href={settingsHref("usage")} className="text-foreground mt-1 inline-block text-xs underline underline-offset-3">
                {t("usage.title")}
              </Link>
            )}
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
