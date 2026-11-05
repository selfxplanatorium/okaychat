import { useRef, useState } from "react";
import { PlusIcon } from "lucide-react";
import type { ApiKeySummary, CreateApiKeyResult } from "@shared/api-access";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { SettingsPage } from "../SettingsUI";
import { ApiDocsPanel } from "./ApiDocsPanel";
import { ApiKeyCreatedDialog } from "./ApiKeyCreatedDialog";
import { ApiKeyList } from "./ApiKeyList";
import { ApiUsagePanel } from "./ApiUsagePanel";
import { CreateApiKeyDialog } from "./CreateApiKeyDialog";
import { RevokeApiKeyDialog } from "./RevokeApiKeyDialog";
import { useApiAccessData } from "./useApiAccessData";

const ERROR_KEY = {
  loadFailed: "apiAccess.loadFailed",
  createFailed: "apiAccess.createFailed",
  revokeFailed: "apiAccess.revokeFailed",
} as const;

/** Settings → API access. Everything here is page-local state; no secret is persisted anywhere. */
export function ApiAccessSettings() {
  const data = useApiAccessData();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateApiKeyResult | null>(null);
  const [revoking, setRevoking] = useState<ApiKeySummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const section = useRef<HTMLDivElement>(null);
  const onCreated = (result: CreateApiKeyResult) => {
    setCreating(false);
    setCreated(result);
    setNotice(null);
  };

  const onRevoke = async (key: ApiKeySummary) => {
    await data.revokeKey(key.id);
    setRevoking(null);
    setNotice(t("apiAccess.revokedNotice"));
    // Return focus to the section after the row's action changed state.
    requestAnimationFrame(() => section.current?.focus());
  };

  return (
    <SettingsPage title={t("apiAccess.title")} description={t("apiAccess.description")}>
      {!data.enabled && !data.loading && (
        <p role="status" className="bg-muted/60 text-foreground rounded-xl border border-transparent px-4 py-3 text-sm">
          {t("apiAccess.disabled")}
        </p>
      )}
      <div aria-live="polite" aria-atomic="true" className="min-h-5 text-sm">
        {notice && <p className="text-success">{notice}</p>}
        {data.error && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-destructive">{t(ERROR_KEY[data.error])}</p>
            <Button variant="outline" size="sm" onClick={data.refresh}>{t("common.retry")}</Button>
          </div>
        )}
      </div>

      <ApiKeyList
        keys={data.keys}
        loading={data.loading}
        sectionRef={section}
        onRevoke={setRevoking}
        action={
          <Button size="sm" className="pointer-coarse:h-11" onClick={() => setCreating(true)} disabled={!data.enabled} data-command="apiAccess.create">
            <PlusIcon aria-hidden="true" />
            {t("apiAccess.create")}
          </Button>
        }
      />

      <ApiUsagePanel data={data} />
      <ApiDocsPanel />

      <CreateApiKeyDialog
        open={creating}
        serverTime={data.serverTime}
        onOpenChange={setCreating}
        onCreate={data.createKey}
        onCreated={onCreated}
      />
      <ApiKeyCreatedDialog result={created} onClose={() => setCreated(null)} />
      <RevokeApiKeyDialog keyToRevoke={revoking} onOpenChange={(open) => { if (!open) setRevoking(null); }} onRevoke={onRevoke} />
    </SettingsPage>
  );
}
