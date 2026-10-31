import { AlertCircleIcon, CheckCircle2Icon, Loader2Icon, MailIcon, PencilIcon, PlusIcon, StarIcon, TrashIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { EmailAccount, EmailDiscoveryAttempt, EmailDiscoveryResult, EmailDiscoveryServer } from "@shared/email";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t, type PlainMessageKey } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SettingsPage, SettingsSection } from "./SettingsUI";

// Settings → Email: connected accounts, plus a wizard that discovers provider servers, shows every
// attempt, lets the user correct them, tests the connection, and saves. The password is write-only:
// an edit leaves it blank to keep the stored one, and changing a server or username requires it again.

const DEFAULT_IMAP = { host: "", port: 993, security: "tls" as const, username: "" };
const DEFAULT_SMTP = { host: "", port: 465, security: "tls" as const, username: "" };

const STAGE_KEYS = {
  preset: "email.stagePreset",
  thunderbird: "email.stageThunderbird",
  microsoft: "email.stageMicrosoft",
  srv: "email.stageSrv",
  heuristic: "email.stageHeuristic",
  probe: "email.stageProbe",
} as const satisfies Record<EmailDiscoveryAttempt["stage"], PlainMessageKey>;

const CONFIDENCE_KEYS = {
  high: "email.confidenceHigh",
  medium: "email.confidenceMedium",
  low: "email.confidenceLow",
} as const satisfies Record<NonNullable<EmailDiscoveryResult["confidence"]>, PlainMessageKey>;

function useEmailData() {
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = () => {
    api<EmailAccount[]>("/email/accounts")
      .then((list) => {
        setAccounts(list);
        setError(null);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []);
  return { accounts, error, loading, refresh };
}

function StatusLine({ account }: { account: EmailAccount }) {
  if (!account.lastCheckStatus) {
    return <span className="text-muted-foreground">{t("email.statusNever")}</span>;
  }
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", account.lastCheckStatus === "failed" && "text-warning")}>
      {account.lastCheckStatus === "ok" ? <CheckCircle2Icon aria-hidden className="text-success size-3.5 shrink-0" /> : <AlertCircleIcon aria-hidden className="text-warning size-3.5 shrink-0" />}
      <span className="truncate">
        {account.lastCheckStatus === "ok" ? t("email.statusOk") : t("email.statusFailed")}
        {account.lastCheckAt ? <> · {t("email.lastChecked", { date: formatDateTime(account.lastCheckAt) })}</> : null}
      </span>
    </span>
  );
}

function AccountRow({ account, busy, onEdit, onRemove, onDefault, onToggle }: {
  account: EmailAccount;
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onDefault: () => void;
  onToggle: (patch: { readEnabled?: boolean; sendEnabled?: boolean }) => void;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{account.label}</span>
            {account.isDefault && <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium">{t("email.defaultBadge")}</span>}
          </div>
          <p className="text-muted-foreground truncate text-xs">{account.address}</p>
          <div className="text-muted-foreground mt-1 text-xs">
            <StatusLine account={account} />
          </div>
          {account.lastCheckStatus === "failed" && account.lastCheckError ? <p className="text-warning mt-1 text-xs">{account.lastCheckError}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!account.isDefault && (
            <Button type="button" variant="ghost" size="icon-sm" className="pointer-coarse:size-10" data-command="email.setDefault" aria-label={t("email.setDefaultFor", { address: account.address })} title={t("email.setDefault")} disabled={busy} onClick={onDefault}>
              <StarIcon className="size-4" />
            </Button>
          )}
          <Button type="button" variant="ghost" size="icon-sm" className="pointer-coarse:size-10" data-command="email.editAccount" aria-label={t("email.editAccountFor", { address: account.address })} title={t("email.edit")} disabled={busy} onClick={onEdit}>
            <PencilIcon className="size-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" className="pointer-coarse:size-10" data-command="email.removeAccount" aria-label={t("email.removeAccountFor", { address: account.address })} title={t("email.remove")} disabled={busy} onClick={onRemove}>
            <TrashIcon className="size-4" />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <Switch checked={account.readEnabled} disabled={busy} onCheckedChange={(readEnabled) => onToggle({ readEnabled })} aria-label={t("email.readFor", { address: account.address })} />
          <span>{t("email.readLabel")}</span>
        </label>
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <Switch checked={account.sendEnabled} disabled={busy} onCheckedChange={(sendEnabled) => onToggle({ sendEnabled })} aria-label={t("email.sendFor", { address: account.address })} />
          <span>{t("email.sendLabel")}</span>
        </label>
      </div>
    </div>
  );
}

interface ServerDraft {
  host: string;
  port: number;
  security: "tls" | "starttls";
  username: string;
}

function serverDraft(value: EmailDiscoveryServer | null | undefined, fallback: ServerDraft, email: string): ServerDraft {
  return value ? { host: value.host, port: value.port, security: value.security, username: value.username || email } : { ...fallback, username: fallback.username || email };
}

function sameServer(a: ServerDraft, b: ServerDraft) {
  return a.host === b.host && a.port === b.port && a.security === b.security && a.username === b.username;
}

function Wizard({ account, onClose, onSaved }: { account?: EmailAccount; onClose: () => void; onSaved: () => void }) {
  const [step, setStep] = useState<"email" | "configure">(account ? "configure" : "email");
  const [email, setEmail] = useState(account?.address ?? "");
  const [label, setLabel] = useState(account?.label ?? "");
  const [signature, setSignature] = useState(account?.signature ?? "");
  const [password, setPassword] = useState("");
  const [imap, setImap] = useState<ServerDraft>(account ? account.imap : DEFAULT_IMAP);
  const [smtp, setSmtp] = useState<ServerDraft>(account ? account.smtp : DEFAULT_SMTP);
  const [allowInsecureProbe, setAllowInsecureProbe] = useState(account?.allowInsecureProbe ?? false);
  const [attempts, setAttempts] = useState<EmailDiscoveryAttempt[]>([]);
  const [discovery, setDiscovery] = useState<EmailDiscoveryResult | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const discoveringRef = useRef(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => (step === "email" && !account ? emailRef.current : statusRef.current)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [step, account]);

  // The discovery stream can outlive a dismissed dialog; cancel it on unmount and drop its events.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const originalImap = account ? account.imap : null;
  const originalSmtp = account ? account.smtp : null;
  const serversDirty = !!account && (!sameServer(imap, originalImap!) || !sameServer(smtp, originalSmtp!));

  const clearTest = () => setTest(null);

  const discover = async () => {
    if (discoveringRef.current) return;
    if (!email.trim()) {
      setDiscoveryError(t("email.enterEmailFirst"));
      emailRef.current?.focus();
      return;
    }
    discoveringRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    setDiscovering(true);
    setDiscoveryError(null);
    setDiscovery(null);
    setAttempts([]);
    setTest(null);
    try {
      const response = await fetch("/api/email/discover", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), allowInsecureProbe }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error((await response.text()) || t("email.discoveryFailed"));
      if (!response.body) throw new Error(t("email.discoveryFailed"));
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { type: string; attempt?: EmailDiscoveryAttempt; result?: EmailDiscoveryResult; error?: string };
          if (event.type === "attempt" && event.attempt) setAttempts((previous) => [...previous, event.attempt!]);
          if (event.type === "error") throw new Error(event.error || t("email.discoveryFailed"));
          if (event.type === "result" && event.result) {
            completed = true;
            const result = event.result;
            setDiscovery(result);
            setImap((previous) => serverDraft(result.imap, previous, email.trim()));
            setSmtp((previous) => serverDraft(result.smtp, previous, email.trim()));
            setStep("configure");
          }
        }
      }
      if (!completed) throw new Error(t("email.discoveryFailed"));
    } catch (e) {
      if (!controller.signal.aborted) setDiscoveryError((e as Error).message);
    } finally {
      discoveringRef.current = false;
      if (controllerRef.current === controller) controllerRef.current = null;
      setDiscovering(false);
    }
  };

  const runTest = async () => {
    setError(null);
    setTest(null);
    if (!password && (!account || serversDirty)) {
      setTest({ ok: false, message: t("email.testNeedsPassword") });
      return;
    }
    setTesting(true);
    try {
      if (account && !password && !serversDirty) {
        const result = await api<{ ok: true; folders: number }>(`/email/accounts/${account.id}/test`, { method: "POST" });
        setTest({ ok: true, message: t("email.testOk", { count: result.folders }) });
        onSaved();
      } else {
        const result = await api<{ ok: true; folders: number }>("/email/test", {
          method: "POST",
          json: { address: email.trim(), password, imap, smtp, allowInsecureProbe },
        });
        // A draft test is not a saved-account check: saving is a separate step and the account's
        // own "last checked" status stays untouched until it is tested after saving.
        setTest({
          ok: true,
          message: account
            ? t("email.testDraftOk", { count: result.folders })
            : t("email.testOk", { count: result.folders }),
        });
      }
    } catch (e) {
      setTest({ ok: false, message: (e as Error).message });
      if (account) onSaved();
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setError(null);
    if (!account && !password) {
      setError(t("email.passwordRequired"));
      return;
    }
    if (!label.trim()) {
      setError(t("email.labelRequired"));
      return;
    }
    setSaving(true);
    try {
      const payload = {
        label: label.trim(),
        address: email.trim(),
        ...(password ? { password } : {}),
        imap,
        smtp,
        signature,
        allowInsecureProbe,
      };
      if (account) await api(`/email/accounts/${account.id}`, { method: "PATCH", json: payload });
      else await api("/email/accounts", { method: "POST", json: payload });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const setServer = (side: "imap" | "smtp", patch: Partial<ServerDraft>) => {
    // Any change to an endpoint invalidates an earlier successful test.
    clearTest();
    if (side === "imap") setImap((previous) => ({ ...previous, ...patch }));
    else setSmtp((previous) => ({ ...previous, ...patch }));
  };

  const enterManually = () => {
    const value = email.trim();
    if (!value) {
      setDiscoveryError(t("email.enterEmailFirst"));
      emailRef.current?.focus();
      return;
    }
    setImap((previous) => ({ ...previous, username: value }));
    setSmtp((previous) => ({ ...previous, username: value }));
    setDiscovery(null);
    setAttempts([]);
    setDiscoveryError(null);
    setStep("configure");
  };

  const serverFields = (side: "imap" | "smtp", value: ServerDraft, title: string) => (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{title}</legend>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <label className="flex min-w-0 flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t("email.host")}</span>
          <Input className="pointer-coarse:h-10" value={value.host} onChange={(e) => setServer(side, { host: e.target.value })} autoComplete="off" spellCheck={false} placeholder={t("email.hostPlaceholder")} inputMode="url" />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t("email.port")}</span>
          <Input
            className="pointer-coarse:h-10"
            type="number"
            min={1}
            max={65535}
            value={Number.isFinite(value.port) ? value.port : ""}
            onChange={(e) => setServer(side, { port: Number.parseInt(e.target.value, 10) || 0 })}
            inputMode="numeric"
          />
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t("email.security")}</span>
          <Select
            className="pointer-coarse:h-10"
            aria-label={t("email.securityFor", { server: title })}
            value={value.security}
            onValueChange={(security) => setServer(side, { security })}
            options={[
              { value: "tls", label: t("email.securityTls") },
              { value: "starttls", label: t("email.securityStarttls") },
            ]}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t("email.username")}</span>
          <Input className="pointer-coarse:h-10" value={value.username} onChange={(e) => setServer(side, { username: e.target.value })} autoComplete="username" spellCheck={false} />
        </label>
      </div>
    </fieldset>
  );

  const progressBlock = attempts.length > 0 || discovering ? (
    <section className="bg-muted/40 flex flex-col gap-1 rounded-lg border p-3" aria-label={t("email.progressTitle")} role="log" aria-live="polite">
      <h3 className="text-xs font-medium">{t("email.progressTitle")}</h3>
      {attempts.length === 0 && discovering ? <p className="text-muted-foreground text-xs">{t("email.progressEmpty")}</p> : null}
      <ul className="flex flex-col gap-1">
        {attempts.map((attempt, index) => (
          <li key={`${attempt.stage}-${index}`} className="flex min-w-0 items-start gap-2 text-xs">
            <span className="text-muted-foreground w-28 shrink-0">{t(STAGE_KEYS[attempt.stage])}</span>
            <span className="min-w-0 flex-1">
              <span className="break-words">{attempt.label}</span>
              {attempt.detail ? <span className="text-muted-foreground block break-words">{attempt.detail}</span> : null}
            </span>
            <span className={cn("shrink-0", attempt.status === "failed" && "text-warning")}>
              {attempt.status === "running" ? <Loader2Icon aria-label={t("email.attemptRunning")} className="size-3.5 animate-spin motion-reduce:animate-none" /> : attempt.status === "ok" ? <CheckCircle2Icon aria-label={t("email.attemptOk")} className="text-success size-3.5" /> : <AlertCircleIcon aria-label={t("email.attemptFailed")} className="text-muted-foreground size-3.5" />}
            </span>
          </li>
        ))}
      </ul>
    </section>
  ) : null;

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (step === "email") void discover();
        else void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>{account ? t("email.editTitle") : t("email.addTitle")}</DialogTitle>
        <DialogDescription>{account ? t("email.editDescription") : t("email.addDescription")}</DialogDescription>
      </DialogHeader>

      {step === "email" ? (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("email.emailLabel")}</span>
            <Input ref={emailRef} className="pointer-coarse:h-10" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("email.emailPlaceholder")} autoComplete="email" required />
          </label>
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <Switch checked={allowInsecureProbe} onCheckedChange={(value) => { setAllowInsecureProbe(value); clearTest(); }} aria-label={t("email.allowInsecure")} />
            <span>{t("email.allowInsecure")}</span>
          </label>
          <p className="text-muted-foreground text-xs">{t("email.allowInsecureHint")}</p>
          <p className="text-muted-foreground text-xs">{t("email.oauthNote")}</p>
          {discoveryError && <p role="alert" className="text-destructive text-xs">{discoveryError}</p>}
          {progressBlock}
          <Button type="button" variant="link" className="min-h-10 self-start px-0" onClick={enterManually}>
            {t("email.enterManually")}
          </Button>
        </div>
      ) : (
        <div className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto pe-1">
          <p ref={statusRef} tabIndex={-1} role="status" aria-live="polite" className="text-muted-foreground text-xs outline-none">
            {discovering
              ? t("email.findingSettings")
              : discovery
                ? t("email.foundSettings", { source: discovery.source ?? t("email.manualSource"), confidence: discovery.confidence ? t(CONFIDENCE_KEYS[discovery.confidence]) : t("email.confidenceLow") })
                : t("email.manualSettings")}
          </p>

          {progressBlock}

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("email.emailLabel")}</span>
            <Input
              className="pointer-coarse:h-10"
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); clearTest(); }}
              placeholder={t("email.emailPlaceholder")}
              autoComplete="email"
              required
            />
          </label>

          {discovery?.needsBridge || (discovery?.notes.length ?? 0) > 0 ? (
            <section className="flex flex-col gap-1" aria-label={t("email.notesTitle")}>
              <h3 className="text-xs font-medium">{t("email.notesTitle")}</h3>
              <ul className="text-muted-foreground list-disc space-y-1 ps-5 text-xs">
                {(discovery?.notes ?? []).map((note) => <li key={note}>{note}</li>)}
              </ul>
            </section>
          ) : null}

          {discoveryError && <p role="alert" className="text-destructive text-xs">{discoveryError}</p>}

          <div className="grid gap-4 sm:grid-cols-2">
            {serverFields("imap", imap, t("email.imapTitle"))}
            {serverFields("smtp", smtp, t("email.smtpTitle"))}
          </div>

          <div className="flex flex-col gap-1 text-sm">
            <label className="flex flex-col gap-1">
              <span className="font-medium">{t("email.password")}</span>
              <Input
                className="pointer-coarse:h-10"
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); clearTest(); }}
                autoComplete="new-password"
                placeholder={account ? t("email.passwordKeepPlaceholder") : t("email.passwordPlaceholder")}
                required={!account}
              />
            </label>
            <p className="text-muted-foreground text-xs">{account ? t("email.passwordKeepHint") : t("email.appPasswordBody")}</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" className="min-h-10" onClick={() => void runTest()} disabled={testing || saving} data-command="email.test">
              {testing ? <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" /> : null}
              {testing ? t("email.testing") : t("email.testConnection")}
            </Button>
            {test ? (
              <p role={test.ok ? "status" : "alert"} aria-live="polite" className={cn("text-xs", test.ok ? "text-success" : "text-warning")}>
                {test.ok ? <CheckCircle2Icon aria-hidden className="me-1 inline size-3.5" /> : <AlertCircleIcon aria-hidden className="me-1 inline size-3.5" />}
                {test.message}
              </p>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-medium">{t("email.labelLabel")}</span>
              <Input className="pointer-coarse:h-10" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("email.labelPlaceholder")} maxLength={60} required />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-medium">{t("email.signatureLabel")}</span>
              <Textarea value={signature} onChange={(e) => setSignature(e.target.value)} placeholder={t("email.signaturePlaceholder")} maxLength={4000} className="min-h-20" />
            </label>
          </div>

          <div className="flex min-h-10 items-center gap-2 text-sm">
            <Switch checked={allowInsecureProbe} onCheckedChange={(value) => { setAllowInsecureProbe(value); clearTest(); }} aria-label={t("email.allowInsecure")} />
            <span>{t("email.allowInsecure")}</span>
            <span className="text-muted-foreground text-xs">{t("email.allowInsecureHint")}</span>
          </div>

          {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
        </div>
      )}

      <DialogFooter>
        {step === "configure" && !account ? (
          <Button type="button" variant="outline" className="min-h-10" onClick={() => setStep("email")} disabled={saving || testing || discovering}>
            {t("email.back")}
          </Button>
        ) : null}
        <Button type="button" variant="outline" className="min-h-10" onClick={onClose} disabled={saving}>
          {t("common.cancel")}
        </Button>
        {step === "email" ? (
          <Button type="submit" className="min-h-10" disabled={discovering} data-command="email.discover">
            {discovering ? <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" /> : null}
            {discovering ? t("email.findingSettings") : t("email.findSettings")}
          </Button>
        ) : (
          <Button type="submit" className="min-h-10" disabled={saving || testing} data-command="email.save">
            {saving ? <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" /> : null}
            {saving ? t("email.saving") : t("email.save")}
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

export function EmailSettings() {
  const { accounts, error, loading, refresh } = useEmailData();
  const [wizard, setWizard] = useState<{ account?: EmailAccount } | null>(null);
  const [removing, setRemoving] = useState<EmailAccount | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const toggle = async (account: EmailAccount, patch: { readEnabled?: boolean; sendEnabled?: boolean }) => {
    setBusy(account.id);
    setActionError(null);
    try {
      await api(`/email/accounts/${account.id}`, { method: "PATCH", json: patch });
      refresh();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const setDefault = async (account: EmailAccount) => {
    setBusy(account.id);
    setActionError(null);
    try {
      await api(`/email/accounts/${account.id}/default`, { method: "POST" });
      refresh();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(removing.id);
    try {
      await api(`/email/accounts/${removing.id}`, { method: "DELETE" });
      setRemoving(null);
      refresh();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsPage title={t("email.title")} description={t("email.description")}>
      <SettingsSection
        title={t("email.accountsTitle")}
        action={
          <Button type="button" size="sm" data-command="email.addAccount" className="min-h-10" onClick={() => setWizard({})}>
            <PlusIcon className="size-4" /> {t("email.addAccount")}
          </Button>
        }
      >
        {loading ? (
          <div role="status" className="text-muted-foreground flex items-center gap-2 px-4 py-6 text-xs">
            <Loader2Icon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
            {t("email.accountsLoading")}
          </div>
        ) : accounts.length === 0 ? (
          <div className="flex flex-col items-start gap-2 px-4 py-6">
            <MailIcon aria-hidden className="text-muted-foreground size-6" />
            <h3 className="text-sm font-medium">{t("email.emptyTitle")}</h3>
            <p className="text-muted-foreground max-w-prose text-xs">{t("email.emptyBody")}</p>
            <p className="text-muted-foreground max-w-prose text-xs">{t("email.oauthNote")}</p>
            <Button type="button" size="sm" className="mt-1 min-h-10" data-command="email.addAccount" onClick={() => setWizard({})}>
              <PlusIcon className="size-4" /> {t("email.addFirstAccount")}
            </Button>
          </div>
        ) : (
          accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              busy={busy === account.id}
              onEdit={() => setWizard({ account })}
              onRemove={() => setRemoving(account)}
              onDefault={() => void setDefault(account)}
              onToggle={(patch) => void toggle(account, patch)}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection title={t("email.howTitle")} description={t("email.howBody")}>
        <div className="flex flex-col gap-2 px-4 py-3 text-xs">
          <p className="text-muted-foreground">{t("email.readHint")}</p>
          <p className="text-muted-foreground">{t("email.sendHint")}</p>
          <p className="text-muted-foreground">{t("email.oauthNote")}</p>
        </div>
      </SettingsSection>

      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
      {actionError && <p role="alert" className="text-destructive text-xs">{actionError}</p>}

      <Dialog open={wizard !== null} onOpenChange={(open) => { if (!open) setWizard(null); }}>
        <DialogContent className="sm:max-w-2xl">
          {wizard && <Wizard key={wizard.account?.id ?? "new"} account={wizard.account} onClose={() => setWizard(null)} onSaved={refresh} />}
        </DialogContent>
      </Dialog>

      <Dialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("email.removeTitle")}</DialogTitle>
            <DialogDescription>{t("email.removeBody", { address: removing?.address ?? "" })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-10" onClick={() => setRemoving(null)}>{t("common.cancel")}</Button>
            <Button type="button" variant="destructive" className="min-h-10" data-command="email.confirmRemove" disabled={busy !== null} onClick={() => void remove()}>
              {t("email.remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPage>
  );
}
