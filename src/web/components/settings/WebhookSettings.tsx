import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import type { ChannelSummary } from "@shared/channels";
import type { EndpointDetail } from "@shared/outgoing-webhooks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { api } from "@/lib/api";
import { t } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { settingsHref } from "@/lib/settings-link";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { useWebhooks } from "@/state/webhooks";
import { SettingsPage } from "./SettingsUI";
import { WebhookDeliveryLog } from "@/components/webhooks/WebhookDeliveryLog";
import { WebhookEditor } from "@/components/webhooks/WebhookEditor";

/** Settings → Webhooks. List/detail on desktop, stacked cards and a full-width editor on phones. */
export function WebhookSettings() {
  const state = useWebhooks();
  const userId = useData((data) => data.me?.id ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EndpointDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [rooms, setRooms] = useState<Array<{ id: string; name: string }>>([]);
  const [channelsDisabled, setChannelsDisabled] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const [detailError, setDetailError] = useState(false);
  const query = new URLSearchParams(useSearch());
  const initialEndpoint = query.get("endpoint");
  const [, navigate] = useLocation();
  const generation = useRef(0);

  useEffect(() => {
    if (!state.endpoints.length) {
      setSelectedId(null);
      setDetail(null);
      return;
    }
    setSelectedId((current) => {
      if (creating) return current;
      if (current && state.endpoints.some((endpoint) => endpoint.id === current)) return current;
      if (initialEndpoint && state.endpoints.some((endpoint) => endpoint.id === initialEndpoint)) return initialEndpoint;
      return state.endpoints[0]!.id;
    });
  }, [state.endpoints, creating, initialEndpoint]);

  useEffect(() => {
    if (!userId) {
      setRooms([]);
      return;
    }
    // A secret shown for the previous account must never survive into this one.
    setSecret(null);
    setDetail(null);
    setSelectedId(null);
    setCreating(false);
    const current = ++generation.current;
    api<{ items: ChannelSummary[] }>("/channels?scope=joined&limit=50")
      .then((page) => {
        if (generation.current !== current) return;
        setRooms(
          page.items
            .filter((channel) => channel.ownerId === userId && channel.kind === "room" && channel.archivedAt === null)
            .map((channel) => ({ id: channel.id, name: channel.name })),
        );
        setChannelsDisabled(false);
      })
      .catch(() => {
        if (generation.current !== current) return;
        setRooms([]);
        setChannelsDisabled(true);
      });
    return () => {
      generation.current++;
    };
  }, [userId]);

  const loadDetail = useCallback(async (id: string): Promise<EndpointDetail | null> => {
    try {
      const result = await api<{ endpoint: EndpointDetail }>(`/webhooks/${encodeURIComponent(id)}`);
      setDetail(result.endpoint);
      setDetailError(false);
      return result.endpoint;
    } catch {
      setDetailError(true);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!selectedId || creating) return;
    setDetail(null);
    void loadDetail(selectedId);
  }, [selectedId, creating, loadDetail]);

  const onCreate = async (input: Parameters<typeof state.create>[0]) => {
    const result = await state.create(input);
    setSecret(result.signingSecret);
    setCreating(false);
    setSelectedId(result.endpoint.id);
    setDetail(result.endpoint);
    setResetToken((value) => value + 1);
    return result;
  };

  const onUpdate = async (id: string, input: Parameters<typeof state.update>[1]) => {
    const updated = await state.update(id, input);
    setDetail(updated);
    setResetToken((value) => value + 1);
    return updated;
  };

  const onDelete = async (id: string, revision: number) => {
    await state.remove(id, revision);
    setDetail(null);
    setSelectedId(null);
    setCreating(false);
  };

  const onRotate = async (id: string, revision: number) => {
    const result = await state.rotate(id, revision);
    setDetail(result.endpoint);
    setSecret(result.signingSecret);
    setResetToken((value) => value + 1);
    return result;
  };

  const onReload = async () => {
    if (!selectedId) return null;
    const latest = await loadDetail(selectedId);
    setResetToken((value) => value + 1);
    return latest;
  };

  const selected = state.endpoints.find((endpoint) => endpoint.id === selectedId) ?? null;

  return (
    <SettingsPage title={t("webhooks.title")} description={t("webhooks.description")}>
      {state.error && <p role="alert" className="text-destructive text-sm">{t("webhooks.loadFailed")}</p>}

      <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <section className="flex flex-col gap-3" aria-label={t("webhooks.title")}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">{t("webhooks.title")}</h2>
            <Button size="sm" className="pointer-coarse:h-11" onClick={() => { navigate(settingsHref("webhooks")); setCreating(true); setDetail(null); setSelectedId(null); }}>
              {t("webhooks.new")}
            </Button>
          </div>
          {!state.loading && !state.endpoints.length && (
            <div className="bg-card rounded-xl px-4 py-6 shadow-[var(--depth-highlight),var(--shadow-raised)]">
              <p className="text-sm font-medium">{t("webhooks.empty")}</p>
              <p className="text-muted-foreground mt-1 text-xs">{t("webhooks.emptyBody")}</p>
            </div>
          )}
          <ul className="flex flex-col gap-2">
            {state.endpoints.map((endpoint) => (
              <li key={endpoint.id}>
                <button
                  type="button"
                  onClick={() => { navigate(settingsHref("webhookDeliveries", { endpoint: endpoint.id })); setCreating(false); setSelectedId(endpoint.id); }}
                  aria-current={!creating && endpoint.id === selectedId ? "true" : undefined}
                  className={cn(
                    "bg-card flex w-full flex-col gap-1 rounded-xl px-3 py-3 text-start shadow-[var(--depth-highlight),var(--shadow-raised)] outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    !creating && endpoint.id === selectedId && "depth-row-active",
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{endpoint.name}</span>
                    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs", endpoint.enabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>
                      {endpoint.enabled ? t("webhooks.enabledLabel") : t("webhooks.disabledLabel")}
                    </span>
                  </span>
                  <span className="text-muted-foreground truncate font-mono text-xs">{endpoint.hostname}</span>
                  <span className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
                    <span>{t("webhooks.pending", { count: endpoint.pendingCount })}</span>
                    <span>{t("webhooks.dead", { count: endpoint.deadCount })}</span>
                    <span>{t("webhooks.dropped", { count: endpoint.droppedCount })}</span>
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {t("webhooks.lastDelivery")}: {endpoint.lastDelivery ? `${endpoint.lastDelivery.status === "succeeded" ? t("webhooks.statusSucceeded") : t("webhooks.statusDead")} · ${formatDateTime(endpoint.lastDelivery.attemptedAt)}` : t("webhooks.never")}
                  </span>
                  {endpoint.autoDisabledAt && <span className="text-destructive text-xs">{t("webhooks.autoDisabled")}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="min-w-0">
          {detailError && (
            <p role="alert" className="text-destructive mb-3 text-sm">
              {t("webhooks.loadFailed")} <Button variant="link" size="sm" onClick={() => selectedId && void loadDetail(selectedId)}>{t("webhooks.reload")}</Button>
            </p>
          )}
          {(creating || detail || selected) && (
            <div className="flex flex-col gap-8">
              <WebhookEditor
                key={`${userId}:${detail?.id ?? "new"}:${resetToken}`}
                endpoint={creating ? null : detail}
                rooms={rooms}
                channelsDisabled={channelsDisabled}
                resetToken={resetToken}
                onCreate={onCreate}
                onUpdate={onUpdate}
                onDelete={onDelete}
                onRotate={onRotate}
                onPrepareTest={state.prepareTest}
                onSendTest={state.sendTest}
                onReload={onReload}
                onChanged={state.refresh}
              />
              {!creating && detail && (
                <WebhookDeliveryLog key={`${userId}:${detail.id}`} endpoint={detail} onChanged={state.refresh} />
              )}
            </div>
          )}
          {!creating && !detail && !selected && !state.loading && state.endpoints.length > 0 && (
            <p className="text-muted-foreground text-sm">{t("webhooks.emptyBody")}</p>
          )}
        </section>
      </div>

      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
    </SettingsPage>
  );
}

function SecretDialog({ secret, onClose }: { secret: string | null; onClose: () => void }) {
  const { copyToClipboard } = useCopyToClipboard();
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [secret]);
  if (!secret) return null;
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      copyToClipboard(secret);
      setCopied(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-describedby="webhook-secret-note">
        <DialogHeader>
          <DialogTitle>{t("webhooks.secretTitle")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label htmlFor="webhook-secret" className="text-sm font-medium">{t("webhooks.secretLabel")}</label>
          <input
            id="webhook-secret"
            data-no-drawer-swipe
            readOnly
            value={secret}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            className="bg-muted/60 depth-field w-full min-w-0 overflow-x-auto rounded-lg border border-transparent px-3 py-2 font-mono text-xs whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onFocus={(event) => event.currentTarget.select()}
          />
          <p id="webhook-secret-note" className="text-destructive text-sm font-medium">{t("webhooks.secretOnce")}</p>
          <p className="text-muted-foreground text-xs">{t("webhooks.secretRecovery")}</p>
          <div aria-live="polite" aria-atomic="true" className="text-muted-foreground min-h-5 text-xs">
            {copied ? t("webhooks.copied") : ""}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => void copy()}>{t("webhooks.copy")}</Button>
          <Button onClick={onClose}>{t("webhooks.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
