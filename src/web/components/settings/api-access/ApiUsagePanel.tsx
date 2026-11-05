import type { ApiKeyAuditEvent, ApiKeySummary, ApiRequestState } from "@shared/api-access";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { t, type PlainMessageKey } from "@/i18n";
import { formatCost, formatDateTime, formatNumber, formatTokens } from "@/i18n/format";
import { settingsHref } from "@/lib/settings-link";
import { SettingsSection } from "../SettingsUI";
import type { ApiAccessData } from "./useApiAccessData";

const STATE_KEY: Record<ApiRequestState, PlainMessageKey> = {
  admitted: "apiAccess.requestAdmitted",
  running: "apiAccess.requestRunning",
  succeeded: "apiAccess.requestSucceeded",
  failed: "apiAccess.requestFailed",
  cancelled: "apiAccess.requestCancelled",
  interrupted: "apiAccess.requestInterrupted",
};

const AUDIT_KEY: Record<ApiKeyAuditEvent, PlainMessageKey> = {
  created: "apiAccess.auditCreated",
  revoked: "apiAccess.auditRevoked",
  password_revoked: "apiAccess.auditPasswordRevoked",
  expired: "apiAccess.auditExpired",
};

export function ApiUsagePanel({ data }: { data: ApiAccessData }) {
  const rangeOptions = [
    { value: "1", label: t("usage.last24Hours") },
    { value: "7", label: t("usage.last7Days") },
    { value: "30", label: t("usage.last30Days") },
    { value: "90", label: t("usage.last90Days") },
  ];
  const keyName = (keyId: string | null) => {
    if (keyId === null) return t("apiAccess.otherGroups");
    return data.keys.find((key) => key.id === keyId)?.label ?? t("apiAccess.deletedKey");
  };
  const keyOptions = [
    { value: "", label: t("apiAccess.allKeys") },
    ...data.keys.map((key: ApiKeySummary) => ({ value: key.id, label: key.label })),
  ];
  const usage = data.usage;

  return (
    <div id="setting-api-usage" tabIndex={-1} className="flex scroll-mt-24 flex-col gap-8 outline-none">
      <SettingsSection
        title={t("apiAccess.usage")}
        description={usage ? t("apiAccess.telemetryCoverage", { date: formatDateTime(usage.telemetrySince) }) : undefined}
        action={
          <div className="flex flex-wrap items-end justify-end gap-2">
            <Select
              className="w-36"
              value={String(data.days)}
              onValueChange={(value) => data.setDays(Number(value) as 1 | 7 | 30 | 90)}
              aria-label={t("apiAccess.range")}
              options={rangeOptions}
            />
            <Select
              className="w-40"
              value={data.groupBy}
              onValueChange={(value) => data.setGroupBy(value as "day" | "model" | "key")}
              aria-label={t("apiAccess.groupBy")}
              options={[
                { value: "day", label: t("apiAccess.groupDay") },
                { value: "model", label: t("apiAccess.groupModel") },
                { value: "key", label: t("apiAccess.groupKey") },
              ]}
            />
            <Select
              className="w-40"
              value={data.keyFilter ?? ""}
              onValueChange={(value) => data.setKeyFilter(value || null)}
              aria-label={t("apiAccess.keyFilter")}
              options={keyOptions}
            />
          </div>
        }
      >
        <div className="grid grid-cols-2 divide-x sm:grid-cols-4">
          <Stat label={t("apiAccess.usageCost")} value={formatCost(usage?.totals.cost ?? 0)} />
          <Stat label={t("apiAccess.usageTotals")} value={formatNumber(usage?.totals.meteredRequests ?? 0)} />
          <Stat
            label={t("apiAccess.usageTokens")}
            value={t("usage.tokensInOutValue", {
              input: formatTokens(usage?.totals.usage.input ?? 0),
              output: formatTokens(usage?.totals.usage.output ?? 0),
            })}
          />
          <Stat label={t("apiAccess.requests")} value={formatNumber(usage?.requests.admitted ?? 0)} hint={t("apiAccess.requestCount", { count: usage?.requests.admitted ?? 0 })} />
        </div>
        <p className="text-muted-foreground border-border border-t px-4 py-2 text-xs">{t("apiAccess.recordedCost")}</p>
        {usage && usage.requests.unknownUsage > 0 && (
          <p className="text-muted-foreground border-border border-t px-4 py-2 text-xs">
            {t("apiAccess.notReported")}: {formatNumber(usage.requests.unknownUsage)}
          </p>
        )}
        {data.usageLoading && !usage && <p className="text-muted-foreground px-4 py-6 text-sm">{t("common.loading")}</p>}
        {!data.usageLoading && usage && usage.rows.length === 0 && <p className="text-muted-foreground px-4 py-6 text-sm">{t("apiAccess.noUsage")}</p>}
        {usage && usage.rows.length > 0 && (
          <div data-no-drawer-swipe className="max-w-full overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr className="text-left">
                  <th scope="col" className="px-4 py-2 font-medium">
                    {data.groupBy === "day" ? t("apiAccess.columnDay") : data.groupBy === "model" ? t("apiAccess.columnModel") : t("apiAccess.columnKey")}
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">{t("apiAccess.columnRequests")}</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">{t("apiAccess.columnTokens")}</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">{t("apiAccess.columnCost")}</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y tabular-nums">
                {usage.rows.map((row, index) => (
                  <tr key={`${row.key ?? "other"}-${index}`}>
                    <td className="max-w-56 truncate px-4 py-2">{data.groupBy === "key" ? keyName(row.key) : row.key ?? t("apiAccess.otherGroups")}</td>
                    <td className="px-2 py-2 text-right">{formatNumber(row.meteredRequests)}</td>
                    <td className="px-2 py-2 text-right">
                      {t("usage.tokensInOutValue", { input: formatTokens(row.usage.input), output: formatTokens(row.usage.output) })}
                    </td>
                    <td className="px-4 py-2 text-right">{formatCost(row.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-xs">
          <span className="text-muted-foreground">{t("apiAccess.requestsOpen")}</span>
          <a href={settingsHref("usage")} className="text-primary underline-offset-4 hover:underline">{t("usage.title")}</a>
        </div>
      </SettingsSection>

      <SettingsSection title={t("apiAccess.requests")}>
        {data.requests.length === 0 && <p className="text-muted-foreground px-4 py-6 text-sm">{t("apiAccess.noRequests")}</p>}
        {data.requests.length > 0 && (
          <div data-no-drawer-swipe className="max-w-full overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr className="text-left">
                  <th scope="col" className="px-4 py-2 font-medium">{t("apiAccess.columnModel")}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t("apiAccess.columnStatus")}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t("apiAccess.columnMode")}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t("apiAccess.columnStarted")}</th>
                  <th scope="col" className="px-4 py-2 font-medium">{t("apiAccess.columnTokens")}</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {data.requests.map((request) => (
                  <tr key={request.id}>
                    <td className="max-w-56 truncate px-4 py-2 font-mono text-xs">{request.modelRef}</td>
                    <td className="px-2 py-2 text-xs">
                      {t(STATE_KEY[request.state])}
                      {request.errorCode && <code className="text-muted-foreground ml-1 font-mono text-[0.7rem]">{request.errorCode}</code>}
                    </td>
                    <td className="px-2 py-2 text-xs">{request.stream ? t("apiAccess.streamed") : t("apiAccess.buffered")}</td>
                    <td className="px-2 py-2 text-xs whitespace-nowrap">{formatDateTime(request.startedAt)}</td>
                    <td className="px-4 py-2 text-xs whitespace-nowrap">
                      {request.usage
                        ? t("usage.tokensInOutValue", { input: formatTokens(request.usage.input), output: formatTokens(request.usage.output) })
                        : t("apiAccess.requestUnknownUsage")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-border flex items-center justify-end gap-2 border-t px-4 py-2">
          <Button variant="outline" size="sm" onClick={data.previousRequests} disabled={data.requestsBefore.length === 0}>
            {t("common.previous")}
          </Button>
          <Button variant="outline" size="sm" onClick={data.nextRequests} disabled={!data.requestsCursor}>
            {t("common.next")}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title={t("apiAccess.audit")}>
        {data.audit.length === 0 && <p className="text-muted-foreground px-4 py-6 text-sm">{t("apiAccess.noAudit")}</p>}
        {data.audit.length > 0 && (
          <div data-no-drawer-swipe className="max-w-full overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr className="text-left">
                  <th scope="col" className="px-4 py-2 font-medium">{t("apiAccess.columnEvent")}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t("apiAccess.columnKey")}</th>
                  <th scope="col" className="px-4 py-2 font-medium">{t("apiAccess.columnTime")}</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {data.audit.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-2 text-xs">{t(AUDIT_KEY[row.event])}</td>
                    <td className="px-2 py-2 text-xs">{keyName(row.keyId)}</td>
                    <td className="px-4 py-2 text-xs whitespace-nowrap">{formatDateTime(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-border flex items-center justify-end gap-2 border-t px-4 py-2">
          <Button variant="outline" size="sm" onClick={data.previousAudit} disabled={data.auditBefore.length === 0}>
            {t("common.previous")}
          </Button>
          <Button variant="outline" size="sm" onClick={data.nextAudit} disabled={data.auditCursor === null}>
            {t("common.next")}
          </Button>
        </div>
      </SettingsSection>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </div>
  );
}
