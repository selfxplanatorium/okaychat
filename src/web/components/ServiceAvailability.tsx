import { CircleAlertIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";
import { Link } from "wouter";
import type { ServiceId } from "@shared/services";
import { t, type PlainMessageKey } from "@/i18n";
import { settingsHref } from "@/lib/settings-link";
import { useCommand } from "@/keyboard/registry";
import { useServices } from "@/state/services";
import { FIX_KEYS, FIX_SETTINGS, REASON_KEYS, availabilityOf, customServiceMessageKey, serviceNameKey, statusOf } from "@/state/services-derive";
import { cn } from "@/lib/utils";


// An explanatory block for a panel that depends on one service. It replaces a raw request error: the panel says
// what is unavailable, why, and how to fix it, and offers a check without polling. Nothing renders while the
// service is up or unknown, and "checking" is never shown as "down".
export function ServiceAvailability({ id, className, describeId, messageKey }: { id: ServiceId; className?: string; describeId?: string; messageKey?: PlainMessageKey }) {
  const services = useServices();
  const state = availabilityOf(services, id);
  const check = () => void services.refresh(true);
  useCommand("services.checkAgain", check, state === "down" || state === "degraded" || state === "unconfigured");
  if (state === "up" || state === "unknown") return null;
  const status = statusOf(services, id);
  // A speech outage has a compose fix and a "pick another engine" link; a CPU fallback still offers the
  // latter because a user may prefer a cloud voice.
  const fixKey = status?.fixKey ?? (id === "browser" || id === "scrapling" ? "startBrowser" : id === "speech" ? "startSpeech" : id === "sandbox" ? "startSandbox" : id === "searxng" ? "startSearxng" : undefined);
  const fix = fixKey ? FIX_SETTINGS[fixKey] : undefined;
  if (state === "checking") {
    return (
      <p id={describeId} role="status" className={cn("text-muted-foreground text-xs", className)}>
        {t("services.checking")}
      </p>
    );
  }
  const name = t(serviceNameKey(id));
  // A caller's note describes an outage; a degraded service explains its own limitation (a CPU fallback is
  // slower, not unavailable). Otherwise Settings → Voice would claim server voices are unavailable while up.
  const custom = customServiceMessageKey(state, messageKey);
  return (
    <div
      id={describeId}
      role="status"
      className={cn("border-warning/30 bg-warning-surface text-warning-foreground flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-xs", className)}
    >
      <p className="flex items-start gap-2">
        <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {custom
            ? t(custom)
            : state === "degraded"
              ? t("services.degraded", { service: name, reason: t(REASON_KEYS[status?.reasonKey ?? "unreachable"]) })
              : t("services.unavailable", { service: name, reason: t(REASON_KEYS[status?.reasonKey ?? "unreachable"]) })}
        </span>
      </p>
      {fixKey && <p className="ps-[1.375rem]">{t(FIX_KEYS[fixKey])}</p>}
      <div className="flex flex-wrap items-center gap-2 ps-[1.375rem]">
        <button
          type="button"
          onClick={check}
          data-command="services.checkAgain"
          className="focus-visible:ring-ring/50 inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-warning/40 px-2 py-1 font-medium outline-none focus-visible:ring-2 pointer-coarse:min-h-11"
        >
          <RefreshCwIcon aria-hidden className="size-3.5" />
          {t("services.checkAgain")}
        </button>
        {fix && (
          <Link
            href={settingsHref(fix)}
            className="focus-visible:ring-ring/50 inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-warning/40 px-2 py-1 font-medium outline-none focus-visible:ring-2 pointer-coarse:min-h-11"
          >
            <SettingsIcon aria-hidden className="size-3.5" />
            {t("services.openSettings")}
          </Link>
        )}
      </div>
    </div>
  );
}
