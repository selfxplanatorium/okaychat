import { EyeIcon, EyeOffIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  N8N_LIMITS,
  protocolPreset,
  type N8nAgentDetail,
  type N8nAgentInput,
  type N8nAgentPublicConfig,
  type N8nMemoryMode,
  type N8nProtocol,
  type N8nResponseMode,
} from "@shared/n8n-agents";
import type { ShareAudience } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { t, type PlainMessageKey } from "@/i18n";
import { useCommand } from "@/keyboard/registry";
import { cn } from "@/lib/utils";
import { useN8nAgents } from "@/state/n8n-agents";
import { AudienceDialog, EVERYONE, audienceLabel, useDirectory } from "@/components/settings/Audience";
import { AgentAvatar } from "./AgentAvatar";
import { AgentTestPanel } from "./AgentTestPanel";
import { agentErrorText } from "./agent-error";

export type AgentScope = "own" | "shared";

const AVATAR_OPTIONS = [
  { id: "workflow", label: "agents.avatarWorkflow" },
  { id: "bot", label: "agents.avatarBot" },
  { id: "sparkles", label: "agents.avatarSparkles" },
  { id: "message-circle", label: "agents.avatarChat" },
] as const satisfies ReadonlyArray<{ id: string; label: PlainMessageKey }>;

const MEMORY_LABELS = {
  none: "agents.memoryNone",
  history: "agents.memoryHistory",
  remote: "agents.memoryRemote",
} as const satisfies Record<N8nMemoryMode, PlainMessageKey>;

const MEMORY_HINTS = {
  none: "agents.memoryNoneHint",
  history: "agents.memoryHistoryHint",
  remote: "agents.memoryRemoteHint",
} as const satisfies Record<N8nMemoryMode, PlainMessageKey>;

const RESPONSE_LABELS = {
  auto: "agents.responseAuto",
  ndjson: "agents.responseNdjson",
  sse: "agents.responseSse",
  json: "agents.responseJson",
  text: "agents.responseText",
} as const satisfies Record<N8nResponseMode, PlainMessageKey>;

const basePath = (scope: AgentScope) => (scope === "shared" ? "/admin/agents/n8n" : "/agents/n8n");

const createConfig = (): N8nAgentPublicConfig => ({
  webhookUrl: "",
  protocol: "webhook",
  ...protocolPreset("webhook"),
  responseMode: "auto",
  responsePointer: null,
  timeoutMs: 120_000,
  idleTimeoutMs: 60_000,
});

type AuthAction = "none" | "keep" | "replace" | "remove";

const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RESERVED = new Set(["action", "metadata", "__proto__", "prototype", "constructor"]);
const HEADER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/;
const DENIED_HEADER = /^(host|cookie|set-cookie|origin|referer|user-agent|connection|transfer-encoding|te|trailer|upgrade|forwarded|keep-alive|expect|via|content-|accept|proxy-|sec-|x-forwarded-)/i;

const pointerProblem = (pointer: string): boolean => {
  if (!pointer) return false;
  if (!pointer.startsWith("/")) return true;
  const tokens = pointer.slice(1).split("/");
  if (tokens.length > 16) return true;
  return tokens.some((token) => /~[^01]|~$/.test(token));
};

const urlProblem = (value: string): "agents.validationUrl" | "agents.validationPublicHttps" | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "agents.validationUrl";
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return "agents.validationPublicHttps";
  return null;
};

/**
 * Create or edit one agent. Detail (including the header name, never its value) is fetched when the
 * dialog opens and held in local state; closing the dialog discards every field, so no secret is stored
 * in a global cache.
 */
export function AgentEditor({
  open,
  agentId,
  scope,
  onClose,
  onSaved,
  onTested,
}: {
  open: boolean;
  /** Null creates a definition. */
  agentId: string | null;
  scope: AgentScope;
  onClose: () => void;
  onSaved: (detail: N8nAgentDetail) => void;
  /** Refresh the list's status evidence after an explicit test. */
  onTested?: () => void;
}) {
  const formId = useId();
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [stored, setStored] = useState<N8nAgentDetail | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [avatar, setAvatar] = useState<string>("workflow");
  const [enabled, setEnabled] = useState(true);
  const [config, setConfig] = useState<N8nAgentPublicConfig>(createConfig);
  const [timeoutSec, setTimeoutSec] = useState("120");
  const [idleSec, setIdleSec] = useState("60");
  const [authName, setAuthName] = useState("");
  const [authValue, setAuthValue] = useState("");
  const [authAction, setAuthAction] = useState<AuthAction>("none");
  const [reveal, setReveal] = useState(false);
  const [audience, setAudience] = useState<ShareAudience>(EVERYONE);
  const [protocolReview, setProtocolReview] = useState(false);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);

  const hydrate = (detail: N8nAgentDetail) => {
    setStored(detail);
    setRevision(detail.revision);
    setName(detail.name);
    setDescription(detail.description);
    setAvatar(detail.avatar);
    setEnabled(detail.enabled);
    setConfig(detail.config);
    setTimeoutSec(String(Math.round(detail.config.timeoutMs / 1000)));
    setIdleSec(String(Math.round(detail.config.idleTimeoutMs / 1000)));
    setAuthName(detail.authHeader?.name ?? "");
    setAuthValue("");
    setAuthAction(detail.authHeader?.configured ? "keep" : "none");
    setReveal(false);
    setAudience(detail.audience ?? EVERYONE);
    setProtocolReview(false);
    setProblems({});
    setSaveError(null);
    setConflict(false);
  };

  const reset = () => {
    setStored(null);
    setRevision(null);
    setName("");
    setDescription("");
    setAvatar("workflow");
    setEnabled(true);
    setConfig(createConfig());
    setTimeoutSec("120");
    setIdleSec("60");
    setAuthName("");
    setAuthValue("");
    setAuthAction("none");
    setReveal(false);
    setAudience(EVERYONE);
    setProtocolReview(false);
    setProblems({});
    setSaveError(null);
    setConflict(false);
    setBusy(false);
    setLoaded(true);
    setLoadFailed(false);
  };

  useEffect(() => {
    if (!open) {
      // Closing drops the decrypted detail, the URL (a path or query can be a credential), and any typed secret.
      setName("");
      setDescription("");
      setConfig(createConfig());
      setAuthName("");
      setAuthValue("");
      setAuthAction("none");
      setAudience(EVERYONE);
      setStored(null);
      setRevision(null);
      setLoaded(false);
      setLoadFailed(false);
      return;
    }
    let live = true;
    setLoaded(false);
    setLoadFailed(false);
    setStored(null);
    setRevision(null);
    setAuthValue("");
    setAuthName("");
    setProblems({});
    setSaveError(null);
    setConflict(false);
    if (!agentId) {
      reset();
      return () => {
        live = false;
      };
    }
    api<N8nAgentDetail>(`${basePath(scope)}/${encodeURIComponent(agentId)}`).then(
      (detail) => {
        if (!live) return;
        hydrate(detail);
        setLoaded(true);
      },
      () => {
        if (!live) return;
        setLoadFailed(true);
        setLoaded(true);
      },
    );
    return () => {
      live = false;
    };
    // `reset` and `hydrate` only touch state setters; the request key is the dialog and the definition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agentId, scope]);

  const patch = (next: Partial<N8nAgentPublicConfig>) => setConfig((current) => ({ ...current, ...next }));

  const changeProtocol = (protocol: N8nProtocol) => {
    // A new agent starts with the preset's keys and memory. Editing never rewrites saved fields silently.
    if (stored) {
      setProtocolReview(protocol !== stored.config.protocol);
      patch({ protocol });
    } else {
      // On a new agent the preset fills untouched keys and memory once; a customized form is left alone.
      const previous = protocolPreset(config.protocol);
      const customized =
        config.inputKey !== previous.inputKey ||
        config.sessionKey !== previous.sessionKey ||
        config.historyKey !== previous.historyKey ||
        config.memoryMode !== previous.memoryMode;
      patch({ protocol, ...(customized ? {} : protocolPreset(protocol)) });
    }
  };

  const storedSecret = stored?.authHeader?.configured === true;
  const headerRequired = storedSecret ? authAction === "replace" : authName.trim().length > 0;

  const authPayload = (): N8nAgentInput["authHeader"] | undefined => {
    if (storedSecret) {
      if (authAction === "keep") return undefined;
      if (authAction === "remove") return null;
      return { name: authName.trim(), value: authValue };
    }
    return authName.trim() ? { name: authName.trim(), value: authValue } : null;
  };

  const input = (): N8nAgentInput => ({
    name: name.trim(),
    description: description.trim(),
    avatar,
    enabled,
    config: {
      ...config,
      responsePointer: config.responsePointer?.trim() ? config.responsePointer.trim() : null,
      timeoutMs: Math.round(Number(timeoutSec) * 1000),
      idleTimeoutMs: Math.round(Number(idleSec) * 1000),
    },
    authHeader: authPayload(),
    ...(scope === "shared" ? { audience } : {}),
  });

  const validate = (): Record<string, string> => {
    const next: Record<string, string> = {};
    if ([...name.trim()].length < 1 || [...name.trim()].length > N8N_LIMITS.nameChars) next.name = t("agents.validationName", { max: N8N_LIMITS.nameChars });
    if ([...description.trim()].length > N8N_LIMITS.descriptionChars) next.description = t("agents.validationLimit", { max: N8N_LIMITS.descriptionChars });
    const badUrl = urlProblem(config.webhookUrl.trim());
    if (badUrl) next.webhookUrl = t(badUrl);
    const keys = [config.inputKey, config.sessionKey, config.historyKey];
    if (new Set(keys).size !== keys.length || keys.some((key) => !KEY.test(key) || RESERVED.has(key))) next.keys = t("agents.validationKeys");
    const timeout = Number(timeoutSec);
    const idle = Number(idleSec);
    if (!Number.isFinite(timeout) || !Number.isFinite(idle) || timeout < N8N_LIMITS.timeoutMin / 1000 || timeout > N8N_LIMITS.timeoutMax / 1000 || idle < N8N_LIMITS.idleMin / 1000 || idle > N8N_LIMITS.idleMax / 1000 || idle > timeout) {
      next.timeout = t("agents.validationTimeout", { min: N8N_LIMITS.idleMin / 1000, max: N8N_LIMITS.timeoutMax / 1000 });
    }
    if ((config.responseMode === "auto" || config.responseMode === "json") && pointerProblem(config.responsePointer?.trim() ?? "")) next.responsePointer = t("agents.validationPointer");
    if (storedSecret && authAction === "keep" && (config.webhookUrl.trim() !== stored?.config.webhookUrl || authName.trim() !== stored?.authHeader?.name)) {
      next.auth = t("agents.validationSecretReentry");
    }
    if (headerRequired) {
      if (!HEADER.test(authName.trim()) || DENIED_HEADER.test(authName.trim())) next.authName = t("agents.validationHeaderName");
      if (!authValue || /[\u0000-\u001f\u007f]/.test(authValue) || new TextEncoder().encode(authValue).length > N8N_LIMITS.authValueBytes) {
        next.authValue = t("agents.validationHeaderValue", { max: N8N_LIMITS.authValueBytes });
      }
    } else if (!storedSecret && !authName.trim() && authValue) {
      next.authName = t("agents.validationHeaderName");
    }
    return next;
  };

  const submit = async () => {
    if (busy || !loaded || loadFailed || conflict) return;
    const found = validate();
    setProblems(found);
    setSaveError(null);
    if (Object.keys(found).length) {
      const key = Object.keys(found)[0]!;
      const focusId = key === "keys" ? field("inputKey") : key === "timeout" ? field("timeout") : key === "auth" ? field("authName") : field(key);
      requestAnimationFrame(() => document.getElementById(focusId)?.focus());
      return;
    }
    setBusy(true);
    try {
      const body = input();
      const detail = agentId
        ? await api<N8nAgentDetail>(`${basePath(scope)}/${encodeURIComponent(agentId)}`, { method: "PUT", json: { revision, ...body } })
        : await api<N8nAgentDetail>(basePath(scope), { method: "POST", json: body });
      setStored(detail);
      setRevision(detail.revision);
      onSaved(detail);
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      else setSaveError(agentErrorText(error).message);
    } finally {
      setBusy(false);
    }
  };

  const reloadSaved = async () => {
    if (!agentId) return;
    setBusy(true);
    setSaveError(null);
    try {
      const detail = await api<N8nAgentDetail>(`${basePath(scope)}/${encodeURIComponent(agentId)}`);
      hydrate(detail);
    } catch (error) {
      setSaveError(agentErrorText(error).message);
    } finally {
      setBusy(false);
    }
  };

  useCommand("agents.save", () => void submit(), open && loaded && !busy && !conflict);

  const invalidatesKey = JSON.stringify([config, timeoutSec, idleSec, authName, authValue, authAction]);
  const isCreate = agentId === null;
  // An unchanged saved form tests the stored definition (which records status); any config or auth change
  // is sent as an overlay, and the server refuses to reuse a hidden secret across a new destination.
  const testOverlay = (() => {
    if (!stored) return input();
    const body = input();
    const sameConfig = JSON.stringify(body.config) === JSON.stringify(stored.config);
    const sameAuth = body.authHeader === undefined || (body.authHeader === null && !stored.authHeader?.configured);
    return sameConfig && sameAuth ? undefined : body;
  })();
  const field = (key: string) => `${formId}-${key}`;
  const described = (key: string) => (problems[key] ? `${field(key)}-error` : undefined);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent
        showCloseButton={!busy}
        className="flex max-h-[min(92dvh,52rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl max-sm:top-0! max-sm:left-0! max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:translate-x-0! max-sm:translate-y-0! max-sm:rounded-none"
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        >
          <DialogHeader className="border-b px-4 py-3 pe-12 sm:px-6">
            <DialogTitle className="text-base">{isCreate ? t("agents.createTitle") : t("agents.editTitle")}</DialogTitle>
            <DialogDescription className="text-xs">{t("agents.intro")}</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
            {!loaded && (
              <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
                <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" /> {t("common.loading")}
              </p>
            )}
            {loaded && loadFailed && (
              <p role="alert" className="text-destructive text-sm">
                {t("agents.loadFailed")}
              </p>
            )}
            {loaded && !loadFailed && (
              <div className="flex flex-col gap-6">
                <section className="flex flex-col gap-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="font-medium">{t("agents.name")}</span>
                      <Input
                        className="pointer-coarse:h-11"
                        id={field("name")}
                        value={name}
                        maxLength={N8N_LIMITS.nameChars}
                        onChange={(event) => setName(event.target.value)}
                        aria-invalid={!!problems.name}
                        aria-describedby={described("name")}
                        autoFocus
                      />
                      {problems.name && <span id={`${field("name")}-error`} role="alert" className="text-destructive wrap-break-word">{problems.name}</span>}
                    </label>
                    <div className="flex flex-col gap-1 text-xs">
                      <span className="font-medium">{t("agents.avatar")}</span>
                      <div role="group" aria-label={t("agents.avatar")} className="flex gap-1.5">
                        {AVATAR_OPTIONS.map((option) => (
                          <button
                            key={option.id}
                            type="button"
                            aria-label={t(option.label)}
                            aria-pressed={avatar === option.id}
                            onClick={() => setAvatar(option.id)}
                            className={cn(
                              "flex size-10 pointer-coarse:size-11 items-center justify-center rounded-xl border transition-colors duration-(--motion-fast)",
                              avatar === option.id ? "border-primary bg-primary/10" : "hover:bg-muted",
                            )}
                          >
                            <AgentAvatar avatar={option.id} size="sm" />
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="font-medium">{t("agents.description")}</span>
                    <Textarea
                      id={field("description")}
                      value={description}
                      maxLength={N8N_LIMITS.descriptionChars}
                      onChange={(event) => setDescription(event.target.value)}
                      className="min-h-16 pointer-coarse:min-h-20"
                      aria-invalid={!!problems.description}
                      aria-describedby={described("description")}
                    />
                    {problems.description && <span id={`${field("description")}-error`} role="alert" className="text-destructive">{problems.description}</span>}
                  </label>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{t("agents.enabled")}</p>
                      <p className="text-muted-foreground text-xs">{t("agents.addToPicker")}</p>
                    </div>
                    <Switch checked={enabled} onCheckedChange={setEnabled} aria-label={t("agents.enabled")} />
                  </div>
                </section>

                <section className="flex flex-col gap-3">
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="font-medium">{t("agents.webhookUrl")}</span>
                    <Input
                      className="pointer-coarse:h-11"
                      id={field("webhookUrl")}
                      value={config.webhookUrl}
                      onChange={(event) => patch({ webhookUrl: event.target.value })}
                      inputMode="url"
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={!!problems.webhookUrl}
                      aria-describedby={described("webhookUrl") ?? field("webhookUrl-hint")}
                    />
                    <span id={field("webhookUrl-hint")} className="text-muted-foreground wrap-break-word">{t("agents.productionUrlHint")}</span>
                    {problems.webhookUrl && <span id={`${field("webhookUrl")}-error`} role="alert" className="text-destructive wrap-break-word">{problems.webhookUrl}</span>}
                  </label>
                  <div className="flex flex-col gap-1 text-xs">
                    <span className="font-medium">{t("agents.protocol")}</span>
                    <Select
                      className="pointer-coarse:h-11"
                      aria-label={t("agents.protocol")}
                      value={config.protocol}
                      onValueChange={changeProtocol}
                      options={[
                        { value: "webhook", label: t("agents.protocolWebhook") },
                        { value: "chat-trigger", label: t("agents.protocolChatTrigger") },
                      ]}
                    />
                    {(isCreate || protocolReview) && <span className="text-muted-foreground">{t("agents.protocolHint")}</span>}
                  </div>
                </section>

                <section className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{t("agents.authHeader")}</span>
                    {storedSecret && (
                      <span className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5">{t("agents.authConfigured")}</span>
                        <Button type="button" size="xs" variant="outline" aria-pressed={authAction === "replace"} onClick={() => setAuthAction("replace")}>
                          {t("agents.authReplace")}
                        </Button>
                        <Button type="button" size="xs" variant="outline" aria-pressed={authAction === "keep"} onClick={() => setAuthAction("keep")}>
                          {t("agents.authKeep")}
                        </Button>
                        <Button type="button" size="xs" variant="ghost" aria-pressed={authAction === "remove"} onClick={() => setAuthAction("remove")}>
                          {t("agents.authRemove")}
                        </Button>
                      </span>
                    )}
                  </div>
                  {(!storedSecret || authAction !== "remove") && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="font-medium">{t("agents.authName")}</span>
                        <Input
                          className="pointer-coarse:h-11"
                          id={field("authName")}
                          value={authName}
                          onChange={(event) => setAuthName(event.target.value)}
                          autoComplete="off"
                          spellCheck={false}
                          aria-invalid={!!problems.authName}
                          aria-describedby={described("authName")}
                        />
                        {problems.authName && <span id={`${field("authName")}-error`} role="alert" className="text-destructive wrap-break-word">{problems.authName}</span>}
                      </label>
                      {(!storedSecret || authAction === "replace") ? (
                        <label className="flex flex-col gap-1 text-xs">
                          <span className="font-medium">{t("agents.authValue")}</span>
                          <span className="flex gap-1">
                            <Input
                              className="pointer-coarse:h-11"
                              id={field("authValue")}
                              type={reveal ? "text" : "password"}
                              value={authValue}
                              onChange={(event) => setAuthValue(event.target.value)}
                              autoComplete="off"
                              aria-invalid={!!problems.authValue}
                              aria-describedby={described("authValue")}
                            />
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              aria-label={t("agents.authReveal")}
                              aria-pressed={reveal}
                              onClick={() => setReveal((value) => !value)}
                              className="pointer-coarse:size-11"
                            >
                              {reveal ? <EyeOffIcon /> : <EyeIcon />}
                            </Button>
                          </span>
                          {problems.authValue && <span id={`${field("authValue")}-error`} role="alert" className="text-destructive wrap-break-word">{problems.authValue}</span>}
                        </label>
                      ) : (
                        <div className="flex flex-col gap-1 text-xs">
                          <span className="font-medium">{t("agents.authValue")}</span>
                          <span className="bg-muted/60 text-muted-foreground flex h-8 items-center rounded-lg border px-2.5">{t("agents.authConfigured")}</span>
                        </div>
                      )}
                    </div>
                  )}
                  {problems.auth && <p id={`${field("auth")}-error`} role="alert" className="text-destructive text-xs wrap-break-word">{problems.auth}</p>}
                  {storedSecret && authAction === "keep" && <p className="text-muted-foreground text-xs">{t("agents.authReenter")}</p>}
                </section>

                <section className="flex flex-col gap-2">
                  <span className="text-sm font-medium">{t("agents.memory")}</span>
                  <Select
                    className="pointer-coarse:h-11"
                    aria-label={t("agents.memory")}
                    value={config.memoryMode}
                    onValueChange={(memoryMode) => patch({ memoryMode })}
                    options={(Object.keys(MEMORY_LABELS) as N8nMemoryMode[]).map((mode) => ({ value: mode, label: t(MEMORY_LABELS[mode]) }))}
                  />
                  <p className="text-muted-foreground text-xs">{t(MEMORY_HINTS[config.memoryMode])}</p>
                  {config.memoryMode === "history" && <p className="text-muted-foreground text-xs">{t("agents.historyRequiresWorkflow")}</p>}
                  {config.memoryMode === "remote" && <p className="text-muted-foreground text-xs">{t("agents.remoteRetention")}</p>}
                </section>

                <details className="rounded-xl border">
                  <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t("agents.advanced")}</summary>
                  <div className="flex flex-col gap-3 border-t p-3">
                    <div className="grid gap-3 sm:grid-cols-3">
                      {([
                        ["inputKey", "agents.inputKey"],
                        ["sessionKey", "agents.sessionKey"],
                        ["historyKey", "agents.historyKey"],
                      ] as const).map(([key, label]) => (
                        <label key={key} className="flex flex-col gap-1 text-xs">
                          <span className="font-medium">{t(label)}</span>
                          <Input
                            className="pointer-coarse:h-11"
                            id={field(key)}
                            value={config[key]}
                            onChange={(event) => patch({ [key]: event.target.value })}
                            autoComplete="off"
                            spellCheck={false}
                            aria-invalid={!!problems.keys}
                            aria-describedby={described("keys")}
                          />
                        </label>
                      ))}
                    </div>
                    {problems.keys && <p id={`${field("keys")}-error`} role="alert" className="text-destructive text-xs wrap-break-word">{problems.keys}</p>}
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="flex flex-col gap-1 text-xs">
                        <span className="font-medium">{t("agents.responseMode")}</span>
                        <Select
                          className="pointer-coarse:h-11"
                          aria-label={t("agents.responseMode")}
                          value={config.responseMode}
                          onValueChange={(responseMode) => patch({ responseMode, ...(responseMode !== "auto" && responseMode !== "json" ? { responsePointer: null } : {}) })}
                          options={(Object.keys(RESPONSE_LABELS) as N8nResponseMode[]).map((mode) => ({ value: mode, label: t(RESPONSE_LABELS[mode]) }))}
                        />
                      </div>
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="font-medium">{t("agents.responsePointer")}</span>
                        <Input
                          className="pointer-coarse:h-11"
                          id={field("responsePointer")}
                          value={config.responsePointer ?? ""}
                          onChange={(event) => patch({ responsePointer: event.target.value || null })}
                          disabled={config.responseMode !== "auto" && config.responseMode !== "json"}
                          autoComplete="off"
                          spellCheck={false}
                          aria-invalid={!!problems.responsePointer}
                          aria-describedby={described("responsePointer") ?? field("responsePointer-hint")}
                        />
                        <span id={field("responsePointer-hint")} className="text-muted-foreground">{t("agents.responsePointerHint")}</span>
                        {problems.responsePointer && <span id={`${field("responsePointer")}-error`} role="alert" className="text-destructive">{problems.responsePointer}</span>}
                      </label>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {([
                        ["timeout", "agents.timeout", timeoutSec, setTimeoutSec],
                        ["idle", "agents.idleTimeout", idleSec, setIdleSec],
                      ] as const).map(([key, label, value, set]) => (
                        <label key={key} className="flex flex-col gap-1 text-xs">
                          <span className="font-medium">
                            {t(label)} ({t("agents.seconds")})
                          </span>
                          <Input
                            className="pointer-coarse:h-11"
                            id={field(key === "timeout" ? "timeout" : "idle")}
                            type="number"
                            min={N8N_LIMITS.idleMin / 1000}
                            max={N8N_LIMITS.timeoutMax / 1000}
                            step={1}
                            value={value}
                            onChange={(event) => set(event.target.value)}
                            aria-invalid={!!problems.timeout}
                            aria-describedby={described("timeout")}
                          />
                        </label>
                      ))}
                    </div>
                    {problems.timeout && <p id={`${field("timeout")}-error`} role="alert" className="text-destructive text-xs">{problems.timeout}</p>}
                  </div>
                </details>

                {scope === "shared" && (
                  <SharedAudienceField audience={audience} onSave={setAudience} />
                )}

                <div className="border-t pt-4">
                  <AgentTestPanel
                    agentId={agentId ?? undefined}
                    revision={revision ?? undefined}
                    input={testOverlay}
                    invalidatesKey={invalidatesKey}
                    disabled={busy || !config.webhookUrl.trim() || !name.trim()}
                    testPath={scope === "shared" ? "/admin/agents/n8n/test" : "/agents/n8n/test"}
                    onResult={() => {
                      if (agentId) void useN8nAgents.getState().refreshStatuses();
                      onTested?.();
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="bg-background/95 sticky bottom-0 gap-2 border-t px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:px-6">
            {conflict && (
              <div className="me-auto flex min-w-0 flex-wrap items-center gap-2 text-xs">
                <span role="alert" className="text-warning flex items-center gap-1.5">
                  <TriangleAlertIcon className="size-3.5 shrink-0" /> {t("agents.conflict")}
                </span>
                <Button type="button" size="xs" variant="outline" onClick={() => void reloadSaved()} disabled={busy}>
                  {t("agents.reloadSaved")}
                </Button>
              </div>
            )}
            {saveError && !conflict && <p role="alert" className="text-destructive me-auto min-w-0 text-xs wrap-break-word">{saveError}</p>}
            <DialogClose type="button" disabled={busy} render={<Button variant="outline" className="min-h-10 pointer-coarse:min-h-11" />}>
              {t("agents.cancel")}
            </DialogClose>
            <Button type="submit" disabled={busy || !loaded || loadFailed || conflict} data-command="agents.save" className="min-h-10 pointer-coarse:min-h-11">
              {busy && <Loader2Icon className="animate-spin motion-reduce:animate-none" />}
              {t("agents.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Admin-only audience picker. Kept separate so an ordinary account never requests the admin directory. */
function SharedAudienceField({ audience, onSave }: { audience: ShareAudience; onSave: (audience: ShareAudience) => void }) {
  const { groups } = useDirectory();
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm font-medium">{t("agents.shared")}</span>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} aria-label={`${t("agents.shared")}: ${audienceLabel(audience, groups)}`}>
        {audienceLabel(audience, groups)}
      </Button>
      <AudienceDialog
        open={open}
        title={t("agents.shared")}
        description={t("agents.intro")}
        audience={audience}
        onClose={() => setOpen(false)}
        onSave={onSave}
      />
    </section>
  );
}
