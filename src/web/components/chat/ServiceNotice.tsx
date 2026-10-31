import { useAui, useAuiState } from "@assistant-ui/react";
import { CircleAlertIcon, RefreshCwIcon, SettingsIcon, XIcon } from "lucide-react";
import { useEffect } from "react";
import { Link } from "wouter";
import type { ServiceId } from "@shared/services";
import { t } from "@/i18n";
import { settingsHref } from "@/lib/settings-link";
import { useCommand } from "@/keyboard/registry";
import { markUsedServices, useServices } from "@/state/services";
import {
  FIX_KEYS,
  FIX_SETTINGS,
  REASON_KEYS,
  TURN_REASON_KEYS,
  availabilityOf,
  noticeServices,
  serviceNameKey,
  usedServicesFromParts,
  type ToolPartLike,
} from "@/state/services-derive";
import { metadataOf } from "@/state/context-usage";
import { parseTurnUnavailable } from "@shared/services";

// Two quiet surfaces for service outages:
// - ServiceNotice: one dismissible line, only for a service this session actually used.
// - TurnServiceNote: the one-line reason a reply was missing tools, stored on that reply.
// Neither polls. The store refreshes on focus and after a failed request. See
// docs/implementation/service-health.md.

/** Refreshes the registry when the tab regains focus or an action reported an outage. Mounted once. */
export function ServiceHealthWatcher() {
  useEffect(() => {
    const refresh = () => void useServices.getState().refresh();
    const failed = () => void useServices.getState().refresh(true);
    window.addEventListener("focus", refresh);
    window.addEventListener("okaychat:service-failed", failed);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("okaychat:service-failed", failed);
    };
  }, []);
  return null;
}

/**
 * Marks services a running reply actually used, as its tool parts appear. Stored history is never scanned,
 * so reopening an old chat does not raise a notice. Mounted once inside the runtime.
 */
export function ServiceUsageWatcher() {
  const aui = useAui();
  const running = useAuiState((s) => s.thread.isRunning);
  // Part types and tool states, not text: the signature changes when a call starts, finishes, or fails,
  // and stays put while the answer streams.
  const signature = useAuiState((s) => {
    const last = s.thread.messages.at(-1);
    if (!last) return "";
    return last.parts.map((part) => `${part.type}:${(part as { state?: string }).state ?? ""}`).join("|");
  });
  useEffect(() => {
    if (!running) return;
    const last = aui.thread.getState().messages.at(-1);
    if (last?.role !== "assistant") return;
    const parts = last.parts as unknown as ToolPartLike[];
    const used = usedServicesFromParts(parts);
    if (used.length) markUsedServices(used);
    // A call that failed because its service is down is a real use, and a reason to re-check now.
    if (parts.some((part) => part.state === "output-error" && typeof part.errorText === "string" && part.errorText.includes("service_unavailable"))) {
      void useServices.getState().refresh(true);
    }
  }, [aui, signature, running]);
  return null;
}

export function ServiceNotice() {
  const services = useServices();
  const notices = noticeServices(services);
  const check = () => void services.refresh(true);
  useCommand("services.checkAgain", check, notices.length > 0);
  useCommand("services.dismissNotice", () => services.dismiss(notices.map((status) => status.id)), notices.length > 0);
  if (!notices.length) return null;
  const shown = notices.slice(0, 2);
  return (
    <div
      role="status"
      className="depth-float animate-fade-in border-warning/30 bg-warning-surface text-warning-foreground absolute top-12 left-1/2 z-20 flex w-max max-w-[calc(100%-3.5rem)] -translate-x-1/2 flex-col gap-1 rounded-lg border px-3 py-2 text-xs"
    >
      {shown.map((status) => {
        const fix = status.fixKey ? FIX_SETTINGS[status.fixKey] : undefined;
        const name = t(serviceNameKey(status.id));
        return (
          <div key={status.id} className="flex min-w-0 items-start gap-2">
            <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <p className="min-w-0">
              {status.id === "searxng" && status.state === "down"
                ? t("services.searxngFallback", { reason: t(REASON_KEYS[status.reasonKey]) })
                : status.state === "degraded"
                  ? t("services.degraded", { service: name, reason: t(REASON_KEYS[status.reasonKey]) })
                  : t("services.unavailable", { service: name, reason: t(REASON_KEYS[status.reasonKey]) })}
              {status.fixKey && <span className="text-warning-foreground/80"> {t(FIX_KEYS[status.fixKey])}</span>}
            </p>
            {fix && (
              <Link
                href={settingsHref(fix)}
                aria-label={t("services.openSettings")}
                className="focus-visible:ring-ring/50 grid shrink-0 place-items-center rounded p-0.5 outline-none hover:opacity-80 focus-visible:ring-2 pointer-coarse:size-11"
              >
                <SettingsIcon aria-hidden className="size-3.5" />
              </Link>
            )}
          </div>
        );
      })}
      <div className="flex items-center gap-2 self-end">
        <button
          type="button"
          onClick={check}
          data-command="services.checkAgain"
          className="focus-visible:ring-ring/50 inline-flex min-h-7 items-center gap-1 rounded px-1.5 font-medium outline-none hover:opacity-80 focus-visible:ring-2 pointer-coarse:min-h-11"
        >
          <RefreshCwIcon aria-hidden className="size-3.5" />
          {t("services.checkAgain")}
        </button>
        <button
          type="button"
          aria-label={t("services.dismiss")}
          onClick={() => services.dismiss(notices.map((status) => status.id))}
          data-command="services.dismissNotice"
          className="focus-visible:ring-ring/50 grid shrink-0 place-items-center rounded p-0.5 outline-none hover:opacity-80 focus-visible:ring-2 pointer-coarse:size-11"
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** The reason a finished reply was missing tools, from its stored metadata. */
export function TurnServiceNote() {
  const metadata = useAuiState((s) => s.message.metadata);
  const entries = parseTurnUnavailable(metadataOf(metadata).unavailable);
  if (!entries.length) return null;
  return (
    <div data-slot="aui_turn-service-note" className="text-muted-foreground mt-1.5 flex flex-col gap-1 text-xs">
      {entries.map((entry) => {
        const fix = entry.fixKey ? FIX_SETTINGS[entry.fixKey] : undefined;
        const reason = t(TURN_REASON_KEYS[entry.reasonKey]);
        const service = entry.service === "mcp" ? t("services.nameMcp") : t(serviceNameKey(entry.service as ServiceId));
        return (
          <p key={`${entry.service}:${entry.name ?? ""}:${entry.reasonKey}`} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <CircleAlertIcon aria-hidden className="size-3.5 shrink-0" />
            <span>
              {entry.service === "mcp" && entry.name
                ? t("services.turnUnavailableMcp", { name: entry.name, reason })
                : t("services.turnUnavailable", { service, reason })}
            </span>
            {entry.fixKey && <span className="text-muted-foreground/80">{t(FIX_KEYS[entry.fixKey])}</span>}
            {fix && (
              <Link href={settingsHref(fix)} className="text-primary rounded underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:py-2">
                {t("services.openSettings")}
              </Link>
            )}
          </p>
        );
      })}
    </div>
  );
}

/** True when a control's service is known to be down. Never true while checking. */
export function useServiceDown(id: ServiceId): boolean {
  return useServices((state) => availabilityOf(state, id) === "down");
}
