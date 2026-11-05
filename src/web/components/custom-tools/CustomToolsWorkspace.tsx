import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { WrenchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { useData } from "@/state/data";
import { useCustomTools } from "@/state/custom-tools";
import { useCommand } from "@/keyboard/registry";
import { api } from "@/lib/api";
import { customToolsHref, parseCustomToolsLink } from "@/lib/custom-tool-link";
import { CustomToolEditor } from "./CustomToolEditor";
import { CustomToolList } from "./CustomToolList";

export function CustomToolsWorkspace({ search }: { search: string }) {
  const me = useData((state) => state.me);
  const [, navigate] = useLocation();
  const feature = useCustomTools((state) => state.feature);
  const items = useCustomTools((state) => state.items);
  const cleanup = useCustomTools((state) => state.cleanup);
  const detail = useCustomTools((state) => state.detail);
  const loading = useCustomTools((state) => state.loading);
  const error = useCustomTools((state) => state.error);
  const link = parseCustomToolsLink(search);
  const userId = me?.id ?? "";

  useEffect(() => {
    if (!userId) return;
    void useCustomTools.getState().load(userId, { detailId: link.toolId });
  }, [userId, link.toolId]);

  useCommand("nav.customTools", () => navigate(customToolsHref()));
  useCommand("customTools.createPython", () => navigate(customToolsHref({ newKind: "python" })));
  useCommand("customTools.createHttp", () => navigate(customToolsHref({ newKind: "http" })));

  if (!me) return null;
  if (loading && feature === null) return <p role="status" aria-live="polite" className="text-muted-foreground p-8 text-sm">{t("common.loading")}</p>;
  if (error && feature === null) return <p role="alert" className="text-destructive p-8 text-sm">{error}</p>;

  if (feature === false) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        <div className="rounded-lg border p-6">
          <h2 className="font-medium">{t("customTools.disabledFeature")}</h2>
          <p className="text-muted-foreground mt-1 text-sm">{t("customTools.cleanup")}</p>
          {cleanup.length > 0 && (
            <ul className="mt-4 grid gap-2">
              {cleanup.map((item) => (
                <li key={item.id} className="flex items-center gap-2 rounded-md border p-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
                  <Button type="button" size="sm" variant="destructive" onClick={() => void api(`custom-tools/${encodeURIComponent(item.id)}`, { method: "DELETE", json: { expectedRevision: item.revision } }).then(() => useCustomTools.getState().load(userId, {}))}>
                    {t("common.delete")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  if (link.invalid) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        <p role="alert" className="text-sm">{t("customTools.notFound")}</p>
        <Link href={customToolsHref()} className="text-muted-foreground hover:text-foreground mt-2 inline-block text-sm">{t("common.back")}</Link>
      </div>
    );
  }

  if (link.toolId || link.newKind) {
    if (link.toolId && !detail && !loading) {
      return (
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
          <p role="alert" className="text-sm">{t("customTools.notFound")}</p>
          <Link href={customToolsHref()} className="text-muted-foreground hover:text-foreground mt-2 inline-block text-sm">{t("common.back")}</Link>
        </div>
      );
    }
    if (link.toolId && loading && !detail) {
      return <p role="status" aria-live="polite" className="text-muted-foreground p-8 text-sm">{t("common.loading")}</p>;
    }
    return (
      <CustomToolEditor
        key={link.toolId ?? `new-${link.newKind}`}
        userId={userId}
        detail={link.toolId ? detail : null}
        newKind={link.newKind}
        onBack={() => navigate(customToolsHref())}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <h2 className="text-lg font-semibold">{t("customTools.title")}</h2>
      <p className="text-muted-foreground mb-4 text-sm">{t("customTools.intro")}</p>
      {error && <p role="alert" className="text-destructive mb-3 text-sm">{error}</p>}
      {loading && <p role="status" aria-live="polite" className="text-muted-foreground mb-3 text-sm">{t("common.loading")}</p>}
      {items.length === 0 && !loading ? (
        <div className="flex flex-col items-center py-14 text-center">
          <WrenchIcon aria-hidden className="text-muted-foreground mb-4 size-8" />
          <h2 className="text-base font-medium">{t("customTools.emptyTitle")}</h2>
          <p className="text-muted-foreground mt-2 max-w-xs text-sm">{t("customTools.emptyBody")}</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button type="button" onClick={() => navigate(customToolsHref({ newKind: "python" }))}>{t("customTools.createPython")}</Button>
            <Button type="button" variant="outline" onClick={() => navigate(customToolsHref({ newKind: "http" }))}>{t("customTools.createHttp")}</Button>
          </div>
        </div>
      ) : (
        <CustomToolList items={items} onChanged={() => void useCustomTools.getState().load(userId, {})} navigate={navigate} />
      )}
    </div>
  );
}
