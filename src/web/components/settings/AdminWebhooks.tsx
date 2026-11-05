import { useCallback, useEffect, useState } from "react";
import type { AdminWebhookPage } from "@shared/outgoing-webhooks";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { t } from "@/i18n";
import { formatDateTime, formatNumber } from "@/i18n/format";
import { SettingsSection } from "./SettingsUI";

/**
 * Admin metadata only: counts and states. No name, hostname, URL, header, secret, body, or source id
 * crosses this boundary, so an administrator can see queue pressure without reading anyone's data.
 */
export function AdminWebhooks() {
  const [page, setPage] = useState<AdminWebhookPage | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api<AdminWebhookPage>("/admin/webhooks?limit=50");
      setPage(next);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SettingsSection
      title={t("admin.webhooksTitle")}
      description={t("admin.webhooksDescription")}
      action={<Button variant="outline" size="sm" className="pointer-coarse:h-11" onClick={() => void load()} disabled={loading}>{t("admin.webhooksRefresh")}</Button>}
    >
      {error && <p role="alert" className="text-destructive px-4 py-3 text-sm">{t("webhooks.loadFailed")}</p>}
      {!error && page && (
        <>
          <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 px-4 py-2 text-xs">
            <span>{t("admin.webhooksTotals", { active: page.totals.active, dead: page.totals.dead, dropped: page.totals.dropped })}</span>
            {page.totals.lastPumpAt !== null && <span>{formatDateTime(page.totals.lastPumpAt)}</span>}
          </div>
          {!page.items.length ? (
            <p className="text-muted-foreground px-4 py-3 text-sm">{t("admin.webhooksEmpty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-start text-xs">
                <thead className="text-muted-foreground border-border border-b">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">{t("admin.webhooksEndpoint")}</th>
                    <th scope="col" className="px-3 py-2 font-medium">{t("admin.webhooksOwner")}</th>
                    <th scope="col" className="px-3 py-2 font-medium">{t("admin.webhooksState")}</th>
                    <th scope="col" className="px-3 py-2 font-medium">{t("admin.webhooksPending")}</th>
                    <th scope="col" className="px-3 py-2 font-medium">{t("admin.webhooksDead")}</th>
                    <th scope="col" className="px-3 py-2 font-medium">{t("admin.webhooksDropped")}</th>
                    <th scope="col" className="px-3 py-2 font-medium">{t("admin.webhooksOldest")}</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {page.items.map((item) => (
                    <tr key={item.endpointId}>
                      <td className="px-4 py-2 font-mono">{item.endpointId}</td>
                      <td className="px-3 py-2 font-mono">{item.ownerId}</td>
                      <td className="px-3 py-2">
                        {item.enabled ? t("webhooks.enabledLabel") : item.autoDisabledAt ? t("admin.webhooksAutoDisabled") : t("webhooks.disabledLabel")}
                      </td>
                      <td className="px-3 py-2">{formatNumber(item.pendingCount)}</td>
                      <td className="px-3 py-2">{formatNumber(item.deadCount)}</td>
                      <td className="px-3 py-2">{formatNumber(item.droppedCount)}</td>
                      <td className="px-3 py-2">{item.oldestPendingAt ? formatDateTime(item.oldestPendingAt) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </SettingsSection>
  );
}
