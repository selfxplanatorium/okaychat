import { RotateCcwIcon } from "lucide-react";
import type { Ref } from "react";
import type { ApiKeySummary, ApiKeyStatus } from "@shared/api-access";
import { Button } from "@/components/ui/button";
import { t, type PlainMessageKey } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { cn } from "@/lib/utils";
import { SettingsSection } from "../SettingsUI";

const STATUS_KEY: Record<ApiKeyStatus, PlainMessageKey> = {
  active: "apiAccess.active",
  expired: "apiAccess.expired",
  revoked: "apiAccess.revoked",
};

const STATUS_CLASS: Record<ApiKeyStatus, string> = {
  active: "text-success",
  expired: "text-muted-foreground",
  revoked: "text-muted-foreground",
};

/** Read-only key cards. There is no secret column and no reveal action: the token is shown once. */
export function ApiKeyList({
  keys,
  loading,
  action,
  onRevoke,
  sectionRef,
}: {
  keys: ApiKeySummary[];
  loading: boolean;
  action: React.ReactNode;
  onRevoke: (key: ApiKeySummary) => void;
  sectionRef: Ref<HTMLDivElement>;
}) {
  return (
    <div ref={sectionRef} id="setting-api-keys" tabIndex={-1} className="scroll-mt-24 outline-none">
      <SettingsSection
        title={t("apiAccess.keys")}
        description={t("apiAccess.recovery")}
        action={action}
      >
        {loading && keys.length === 0 && (
          <p className="text-muted-foreground px-4 py-6 text-sm" aria-live="polite">{t("common.loading")}</p>
        )}
        {!loading && keys.length === 0 && <p className="text-muted-foreground px-4 py-6 text-sm">{t("apiAccess.empty")}</p>}
        <ul className="divide-border flex flex-col divide-y">
          {keys.map((key) => (
            <li key={key.id} className="flex flex-col gap-3 px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium break-words">{key.label}</span>
                    <span className={cn("text-xs font-medium", STATUS_CLASS[key.status])}>{t(STATUS_KEY[key.status])}</span>
                  </div>
                  <code
                    data-no-drawer-swipe
                    className="text-muted-foreground mt-1 block max-w-full overflow-x-auto font-mono text-xs whitespace-nowrap"
                    aria-label={t("apiAccess.prefix")}
                  >
                    {key.prefix}
                  </code>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  className="pointer-coarse:h-11"
                  disabled={key.status === "revoked"}
                  onClick={() => onRevoke(key)}
                  aria-label={t("apiAccess.revokeTitle", { label: key.label })}
                  data-command="apiAccess.revoke"
                >
                  <RotateCcwIcon aria-hidden="true" />
                  {t("apiAccess.revoke")}
                </Button>
              </div>
              <dl className="text-muted-foreground grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                <div className="flex gap-1.5">
                  <dt className="font-medium">{t("apiAccess.scopes")}:</dt>
                  <dd>
                    {key.scopes
                      .map((scope) => t(scope === "models:read" ? "apiAccess.scopeModels" : "apiAccess.scopeChat"))
                      .join(" · ")}
                  </dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="font-medium">{t("apiAccess.columnCreated")}:</dt>
                  <dd>{t("apiAccess.createdAt", { date: formatDateTime(key.createdAt) })}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="font-medium">{t("apiAccess.columnExpiry")}:</dt>
                  <dd>
                    {key.expiresAt === null
                      ? t("apiAccess.noExpiry")
                      : key.status === "expired"
                        ? t("apiAccess.expired")
                        : t("apiAccess.expiresAt", { date: formatDateTime(key.expiresAt) })}
                  </dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="font-medium">{t("apiAccess.columnLastUsed")}:</dt>
                  <dd>{key.lastUsedAt === null ? t("apiAccess.neverUsed") : t("apiAccess.lastUsedAt", { date: formatDateTime(key.lastUsedAt) })}</dd>
                </div>
                {key.revokedAt !== null && (
                  <div className="flex gap-1.5">
                    <dt className="font-medium">{t("apiAccess.revoked")}:</dt>
                    <dd>{formatDateTime(key.revokedAt)}</dd>
                  </div>
                )}
              </dl>
            </li>
          ))}
        </ul>
      </SettingsSection>
    </div>
  );
}
