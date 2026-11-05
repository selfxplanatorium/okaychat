import { useMemo, useState } from "react";
import { Link } from "wouter";
import { BracesIcon, CalculatorIcon, CodeIcon, DatabaseIcon, GlobeIcon, PlusIcon, WrenchIcon } from "lucide-react";
import type { CustomToolIcon, ToolSummary } from "@shared/custom-tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import { customToolsHref } from "@/lib/custom-tool-link";
import { api } from "@/lib/api";
import { RUN_STATE_KEY } from "./custom-tool-keys";

const ICON = {
  wrench: WrenchIcon,
  code: CodeIcon,
  globe: GlobeIcon,
  calculator: CalculatorIcon,
  database: DatabaseIcon,
  "file-json": BracesIcon,
} satisfies Record<CustomToolIcon, typeof WrenchIcon>;

export function CustomToolList({ items, onChanged, navigate }: { items: ToolSummary[]; onChanged: () => void; navigate: (href: string) => void }) {
  const [query, setQuery] = useState("");
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return items.filter((item) => (!enabledOnly || item.enabled) && (!needle || `${item.name} ${item.description}`.toLocaleLowerCase().includes(needle)));
  }, [items, query, enabledOnly]);

  const toggle = async (item: ToolSummary, enabled: boolean) => {
    setBusy(item.id);
    try {
      await api(`custom-tools/${encodeURIComponent(item.id)}/enabled`, { method: "PATCH", json: { expectedRevision: item.revision, enabled } });
      onChanged();
    } catch {
      // The row keeps its stored state; a failed CAS must never look applied.
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label={t("customTools.search")} placeholder={t("customTools.search")} value={query} onChange={(event) => setQuery(event.target.value)} className="max-w-60" />
        <label className="flex items-center gap-2 text-sm">
          <Switch aria-label={t("customTools.enabledOnly")} checked={enabledOnly} onCheckedChange={setEnabledOnly} />
          {t("customTools.enabledOnly")}
        </label>
        <div className="flex-1" />
        <Button type="button" size="sm" onClick={() => navigate(customToolsHref({ newKind: "python" }))} data-command="customTools.createPython">
          <PlusIcon className="size-4" /> {t("customTools.createPython")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => navigate(customToolsHref({ newKind: "http" }))} data-command="customTools.createHttp">
          <PlusIcon className="size-4" /> {t("customTools.createHttp")}
        </Button>
      </div>
      {visible.length === 0 ? (
        <div className="flex flex-col items-center py-14 text-center">
          <WrenchIcon aria-hidden className="text-muted-foreground mb-4 size-8" />
          <h2 className="text-base font-medium">{t("customTools.emptyTitle")}</h2>
          <p className="text-muted-foreground mt-2 max-w-xs text-sm">{t("customTools.emptyBody")}</p>
        </div>
      ) : (
        <ul className="grid gap-2">
          {visible.map((item) => {
            const Icon = ICON[item.icon] ?? WrenchIcon;
            return (
              <li key={item.id} className="flex items-center gap-3 rounded-lg border p-3">
                <Link href={customToolsHref({ toolId: item.id })} aria-label={t("customTools.openTool", { name: item.name })} className="hover:bg-muted/40 flex min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-1">
                  <Icon aria-hidden className="text-muted-foreground size-5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.name}</span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {item.kind === "python" ? t("customTools.python") : t("customTools.http")} · {t("customTools.revision", { revision: item.revision })}
                      {item.lastRun ? ` · ${t(RUN_STATE_KEY[item.lastRun.state])}` : ` · ${t("customTools.noResult")}`}
                      {item.invalid ? ` · ${t("customTools.invalidSchema")}` : ""}
                    </span>
                  </span>
                </Link>
                <Switch aria-label={`${t("customTools.enabled")}: ${item.name}`} checked={item.enabled} loading={busy === item.id} disabled={busy === item.id || item.invalid} onCheckedChange={(enabled) => void toggle(item, enabled)} />
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-muted-foreground text-xs">{t("customTools.selectedPresetNotice")}</p>
      <p className="text-muted-foreground text-xs">{t("customTools.executions")}: {items.reduce((sum, item) => sum + item.counters.attempts, 0)}</p>
      <div className="text-muted-foreground flex flex-wrap gap-3 text-xs">
        <span>{t("customTools.attempts")}: {items.reduce((sum, item) => sum + item.counters.attempts, 0)}</span>
        <span>{t("customTools.succeeded")}: {items.reduce((sum, item) => sum + item.counters.succeeded, 0)}</span>
        <span>{t("customTools.failed")}: {items.reduce((sum, item) => sum + item.counters.failed, 0)}</span>
        <span>{t("customTools.cancelled")}: {items.reduce((sum, item) => sum + item.counters.cancelled, 0)}</span>
        <span>{t("customTools.unknown")}: {items.reduce((sum, item) => sum + item.counters.unknown, 0)}</span>
      </div>
      <Button type="button" size="sm" variant="ghost" className="w-fit" onClick={onChanged}>{t("customTools.refresh")}</Button>
    </div>
  );
}
