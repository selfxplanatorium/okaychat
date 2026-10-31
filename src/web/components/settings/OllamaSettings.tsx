import { AlertCircleIcon, CheckCircle2Icon, DownloadIcon, Loader2Icon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { OllamaInventory, OllamaPullProgress, ProviderInfo } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t, type PlainMessageKey } from "@/i18n";
import { formatBytes, formatPercent, formatTokens } from "@/i18n/format";
import { api } from "@/lib/api";
import { useCommand } from "@/keyboard/registry";

type Scope = "/providers" | "/admin/providers";
const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";
type Status =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; version?: string; modelCount: number; loadedCount: number }
  | { kind: "error"; message: string };

const CAPABILITIES = {
  completion: "providers.ollamaCapCompletion",
  tools: "providers.ollamaCapTools",
  vision: "providers.ollamaCapVision",
  thinking: "providers.ollamaCapThinking",
  embedding: "providers.ollamaCapEmbedding",
} as const satisfies Record<string, PlainMessageKey>;

const capabilityLabel = (name: string): string =>
  Object.hasOwn(CAPABILITIES, name) ? t(CAPABILITIES[name as keyof typeof CAPABILITIES]) : name;

const normalizeURL = (url: string) => url.trim().replace(/\/+$/, "");

function StatusLine({ status, shared, connected }: { status: Status; shared: boolean; connected: boolean }) {
  if (status.kind === "checking") {
    return (
      <p role="status" aria-live="polite" className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Loader2Icon className="size-3.5 animate-spin" /> {t("providers.ollamaStatusChecking")}
      </p>
    );
  }
  if (status.kind === "ok") {
    return (
      <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-success flex items-center gap-1.5 font-medium">
          <CheckCircle2Icon className="size-3.5" />{" "}
          {!connected ? t("providers.ollamaStatusReachable") : shared ? t("providers.ollamaStatusShared") : t("providers.ollamaStatusConnected")}
        </span>
        {status.version && <span className="text-muted-foreground">{t("providers.ollamaVersion", { version: status.version })}</span>}
        <span className="text-muted-foreground">{t("providers.modelCount", { count: status.modelCount })}</span>
        {status.loadedCount > 0 && <span className="text-muted-foreground">{t("providers.ollamaLoadedCount", { count: status.loadedCount })}</span>}
      </div>
    );
  }
  if (status.kind === "error") {
    return (
      <p role="status" aria-live="polite" className="text-error flex flex-wrap items-center gap-1.5 text-xs">
        <AlertCircleIcon className="size-3.5 shrink-0" /> {status.message}
      </p>
    );
  }
  return <p className="text-muted-foreground text-xs">{t("providers.ollamaStatusDisconnected")}</p>;
}

function Progress({ model, progress, cancelled }: { model: string; progress: OllamaPullProgress | null; cancelled: boolean }) {
  if (cancelled) {
    return (
      <div role="status" aria-live="polite" className="flex flex-col gap-1 text-xs">
        <span>{t("providers.ollamaPullCancelled")}</span>
        <span className="text-muted-foreground">{t("providers.ollamaPullCancelNote")}</span>
      </div>
    );
  }
  if (!progress) {
    return (
      <p role="status" aria-live="polite" className="text-muted-foreground text-xs">
        {t("providers.ollamaPulling", { model })}
      </p>
    );
  }
  const total = progress.total;
  const completed = progress.completed;
  const known = total !== undefined && total > 0 && completed !== undefined;
  const fraction = known ? Math.max(0, Math.min(1, completed / total)) : 0;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-xs" role="status" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="truncate">{t("providers.ollamaPullStatus", { status: progress.status })}</span>
        {known && <span className="text-muted-foreground tabular-nums">{formatPercent(fraction)}</span>}
      </div>
      {known && (
        <div
          role="progressbar"
          aria-label={t("providers.ollamaPullProgress", { model })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fraction * 100)}
          className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
        >
          <div className="bg-primary h-full rounded-full transition-[width] duration-(--motion-base)" style={{ width: `${fraction * 100}%` }} />
        </div>
      )}
      {known && (
        <span className="text-muted-foreground tabular-nums">
          {t("providers.ollamaPullBytes", { completed: formatBytes(completed), total: formatBytes(total) })}
        </span>
      )}
      {progress.digest && <span className="text-muted-foreground truncate font-mono">{progress.digest.slice(0, 19)}</span>}
    </div>
  );
}

function DeleteModelDialog({
  model,
  busy,
  error,
  onOpenChange,
  onConfirm,
}: {
  model: string | null;
  busy: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const open = model !== null;
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">{t("providers.ollamaDeleteTitle")}</DialogTitle>
          <DialogDescription>{model ? t("providers.ollamaDeleteBody", { model }) : ""}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose disabled={busy} render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => void onConfirm()}>
            {busy && <Loader2Icon className="animate-spin" />} {t("common.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Ollama's own panel inside the Providers page: native address, health, installed metadata, loaded
 * models, pull progress, and delete. Shared viewers get the read-only half.
 */
export function OllamaSettings({ provider, base, onChanged }: { provider: ProviderInfo; base: Scope; onChanged: () => Promise<void> }) {
  const manage = base === "/admin/providers" || !provider.shared;
  const savedURL = provider.baseURL ?? OLLAMA_DEFAULT_URL;
  const [url, setURL] = useState(savedURL);
  const [status, setStatus] = useState<Status>(provider.connected ? { kind: "checking" } : { kind: "idle" });
  const [inventory, setInventory] = useState<OllamaInventory | null>(null);
  const [loading, setLoading] = useState(provider.connected);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pullModel, setPullModel] = useState("");
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<OllamaPullProgress | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [pullCancelled, setPullCancelled] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const pullInput = useRef<HTMLInputElement>(null);
  const pullController = useRef<AbortController | null>(null);
  const inventoryController = useRef<AbortController | null>(null);
  const pullActive = useRef(false);
  const saveActive = useRef(false);
  const deleteActive = useRef(false);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const urlId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pullController.current?.abort();
      inventoryController.current?.abort();
    };
  }, []);

  useEffect(() => setURL(savedURL), [savedURL]);

  const loadInventory = useCallback(async () => {
    if (!provider.connected) return;
    inventoryController.current?.abort();
    const controller = new AbortController();
    inventoryController.current = controller;
    const current = ++sequence.current;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api<OllamaInventory>(`${base}/ollama/models`, { signal: controller.signal });
      if (!mounted.current || current !== sequence.current) return;
      setInventory(data);
      setStatus({ kind: "ok", version: data.status.version, modelCount: data.status.modelCount, loadedCount: data.status.loadedCount });
      // The provider row's count came from a cache-first listing; refresh it now that the inventory is known.
      void onChanged().catch(() => {});
    } catch (error) {
      if (controller.signal.aborted || !mounted.current || current !== sequence.current) return;
      setLoadError((error as Error).message);
      setStatus({ kind: "error", message: (error as Error).message });
    } finally {
      if (mounted.current && current === sequence.current) setLoading(false);
    }
  }, [base, onChanged, provider.connected]);

  useEffect(() => {
    if (provider.connected) void loadInventory();
  }, [loadInventory, provider.connected]);

  const testConnection = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    setStatus({ kind: "checking" });
    setSaveError(null);
    try {
      const data = await api<{ url: string; version?: string; modelCount: number; loadedCount: number }>(`${base}/ollama/test`, {
        method: "POST",
        json: url.trim() ? { baseURL: url.trim() } : {},
      });
      if (!mounted.current) return;
      setStatus({ kind: "ok", version: data.version, modelCount: data.modelCount, loadedCount: data.loadedCount });
      if (provider.connected && normalizeURL(data.url) === normalizeURL(savedURL)) void loadInventory();
    } catch (error) {
      if (!mounted.current) return;
      setStatus({ kind: "error", message: (error as Error).message });
    } finally {
      if (mounted.current) setTesting(false);
    }
  }, [base, loadInventory, provider.connected, savedURL, testing, url]);

  const saveAddress = async () => {
    if (saveActive.current) return;
    saveActive.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await api(`${base}/${provider.id}`, { method: "PUT", json: { baseURL: normalizeURL(url) || undefined, enabled: true } });
      await onChanged();
      await testConnection();
    } catch (error) {
      setSaveError((error as Error).message);
    } finally {
      saveActive.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const startPull = async () => {
    const model = pullModel.trim();
    if (!model || pullActive.current || !manage) return;
    pullActive.current = true;
    const controller = new AbortController();
    pullController.current = controller;
    setPulling(true);
    setPullError(null);
    setPullCancelled(false);
    setPullProgress(null);
    let complete = false;
    try {
      const res = await fetch(`/api${base}/ollama/pull`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
        signal: controller.signal,
      });
      if (res.status === 401) window.dispatchEvent(new Event("okaychat:unauthorized"));
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? t("providers.ollamaPullFailed"));
      }
      if (!res.body) throw new Error(t("providers.ollamaPullFailed"));
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            const event = JSON.parse(line) as OllamaPullProgress & { error?: string };
            if (event.error) throw new Error(event.error);
            if (!mounted.current) return;
            setPullProgress(event);
            if (event.status === "success") complete = true;
          }
          newline = buffer.indexOf("\n");
        }
      }
      const tail = buffer.trim();
      if (tail) {
        const event = JSON.parse(tail) as OllamaPullProgress & { error?: string };
        if (event.error) throw new Error(event.error);
        if (event.status === "success") complete = true;
      }
      if (!complete) throw new Error(t("providers.ollamaPullFailed"));
    } catch (error) {
      if (controller.signal.aborted) {
        if (mounted.current) setPullCancelled(true);
      } else if (mounted.current) {
        setPullError((error as Error).message);
      }
    } finally {
      pullActive.current = false;
      if (pullController.current === controller) pullController.current = null;
      if (mounted.current) setPulling(false);
      if (complete && mounted.current) void loadInventory();
    }
  };

  const deleteModel = async () => {
    if (!deleteTarget || deleteActive.current) return;
    deleteActive.current = true;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api(`${base}/ollama/models`, { method: "DELETE", json: { model: deleteTarget } });
      if (!mounted.current) return;
      setDeleteTarget(null);
      await loadInventory();
    } catch (error) {
      if (mounted.current) setDeleteError((error as Error).message);
    } finally {
      deleteActive.current = false;
      if (mounted.current) setDeleting(false);
    }
  };

  useCommand("settings.ollamaTest", () => {
    void testConnection();
  });
  useCommand("settings.ollamaSave", () => {
    if (!manage || saveActive.current) return false;
    void saveAddress();
  });
  useCommand("settings.ollamaRefresh", () => {
    if (!provider.connected) return false;
    void loadInventory();
  });
  useCommand("settings.ollamaPull", () => {
    if (!manage || pulling) return false;
    pullInput.current?.focus();
  });
  useCommand("settings.ollamaCancelPull", () => {
    if (!pulling) return false;
    pullController.current?.abort();
  });
  useCommand("settings.ollamaDelete", () => {
    if (!manage || !activeModel) return false;
    setDeleteError(null);
    setDeleteTarget(activeModel);
  });

  const modelCount = status.kind === "ok" ? status.modelCount : inventory?.status.modelCount;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <label htmlFor={urlId} className="text-xs font-medium">
          {t("providers.ollamaAddressLabel")}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={urlId}
            value={url}
            onChange={(event) => setURL(event.target.value)}
            placeholder={t("providers.ollamaAddressPlaceholder")}
            autoComplete="off"
            readOnly={!manage}
            disabled={saving || testing}
            className="min-w-0 flex-1"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={testing || saving}
              onClick={() => void testConnection()}
              className="pointer-coarse:h-10"
            >
              {testing ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} {t("providers.ollamaTest")}
            </Button>
            {manage && (
              <Button
                type="button"
                disabled={saving || testing || (provider.connected && normalizeURL(url) === normalizeURL(savedURL))}
                onClick={() => void saveAddress()}
                className="pointer-coarse:h-10"
              >
                {saving && <Loader2Icon className="animate-spin" />}
                {provider.connected ? t("common.save") : t("providers.ollamaConnect")}
              </Button>
            )}
          </div>
        </div>
        <p className="text-muted-foreground text-xs">{t("providers.ollamaUrlHint")}</p>
        <StatusLine status={status} shared={!!provider.shared} connected={provider.connected} />
        {saveError && (
          <p role="alert" className="text-error text-xs">
            {saveError}
          </p>
        )}
        {provider.shared && <p className="text-muted-foreground text-xs">{t("providers.ollamaSharedHint")}</p>}
      </div>

      {provider.connected && (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-medium">{t("providers.ollamaModelsTitle", { count: modelCount ?? 0 })}</h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={loading || testing}
              onClick={() => void loadInventory()}
              aria-label={t("providers.ollamaRefresh")}
              className="pointer-coarse:h-9"
            >
              <RefreshCwIcon className={loading ? "animate-spin" : undefined} /> {t("providers.ollamaRefresh")}
            </Button>
          </div>

          {loading && !inventory && (
            <p role="status" aria-live="polite" className="text-muted-foreground flex items-center gap-2 px-1 py-3 text-xs">
              <Loader2Icon className="size-3.5 animate-spin" /> {t("providers.ollamaLoading")}
            </p>
          )}
          {loadError && (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 px-3 py-2 text-xs">
              <span className="text-error">{loadError}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => void loadInventory()}>
                {t("providers.ollamaRetry")}
              </Button>
            </div>
          )}
          {!loading && !loadError && inventory?.models.length === 0 && (
            <p className="text-muted-foreground px-1 py-3 text-xs">{t("providers.ollamaEmpty")}</p>
          )}
          {inventory && inventory.models.length > 0 && (
            <ul aria-label={t("providers.ollamaModelsAria")} className="divide-border flex flex-col divide-y rounded-lg border">
              {inventory.models.map((model) => (
                <li
                  key={model.name}
                  className="flex min-w-0 flex-col gap-2 px-3 py-3 sm:flex-row sm:items-start sm:justify-between"
                  onFocusCapture={() => setActiveModel(model.name)}
                  onMouseEnter={() => setActiveModel(model.name)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span title={model.name} className="truncate text-sm font-medium">{model.name}</span>
                      {model.loaded && (
                        <span className="bg-success/10 text-success inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium">
                          <CheckCircle2Icon className="size-3" /> {t("providers.ollamaLoaded")}
                        </span>
                      )}
                      {model.showError && (
                        <span title={model.showError} className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium">
                          {t("providers.ollamaMetadataUnavailable")}
                        </span>
                      )}
                    </div>
                    <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums">
                      {model.family && <span>{model.family}</span>}
                      {model.parameterSize && <span>{t("providers.ollamaParameters", { size: model.parameterSize })}</span>}
                      <span>{t("providers.ollamaContext", { tokens: formatTokens(model.context) })}</span>
                      <span>{t("providers.ollamaSize", { size: formatBytes(model.size) })}</span>
                      {model.quantization && <span className="font-mono">{model.quantization}</span>}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {model.capabilities.map((capability) => (
                        <span key={capability} className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium">
                          {capabilityLabel(capability)}
                        </span>
                      ))}
                    </div>
                  </div>
                  {manage && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("providers.ollamaDelete", { model: model.name })}
                      disabled={deleting}
                      onClick={() => {
                        setActiveModel(model.name);
                        setDeleteError(null);
                        setDeleteTarget(model.name);
                      }}
                      className="pointer-coarse:size-10 shrink-0 self-end text-muted-foreground hover:text-destructive sm:self-start"
                    >
                      <Trash2Icon />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {manage && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void startPull();
              }}
            >
              <label htmlFor={`${urlId}-pull`} className="text-xs font-medium">
                {t("providers.ollamaPullTitle")}
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id={`${urlId}-pull`}
                  ref={pullInput}
                  value={pullModel}
                  onChange={(event) => setPullModel(event.target.value)}
                  placeholder={t("providers.ollamaPullPlaceholder")}
                  autoComplete="off"
                  disabled={pulling}
                  className="min-w-0 flex-1"
                />
                {pulling ? (
                  <Button type="button" variant="outline" onClick={() => pullController.current?.abort()} className="pointer-coarse:h-10">
                    {t("providers.ollamaCancelPull")}
                  </Button>
                ) : (
                  <Button type="submit" disabled={!pullModel.trim()} className="pointer-coarse:h-10">
                    <DownloadIcon /> {t("providers.ollamaPull")}
                  </Button>
                )}
              </div>
              {pulling && <Progress model={pullModel.trim()} progress={pullProgress} cancelled={pullCancelled} />}
              {!pulling && pullCancelled && <Progress model={pullModel.trim()} progress={pullProgress} cancelled />}
              {!pulling && pullProgress?.status === "success" && (
                <p role="status" aria-live="polite" className="text-success text-xs">
                  {t("providers.ollamaPullComplete", { model: pullModel.trim() })}
                </p>
              )}
              {pullError && (
                <p role="alert" className="text-error text-xs">
                  {pullError}
                </p>
              )}
            </form>
          )}
        </div>
      )}

      <DeleteModelDialog
        model={deleteTarget}
        busy={deleting}
        error={deleteError}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
        onConfirm={deleteModel}
      />
    </div>
  );
}
