import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  Loader2Icon,
  LogOutIcon,
  MonitorIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import type { ChatGPTLoginIntent, ChatGPTStatus } from "@shared/chatgpt";
import { CHATGPT_MANAGE_USAGE_URL } from "@shared/chatgpt";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { t, type PlainMessageKey } from "@/i18n";
import { formatDateTime, formatDuration } from "@/i18n/format";
import { settingsHref } from "@/lib/settings-link";
import { useData } from "@/state/data";
import {
  ATTEMPT_STATUS_KEY,
  REGISTRATION_STATE_KEY,
  attemptFailureKey,
  canActivate,
  chatGptView,
  forgettableRegistrations,
  pendingAttempt,
  pendingRemainingMs,
  renewalKey,
  registrationTitle,
  selectableRegistrations,
  suffixIsShownInLabel,
  unavailableReasonKey,
  welcomeRegistration,
  type ChatGPTView,
} from "./chatgpt-connect-state";
import { useChatGPTConnection, type ChatGPTConnection } from "./useChatGPTConnection";

// Chat with a personal ChatGPT plan through Sign in with ChatGPT. The desktop helper is required because
// the OAuth loopback callback belongs to the browser's computer, not to a remote self-hosted deployment.
// Image generation keeps its separate Codex CLI connection (ImageServicesSettings). See codex-chat.md.

function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 639.98px), (pointer: coarse)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 639.98px), (pointer: coarse)");
    const onChange = () => setCoarse(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return coarse;
}

const manageUsage = (url: string, label = t("providers.chatgptManageUsage")) => (
  <a href={url} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-1 text-xs hover:underline">
    {label} <ExternalLinkIcon className="size-3" />
  </a>
);

const spinner = (busy: ChatGPTConnection["busy"], action: NonNullable<ChatGPTConnection["busy"]>) =>
  busy === action ? <Loader2Icon className="animate-spin" /> : null;

export function ChatGPTConnect() {
  const connection = useChatGPTConnection();
  const mobile = useCoarsePointer();
  const role = useData((state) => state.me?.role);
  const [now, setNow] = useState(() => Date.now());
  const pending = pendingAttempt(connection.status, now);
  const [lastIntent, setLastIntent] = useState<{ intent: ChatGPTLoginIntent; registrationId?: string }>({ intent: "connect" });

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [pending?.id, pending?.expiresAt]);

  const view = chatGptView(connection.status, { now, mobile });
  if (view.kind === "loading" && connection.statusError) {
    // The first request failed: say so and offer a retry instead of an endless skeleton.
    return (
      <div className="flex min-h-24 w-full flex-col justify-center gap-2">
        <ChatGPTConnectionNotice
          error={connection.statusError}
          notice={null}
          showManageUsage={false}
          manageUsageUrl={CHATGPT_MANAGE_USAGE_URL}
          retry={() => void connection.load()}
        />
      </div>
    );
  }
  if (view.kind === "loading") {
    return (
      <div className="flex min-h-24 w-full flex-col gap-3" role="status" aria-busy="true">
        <div className="bg-muted/60 h-4 w-44 animate-pulse rounded" />
        <div className="bg-muted/60 h-3 w-72 max-w-full animate-pulse rounded" />
        <div className="bg-muted/60 h-8 w-40 animate-pulse rounded-lg" />
        <span className="sr-only">{t("providers.chatgptLoading")}</span>
      </div>
    );
  }

  const begin = (intent: ChatGPTLoginIntent, registrationId?: string) => {
    setLastIntent({ intent, ...(registrationId ? { registrationId } : {}) });
    void connection.start(intent, registrationId);
  };
  const restart = async () => {
    if (pending) await connection.cancel(pending.id);
    await connection.start(lastIntent.intent, lastIntent.registrationId);
  };
  const welcome = welcomeRegistration(connection.status);
  const shownWelcome = welcome && !connection.welcomeDismissed.has(welcome.id) ? welcome : null;
  const error = connection.statusError ?? connection.actionError ?? connection.downloadError;

  return (
    <div className="flex w-full flex-col gap-4">
      <p className="text-muted-foreground max-w-xl text-xs">{t("providers.chatgptDescription")}</p>
      <ChatGPTConnectionSummary view={view} status={connection.status} />
      <ChatGPTRegistrationPicker
        status={connection.status}
        busy={connection.busy}
        onActivate={(id) => void connection.activate(id)}
        onForget={(id) => void connection.forget(id)}
      />
      <ChatGPTConnectActions
        view={view}
        connection={connection}
        role={role}
        mobile={mobile}
        onBegin={begin}
        onRestart={() => void restart()}
      />
      {view.kind === "pending" && (
        <ChatGPTDesktopHandoff
          pending={view.pending}
          status={connection.status}
          saved={connection.launchSaved === view.pending.id}
          canDownload={connection.launch?.attemptId === view.pending.id}
          busy={connection.busy}
          onDownload={() => void connection.downloadLaunch(view.pending.id)}
          now={now}
        />
      )}
      <ChatGPTConnectionNotice
        error={error}
        notice={connection.notice ?? attemptFailureKey(connection.status)}
        showManageUsage={connection.notice === "providers.chatgptRevokeUnconfirmed"}
        manageUsageUrl={CHATGPT_MANAGE_USAGE_URL}
        retry={connection.statusError ? () => void connection.load() : undefined}
      />
      <ChatGPTPlanWelcomeDialog
        registration={shownWelcome}
        manageUsageUrl={CHATGPT_MANAGE_USAGE_URL}
        busy={connection.busy}
        onAcknowledge={(id) => void connection.welcomeSeen(id)}
      />
    </div>
  );
}

function ChatGPTConnectionSummary({ view, status }: { view: ChatGPTView; status: ChatGPTStatus | null }) {
  if (view.kind === "loading" || view.kind === "unavailable" || view.kind === "disconnected") return null;
  if (view.kind === "pending") {
    return (
      <div role="status" className="flex flex-col gap-1">
        <p className="text-sm font-medium">{t("providers.chatgptPendingTitle")}</p>
        <p className="text-muted-foreground text-xs">{t("providers.chatgptPendingTarget", { origin: status?.publicOrigin ?? "" })}</p>
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Loader2Icon className="size-3 animate-spin" /> {t(ATTEMPT_STATUS_KEY[view.pending.status])}
        </p>
        {view.keepsActive && <p className="text-muted-foreground text-xs">{t("providers.chatgptPendingKeepsActive")}</p>}
      </div>
    );
  }
  const registration = view.registration;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{registration.label}</span>
        {!suffixIsShownInLabel(registration) && (
          <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]" title={t("providers.chatgptSuffixHint")}>
            {registration.suffix}
          </span>
        )}
        <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium">{registration.planLabel}</span>
        {view.kind === "ready" && (
          <span className="text-success inline-flex items-center gap-1 text-xs">
            <CheckCircle2Icon className="animate-pop-in size-3.5" /> {t("providers.connected")}
          </span>
        )}
        {view.kind !== "ready" && <span className="text-warning text-xs">{t(REGISTRATION_STATE_KEY[registration.state])}</span>}
      </div>
      {view.kind === "ready" && <p className="text-muted-foreground text-xs">{t(renewalKey(registration))}</p>}
      {view.kind === "plan_disabled" && <p className="text-warning text-xs">{t("providers.chatgptPlanDisabled")}</p>}
      {view.kind === "reconnect_required" && <p className="text-warning text-xs">{t("providers.chatgptReconnectNeeded")}</p>}
      <details className="text-muted-foreground text-xs">
        <summary className="w-fit cursor-pointer select-none rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          {t("providers.chatgptDetails")}
        </summary>
        <p className="mt-1 max-w-xl">
          {registration.accessExpiresAt === null
            ? t("providers.chatgptNoAccessExpiry")
            : t("providers.chatgptExpiresAt", { time: formatDateTime(registration.accessExpiresAt) })}
        </p>
      </details>
    </div>
  );
}

function ChatGPTRegistrationPicker({
  status,
  busy,
  onActivate,
  onForget,
}: {
  status: ChatGPTStatus | null;
  busy: ChatGPTConnection["busy"];
  onActivate: (id: string) => void;
  onForget: (id: string) => void;
}) {
  const selectable = selectableRegistrations(status);
  const forgettable = forgettableRegistrations(status);
  const showSelect = selectable.length > 1 || (selectable.length === 1 && canActivate(selectable[0]!));
  if (!showSelect && forgettable.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {showSelect && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">{t("providers.chatgptAccounts")}</span>
          <Select
            aria-label={t("providers.chatgptAccounts")}
            className="h-8 w-full sm:w-72"
            value={status?.activeRegistrationId ?? null}
            disabled={busy !== null}
            options={selectable.map((registration) => ({ value: registration.id, label: registrationTitle(registration) }))}
            onValueChange={onActivate}
          />
          {busy === "activate" && <Loader2Icon className="text-muted-foreground size-3.5 animate-spin" aria-hidden="true" />}
        </div>
      )}
      {forgettable.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs">{t("providers.chatgptSavedAccounts")}</p>
          <p className="text-muted-foreground max-w-xl text-xs">{t("providers.chatgptForgetHint")}</p>
          {forgettable.map((registration) => (
            <div key={registration.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs">{registrationTitle(registration)}</span>
              <Button
                size="xs"
                variant="ghost"
                data-command="settings.chatgptForget"
                disabled={busy !== null}
                onClick={() => onForget(registration.id)}
                aria-label={t("providers.chatgptForgetAccount", { label: registrationTitle(registration) })}
              >
                {t("providers.chatgptForget")}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChatGPTConnectActions({
  view,
  connection,
  role,
  mobile,
  onBegin,
  onRestart,
}: {
  view: ChatGPTView;
  connection: ChatGPTConnection;
  role: "admin" | "user" | undefined;
  mobile: boolean;
  onBegin: (intent: ChatGPTLoginIntent, registrationId?: string) => void;
  onRestart: () => void;
}) {
  const disabled = connection.busy !== null;
  if (view.kind === "loading") return null;

  if (view.kind === "unavailable") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground max-w-xl text-xs">{t(unavailableReasonKey(view.reason, role === "admin"))}</p>
        {view.legacyImagesConnected && <p className="text-muted-foreground max-w-xl text-xs">{t("providers.chatgptLegacyImages")}</p>}
        <p className="text-muted-foreground max-w-xl text-xs">{t("providers.chatgptImagesIndependent")}</p>
      </div>
    );
  }

  if (view.kind === "disconnected") {
    return (
      <div className="flex flex-col gap-2">
        {view.legacyImagesConnected && <p className="text-muted-foreground max-w-xl text-xs">{t("providers.chatgptLegacyImages")}</p>}
        {view.mobile ? (
          <p className="flex items-start gap-2 text-xs">
            <MonitorIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
            <span>{t("providers.chatgptMobileSetup")}</span>
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              data-oai-siwc-button
              data-command="settings.chatgptConnect"
              onClick={() => onBegin("connect")}
              disabled={disabled}
            >
              {spinner(connection.busy, "start")}
              {t("providers.chatgptContinue")}
            </Button>
            <span className="text-muted-foreground text-xs">{t("providers.chatgptDesktopRequired")}</span>
          </div>
        )}
        <p className="text-muted-foreground max-w-xl text-xs">{t("providers.chatgptImagesIndependent")}</p>
      </div>
    );
  }

  if (view.kind === "pending") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          data-command="settings.chatgptCancel"
          onClick={() => void connection.cancel(view.pending.id)}
          disabled={disabled}
        >
          {spinner(connection.busy, "cancel")}
          {t("providers.chatgptCancel")}
        </Button>
        <Button size="sm" variant="ghost" data-command="settings.chatgptStartAgain" onClick={onRestart} disabled={disabled}>
          <RefreshCwIcon /> {t("providers.chatgptStartAgain")}
        </Button>
      </div>
    );
  }

  if (view.kind === "plan_disabled") {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          {!mobile && (
            <Button size="sm" data-command="settings.chatgptEnablePlan" onClick={() => onBegin("enable_plan", view.registration.id)} disabled={disabled}>
              {spinner(connection.busy, "start")}
              {t("providers.chatgptEnablePlan")}
            </Button>
          )}
          <Link href={settingsHref("providers")} className="text-primary inline-flex items-center gap-1 text-xs hover:underline">
            {t("providers.chatgptChooseAnother")}
          </Link>
          {!mobile && <span className="text-muted-foreground text-xs">{t("providers.chatgptDesktopRequired")}</span>}
        </div>
        {mobile && <p className="text-muted-foreground max-w-xl text-xs">{t("providers.chatgptMobileReconnect")}</p>}
      </div>
    );
  }

  // ready and reconnect_required share the account actions; only the reconnect entry point differs.
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {!mobile && (
          <Button size="sm" data-command="settings.chatgptReconnect" onClick={() => onBegin("reconnect", view.registration.id)} disabled={disabled}>
            {spinner(connection.busy, "start")}
            {t("providers.chatgptReconnect")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          data-command="settings.chatgptDisconnectChat"
          onClick={() => void connection.disconnect(view.registration.id)}
          disabled={disabled}
        >
          {connection.busy === "disconnect" ? <Loader2Icon className="animate-spin" /> : <LogOutIcon />}
          {t("providers.chatgptDisconnectChat")}
        </Button>
        {view.kind === "ready" ? manageUsage(CHATGPT_MANAGE_USAGE_URL) : !mobile && <span className="text-muted-foreground text-xs">{t("providers.chatgptDesktopRequired")}</span>}
      </div>
      {mobile && <p className="text-muted-foreground max-w-xl text-xs">{t("providers.chatgptMobileReconnect")}</p>}
      <p className="text-muted-foreground max-w-xl text-xs">{t("providers.chatgptDisconnectHint")}</p>
      <p className="text-muted-foreground max-w-xl text-xs">{t("providers.chatgptImagesIndependent")}</p>
    </div>
  );
}

function ChatGPTDesktopHandoff({
  pending,
  status,
  saved,
  canDownload,
  busy,
  onDownload,
  now,
}: {
  pending: NonNullable<ReturnType<typeof pendingAttempt>>;
  status: ChatGPTStatus | null;
  saved: boolean;
  canDownload: boolean;
  busy: ChatGPTConnection["busy"];
  onDownload: () => void;
  now: number;
}) {
  const helperUrl = status?.helperUrl ?? "/chatgpt-connect.mjs";
  const [checksum, setChecksum] = useState<string | null>(null);
  const [checksumFailed, setChecksumFailed] = useState(false);
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  useEffect(() => {
    let live = true;
    setChecksum(null);
    setChecksumFailed(false);
    fetch(`${helperUrl}.sha256`, { credentials: "same-origin", cache: "no-store" })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error("checksum unavailable"))))
      .then((text) => {
        const value = text.trim().slice(0, 64);
        if (live && /^[a-f0-9]{64}$/.test(value)) setChecksum(value);
        else if (live) setChecksumFailed(true);
      })
      .catch(() => {
        if (live) setChecksumFailed(true);
      });
    return () => {
      live = false;
    };
  }, [helperUrl]);

  return (
    <div className="bg-muted/40 flex flex-col gap-3 rounded-xl border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs">{t("providers.chatgptStepDownloadHelper")}</p>
        <Button
          size="sm"
          variant="outline"
          render={<a href={helperUrl} download aria-label={t("providers.chatgptHelperDownloadAria")} data-command="settings.chatgptDownloadHelper" />}
        >
          <DownloadIcon /> {t("providers.chatgptDownloadHelper")}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {checksum && (
          <>
            <code className="text-muted-foreground max-w-full break-all font-mono text-[10px]">{t("providers.chatgptChecksum", { checksum })}</code>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => copyToClipboard(checksum)}
              aria-label={isCopied ? t("providers.chatgptChecksumCopied") : t("providers.chatgptCopyChecksum")}
              data-command="settings.chatgptCopyChecksum"
            >
              {isCopied ? <CheckIcon className="text-success animate-pop-in" /> : <CopyIcon />}
            </Button>
          </>
        )}
        {!checksum && checksumFailed && <span className="text-muted-foreground text-[10px]">{t("providers.chatgptChecksumUnavailable")}</span>}
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs">{t("providers.chatgptStepDownloadLaunch")}</p>
          {!saved && canDownload && (
            <Button
              size="sm"
              variant="outline"
              onClick={onDownload}
              disabled={busy !== null}
              data-command="settings.chatgptDownloadLaunch"
              aria-label={t("providers.chatgptDownloadLaunchAria")}
            >
              {spinner(busy, "download")}
              <DownloadIcon /> {t("providers.chatgptDownloadLaunch")}
            </Button>
          )}
        </div>
        {saved && <span className="text-success text-xs">{t("providers.chatgptLaunchSaved")}</span>}
        {!saved && !canDownload && <span className="text-muted-foreground text-xs">{t("providers.chatgptLaunchMissing")}</span>}
      </div>
      <p className="text-muted-foreground max-w-xl text-xs">{t("providers.chatgptLaunchSingleUse")}</p>
      <div className="flex flex-col gap-1">
        <p className="text-xs">{t("providers.chatgptStepRun")}</p>
        <code className="bg-muted block overflow-x-auto rounded-lg px-3 py-2 font-mono text-xs">
          {t("providers.chatgptRunCommand", { file: "okaychat-chatgpt-launch.json" })}
        </code>
        <p className="text-muted-foreground max-w-xl text-xs">{t("providers.chatgptStepConfirm", { origin: status?.publicOrigin ?? "" })}</p>
      </div>
      <p className="text-muted-foreground text-xs">{t("providers.chatgptPendingExpires", { time: formatDuration(pendingRemainingMs(pending, now) / 1000) })}</p>
    </div>
  );
}

function ChatGPTConnectionNotice({
  error,
  notice,
  showManageUsage,
  manageUsageUrl,
  retry,
}: {
  error?: string | null;
  notice?: PlainMessageKey | null;
  showManageUsage: boolean;
  manageUsageUrl: string;
  retry?: () => void;
}) {
  if (!error && !notice) return null;
  return (
    <div className="flex flex-col gap-2">
      {error && (
        <div role="alert" className="text-error flex flex-wrap items-center gap-2 text-xs">
          <AlertCircleIcon className="size-3.5 shrink-0" />
          <span>{error}</span>
          {retry && (
            <Button size="xs" variant="ghost" data-command="settings.chatgptRetry" onClick={retry}>
              {t("providers.chatgptRetry")}
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="text-warning max-w-xl text-xs">
          {t(notice)} {showManageUsage && manageUsage(manageUsageUrl)}
        </p>
      )}
    </div>
  );
}

function ChatGPTPlanWelcomeDialog({
  registration,
  manageUsageUrl,
  busy,
  onAcknowledge,
}: {
  registration: { id: string } | null;
  manageUsageUrl: string;
  busy: ChatGPTConnection["busy"];
  onAcknowledge: (id: string) => void;
}) {
  const acknowledged = useRef(false);
  useEffect(() => {
    acknowledged.current = false;
  }, [registration?.id]);
  const acknowledge = () => {
    if (!registration || acknowledged.current) return;
    acknowledged.current = true;
    onAcknowledge(registration.id);
  };
  return (
    <Dialog
      open={registration !== null}
      onOpenChange={(open) => {
        if (!open) acknowledge();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("providers.chatgptWelcomeTitle")}</DialogTitle>
          <DialogDescription>{t("providers.chatgptWelcomeBody")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {manageUsage(manageUsageUrl)}
          <Button onClick={acknowledge} disabled={busy !== null}>
            {t("providers.chatgptWelcomeDismiss")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
