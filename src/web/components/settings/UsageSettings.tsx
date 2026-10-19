import { useEffect, useState, type CSSProperties } from "react";
import type { GoWindow, UsageRow } from "@shared/types";
import { Select } from "@/components/ui/select";
import { api, formatCost, formatTokens } from "@/lib/api";
import { useData } from "@/state/data";
import { SettingsPage, SettingsSection } from "./SettingsUI";

type Range = "1" | "7" | "30" | "90";

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
    <SettingsPage title="Usage" description="Tokens and estimated cost from your own requests, priced with models.dev rates.">
      <div className="flex justify-end">
        <Select
          className="w-40"
          value={days}
          onValueChange={setDays}
          aria-label="Range"
          options={[
            { value: "1", label: "Last 24 hours" },
            { value: "7", label: "Last 7 days" },
            { value: "30", label: "Last 30 days" },
            { value: "90", label: "Last 90 days" },
          ]}
        />
      </div>

      <SettingsSection>
        <div key={`${days}-${byDay ? "data" : "loading"}`} className="animate-fade-in grid grid-cols-2 divide-x sm:grid-cols-4">
          <Stat label="Cost" value={formatCost(sum(rows, "cost"))} />
          <Stat label="Requests" value={String(sum(rows, "requests"))} />
          <Stat label="Tokens in / out" value={`${formatTokens(input)} / ${formatTokens(sum(rows, "output"))}`} />
          <Stat label="Cache hits" value={`${input ? Math.round((sum(rows, "cacheRead") / input) * 100) : 0}%`} hint="Share of input read from cache" />
        </div>
      </SettingsSection>

      {goConnected && byDay && (
        <SettingsSection
          title="OpenCode Go windows"
          description="Go meters spend per model in rolling windows: 5 hours = 20%, week = 50%, month = 100% of each model's monthly limit. Free models do not count."
        >
          <div key={days} className="animate-fade-in grid grid-cols-3 divide-x">
            {byDay.go.map((w) => (
              <Stat key={w.label} label={w.label} value={formatCost(w.spent)} />
            ))}
          </div>
        </SettingsSection>
      )}

      <SettingsSection title="Daily cost">
        <div className="flex h-40 items-end gap-1 px-4 pt-4 pb-2">
          {rows.length === 0 && <p className="text-muted-foreground animate-fade-in m-auto text-sm">No usage in this range.</p>}
          {rows.map((r, index) => (
            <div key={r.key} className="group relative flex h-full flex-1 flex-col justify-end">
              <div
                className="bg-primary/80 group-hover:bg-primary settings-bar min-h-px rounded-t transition-colors duration-(--motion-fast)"
                style={{ height: `${(r.cost / maxCost) * 100}%`, "--i": index } as CSSProperties}
              />
              <div className="dropdown-glass pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-md border px-2 py-1 text-xs whitespace-nowrap group-hover:block group-hover:animate-fade-in">
                {r.key}: {formatCost(r.cost)} · {r.requests} req
              </div>
            </div>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="By model">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-xs">
            <tr className="text-left">
              <th className="px-4 py-2 font-medium">Model</th>
              <th className="px-2 py-2 text-right font-medium">Requests</th>
              <th className="px-2 py-2 text-right font-medium">In</th>
              <th className="px-2 py-2 text-right font-medium">Cached</th>
              <th className="px-2 py-2 text-right font-medium">Out</th>
              <th className="px-4 py-2 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody key={days} className="divide-y tabular-nums">
            {(byModel?.rows ?? []).map((r, index) => (
              <tr key={r.key} className="stagger animate-rise-in" style={{ "--i": index } as CSSProperties}>
                <td className="max-w-56 truncate px-4 py-2">{nameOf(r.key)}</td>
                <td className="px-2 py-2 text-right">{r.requests}</td>
                <td className="px-2 py-2 text-right">{formatTokens(r.input)}</td>
                <td className="px-2 py-2 text-right">{r.input ? `${Math.round((r.cacheRead / r.input) * 100)}%` : "–"}</td>
                <td className="px-2 py-2 text-right">{formatTokens(r.output)}</td>
                <td className="px-4 py-2 text-right">{formatCost(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SettingsSection>

      <SettingsSection title="By purpose" description="Chat replies, compaction summaries, and title generation.">
        <div key={`${days}-${byKind ? "data" : "loading"}`} className="animate-fade-in grid grid-cols-3 divide-x">
          {(["chat", "compaction", "title"] as const).map((k) => {
            const r = byKind?.rows.find((x) => x.key === k);
            return <Stat key={k} label={k[0]!.toUpperCase() + k.slice(1)} value={formatCost(r?.cost ?? 0)} hint={`${r?.requests ?? 0} requests`} />;
          })}
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}
