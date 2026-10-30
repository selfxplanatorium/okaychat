import { useEffect, useState, type CSSProperties } from "react";
import type { GoWindow, UsageRow } from "@shared/types";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { t, type PlainMessageKey } from "@/i18n";
import { formatCost, formatNumber, formatPercent, formatTokens } from "@/i18n/format";
import { useData } from "@/state/data";
import { SettingsPage, SettingsSection } from "./SettingsUI";

type Range = "1" | "7" | "30" | "90";

const PURPOSE_LABELS = {
  chat: "usage.purposeChat",
  compaction: "usage.purposeCompaction",
  title: "usage.purposeTitle",
  research: "usage.purposeResearch",
} as const satisfies Record<"chat" | "compaction" | "title" | "research", PlainMessageKey>;

function useUsage(days: Range, groupBy: "day" | "model" | "kind") {
  const [data, setData] = useState<{ rows: UsageRow[]; go: GoWindow[] } | null>(null);
  useEffect(() => {
    void api<{ rows: UsageRow[]; go: GoWindow[] }>(`/usage?days=${days}&groupBy=${groupBy}`).then(setData);
  }, [days, groupBy]);
  return data;
}

const sum = (rows: UsageRow[], key: keyof UsageRow) => rows.reduce((n, r) => n + Number(r[key]), 0);

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </div>
  );
}

export function UsageSettings() {
  const [days, setDays] = useState<Range>("30");
  const byDay = useUsage(days, "day");
  const byModel = useUsage(days, "model");
  const byKind = useUsage(days, "kind");
  const models = useData((s) => s.models);
  const goConnected = useData((s) => s.providers.some((p) => p.id === "opencode-go" && p.connected));

  const rows = byDay?.rows ?? [];
  const input = sum(rows, "input");
  const maxCost = Math.max(0.0001, ...rows.map((r) => r.cost));
  const nameOf = (ref: string) => models.find((m) => m.ref === ref)?.name ?? ref;

  return (
    <SettingsPage title={t("usage.title")} description={t("usage.description")}>
      <div className="flex justify-end">
        <Select
          className="w-40"
          value={days}
          onValueChange={setDays}
          aria-label={t("usage.range")}
          options={[
            { value: "1", label: t("usage.last24Hours") },
            { value: "7", label: t("usage.last7Days") },
            { value: "30", label: t("usage.last30Days") },
            { value: "90", label: t("usage.last90Days") },
          ]}
        />
      </div>

      <SettingsSection>
        <div key={`${days}-${byDay ? "data" : "loading"}`} className="animate-fade-in grid grid-cols-2 divide-x sm:grid-cols-4">
          <Stat label={t("usage.cost")} value={formatCost(sum(rows, "cost"))} />
          <Stat label={t("usage.requests")} value={formatNumber(sum(rows, "requests"))} />
          <Stat label={t("usage.tokensInOut")} value={t("usage.tokensInOutValue", { input: formatTokens(input), output: formatTokens(sum(rows, "output")) })} />
          <Stat label={t("usage.cacheHits")} value={formatPercent(input ? sum(rows, "cacheRead") / input : 0)} hint={t("usage.cacheHitsHint")} />
        </div>
      </SettingsSection>

      {goConnected && byDay && (
        <SettingsSection
          title={t("usage.goWindows")}
          description={t("usage.goWindowsDescription")}
        >
          <div key={days} className="animate-fade-in grid grid-cols-3 divide-x">
            {byDay.go.map((w) => (
              <Stat key={w.label} label={w.label} value={formatCost(w.spent)} />
            ))}
          </div>
        </SettingsSection>
      )}

      <SettingsSection title={t("usage.dailyCost")}>
        <div className="flex h-40 items-end gap-1 px-4 pt-4 pb-2">
          {rows.length === 0 && <p className="text-muted-foreground animate-fade-in m-auto text-sm">{t("usage.noUsage")}</p>}
          {rows.map((r, index) => (
            // Focusable, so the per-day figure is reachable without a pointer too.
            <div key={r.key} tabIndex={0} aria-label={t("usage.dayFigure", { day: r.key, cost: formatCost(r.cost), count: r.requests })} className="group relative flex h-full flex-1 flex-col justify-end rounded-t outline-none focus-visible:ring-1 focus-visible:ring-ring">
              <div
                className="bg-primary/80 group-hover:bg-primary settings-bar min-h-px rounded-t transition-colors duration-(--motion-fast)"
                style={{ height: `${(r.cost / maxCost) * 100}%`, "--i": index } as CSSProperties}
              />
              <div className="dropdown-glass pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-md border px-2 py-1 text-xs whitespace-nowrap group-hover:block group-hover:animate-fade-in group-focus-visible:block">
                {t("usage.dayTooltip", { day: r.key, cost: formatCost(r.cost), count: r.requests })}
              </div>
            </div>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={t("usage.byModel")}>
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-xs">
            <tr className="text-left">
              <th className="px-4 py-2 font-medium">{t("usage.model")}</th>
              <th className="px-2 py-2 text-right font-medium">{t("usage.requests")}</th>
              <th className="px-2 py-2 text-right font-medium">{t("usage.input")}</th>
              <th className="px-2 py-2 text-right font-medium">{t("usage.cached")}</th>
              <th className="px-2 py-2 text-right font-medium">{t("usage.output")}</th>
              <th className="px-4 py-2 text-right font-medium">{t("usage.cost")}</th>
            </tr>
          </thead>
          <tbody key={days} className="divide-y tabular-nums">
            {(byModel?.rows ?? []).map((r, index) => (
              <tr key={r.key} className="stagger animate-rise-in" style={{ "--i": index } as CSSProperties}>
                <td className="max-w-56 truncate px-4 py-2">{nameOf(r.key)}</td>
                <td className="px-2 py-2 text-right">{formatNumber(r.requests)}</td>
                <td className="px-2 py-2 text-right">{formatTokens(r.input)}</td>
                <td className="px-2 py-2 text-right">{r.input ? formatPercent(r.cacheRead / r.input) : "–"}</td>
                <td className="px-2 py-2 text-right">{formatTokens(r.output)}</td>
                <td className="px-4 py-2 text-right">{formatCost(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SettingsSection>

      <SettingsSection title={t("usage.byPurpose")} description={t("usage.byPurposeDescription")}>
        <div key={`${days}-${byKind ? "data" : "loading"}`} className="animate-fade-in grid grid-cols-2 divide-x sm:grid-cols-4">
          {(["chat", "compaction", "title", "research"] as const).map((k) => {
            const r = byKind?.rows.find((x) => x.key === k);
            return <Stat key={k} label={t(PURPOSE_LABELS[k])} value={formatCost(r?.cost ?? 0)} hint={t("usage.requestCount", { count: r?.requests ?? 0 })} />;
          })}
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}
