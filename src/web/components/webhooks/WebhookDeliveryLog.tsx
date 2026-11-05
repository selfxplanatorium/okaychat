import { useCallback, useEffect, useRef, useState } from "react";
import type { DeliveryDetail, DeliveryPage, DeliveryStatus, DeliverySummary, EndpointDetail, EventType } from "@shared/outgoing-webhooks";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { t, type PlainMessageKey } from "@/i18n";
import { formatDateTime, formatDuration, formatNumber } from "@/i18n/format";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<DeliveryStatus, PlainMessageKey> = {
  queued: "webhooks.statusQueued",
  sending: "webhooks.statusSending",
  backoff: "webhooks.statusBackoff",
  succeeded: "webhooks.statusSucceeded",
  dead: "webhooks.statusDead",
  cancelled: "webhooks.statusCancelled",
};

const EVENT_LABEL: Record<EventType, PlainMessageKey> = {
  "chat.turn.completed": "webhooks.eventChatCompleted",
  "chat.turn.failed": "webhooks.eventChatFailed",
  "schedule.run.completed": "webhooks.eventScheduleCompleted",
  "schedule.run.failed": "webhooks.eventScheduleFailed",
  "channel.message.created": "webhooks.eventChannelCreated",
  "channel.message.edited": "webhooks.eventChannelEdited",
  "channel.message.deleted": "webhooks.eventChannelDeleted",
  "channel.mention": "webhooks.eventChannelMention",
  "archive.export.finished": "webhooks.eventExportFinished",
  "archive.import.finished": "webhooks.eventImportFinished",
  "webhook.test": "webhooks.test",
};

const ACTIVE: ReadonlySet<DeliveryStatus> = new Set(["queued", "sending", "backoff"]);

/**
 * Delivery log and detail. Polling exists only while this view is mounted: 2 s with active rows, 15 s
 * otherwise, paused when hidden, one request in flight, and aborted on unmount or endpoint change.
 */
export function WebhookDeliveryLog({ endpoint, onChanged }: { endpoint: EndpointDetail; onChanged: () => void }) {
  const [items, setItems] = useState<DeliverySummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [detail, setDetail] = useState<DeliveryDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async (append: boolean, cursorValue: string | null) => {
    if (inFlight.current) return;
    inFlight.current = true;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const current = generation.current;
    try {
      const query = new URLSearchParams({ limit: "30" });
      if (append && cursorValue) query.set("cursor", cursorValue);
      const page = await api<DeliveryPage>(`/webhooks/${encodeURIComponent(endpoint.id)}/deliveries?${query}`, { signal: abort.signal });
      if (generation.current !== current) return;
      setItems((previous) => (append ? [...previous, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setError(false);
    } catch {
      if (generation.current === current) setError(true);
    } finally {
      if (generation.current === current) setLoading(false);
      inFlight.current = false;
    }
  }, [endpoint.id]);

  // Reset when the selected endpoint changes; an answer for the old endpoint never paints this one.
  useEffect(() => {
    generation.current++;
    setItems([]);
    setCursor(null);
    setDetail(null);
    setLoading(true);
    setNotice(null);
    setReloadKey(0);
    return () => {
      generation.current++;
      controller.current?.abort();
      inFlight.current = false;
    };
  }, [endpoint.id]);

  useEffect(() => {
    setLoading(true);
    void load(false, null);
    // `reloadKey` restarts the timer when a test or retry changes the queue.
  }, [load, reloadKey]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const active = items.some((item) => ACTIVE.has(item.status));
    const schedule = () => {
      timer = setTimeout(() => {
        if (document.visibilityState === "visible") void load(false, null);
        schedule();
      }, active ? 2_000 : 15_000);
    };
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [items, load]);

  const openDetail = async (deliveryId: string) => {
    try {
      const result = await api<{ delivery: DeliveryDetail }>(`/webhooks/${encodeURIComponent(endpoint.id)}/deliveries/${encodeURIComponent(deliveryId)}`);
      setDetail(result.delivery);
    } catch {
      setNotice(t("webhooks.loadFailed"));
    }
  };

  const retry = async (delivery: DeliverySummary) => {
    setBusy(delivery.id);
    setNotice(null);
    try {
      await api(`/webhooks/${encodeURIComponent(endpoint.id)}/deliveries/${encodeURIComponent(delivery.id)}/retry`, {
        method: "POST",
        json: { revision: endpoint.revision, version: delivery.version },
      });
      onChanged();
      setReloadKey((value) => value + 1);
    } catch {
      setNotice(t("webhooks.retryFailed"));
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setBusy("clear");
    setNotice(null);
    try {
      const result = await api<{ deleted: number }>(`/webhooks/${encodeURIComponent(endpoint.id)}/deliveries`, { method: "DELETE" });
      setNotice(t("webhooks.cleared", { count: result.deleted }));
      setDetail(null);
      setReloadKey((value) => value + 1);
      onChanged();
    } catch {
      setNotice(t("webhooks.loadFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="webhook-deliveries-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="webhook-deliveries-title" className="text-sm font-medium">{t("webhooks.deliveries")}</h2>
        <Button variant="outline" size="sm" className="pointer-coarse:h-11" onClick={() => void clear()} disabled={busy !== null}>
          {t("webhooks.clearLogs")}
        </Button>
      </div>
      <div aria-live="polite" aria-atomic="true" className="min-h-5 text-sm">
        {notice && <p className="text-muted-foreground">{notice}</p>}
        {error && <p role="alert" className="text-destructive">{t("webhooks.loadFailed")}</p>}
      </div>
      {!loading && !items.length && <p className="text-muted-foreground text-sm">{t("webhooks.noDeliveries")}</p>}
      <ul className="bg-card divide-border flex flex-col divide-y overflow-hidden rounded-xl shadow-[var(--depth-highlight),var(--shadow-raised)]">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-2 px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span>{t(EVENT_LABEL[item.eventType])}</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-xs", item.status === "succeeded" ? "bg-success/15 text-success" : item.status === "dead" ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground")}>
                    {t(STATUS_LABEL[item.status])}
                  </span>
                  {item.isTest && <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">{t("webhooks.test")}</span>}
                </div>
                <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  <span>{formatDateTime(item.createdAt)}</span>
                  <span>{t("webhooks.attempts")}: {formatNumber(item.attempts)}</span>
                  {item.lastHttpStatus !== null && <span>{t("webhooks.http")}: {formatNumber(item.lastHttpStatus)}</span>}
                  {item.lastErrorCode && <code className="font-mono">{item.lastErrorCode}</code>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" className="pointer-coarse:h-11" onClick={() => void openDetail(item.id)}>
                  {t("webhooks.detail")}
                </Button>
                {item.canRetry && (
                  <Button variant="outline" size="sm" className="pointer-coarse:h-11" disabled={busy !== null} onClick={() => void retry(item)}>
                    {busy === item.id ? t("webhooks.retrying") : t("webhooks.retry")}
                  </Button>
                )}
              </div>
            </div>
            {item.canRetry && <p className="text-muted-foreground text-xs">{t("webhooks.retryWarning")}</p>}
          </li>
        ))}
      </ul>
      {cursor && (
        <Button variant="outline" size="sm" className="self-start pointer-coarse:h-11" onClick={() => void load(true, cursor)} disabled={loading}>
          {t("webhooks.loadMore")}
        </Button>
      )}
      {detail && (
        <div className="bg-muted/40 flex flex-col gap-3 rounded-xl px-3 py-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-medium">{t("webhooks.detail")}</h3>
            <Button variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={() => setDetail(null)}>{t("webhooks.close")}</Button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{t("webhooks.event")}</dt><dd>{t(EVENT_LABEL[detail.eventType])}</dd>
            <dt className="text-muted-foreground">{t("webhooks.status")}</dt><dd>{t(STATUS_LABEL[detail.status])}</dd>
            <dt className="text-muted-foreground">{t("webhooks.sequence")}</dt><dd className="font-mono">{detail.sequence}</dd>
            <dt className="text-muted-foreground">{t("webhooks.version")}</dt><dd>{formatNumber(detail.version)}</dd>
            <dt className="text-muted-foreground">{t("webhooks.occurred")}</dt><dd>{formatDateTime(detail.occurredAt)}</dd>
          </dl>
          <div>
            <h4 className="text-xs font-medium">{t("webhooks.attemptLog")}</h4>
            {detail.attemptLog.length ? (
              <ul className="mt-1 flex flex-col gap-1">
                {detail.attemptLog.map((attempt) => (
                  <li key={attempt.number} className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
                    <span>#{attempt.number}</span>
                    <span>{attempt.outcome === "succeeded" ? t("webhooks.attemptSucceeded") : attempt.outcome === "failed" ? t("webhooks.attemptFailed") : t("webhooks.attemptUncertain")}</span>
                    {attempt.httpStatus !== null && <span>{t("webhooks.http")}: {attempt.httpStatus}</span>}
                    {attempt.errorCode && <code className="font-mono">{attempt.errorCode}</code>}
                    <span>{formatDuration(attempt.durationMs / 1000)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-xs">{t("webhooks.noBody")}</p>
            )}
          </div>
          <div>
            <h4 className="text-xs font-medium">{t("webhooks.body")}</h4>
            {detail.body ? (
              <pre data-no-drawer-swipe className="bg-background mt-1 max-h-72 overflow-auto rounded-lg p-2 font-mono text-xs whitespace-pre-wrap break-all">{detail.body}</pre>
            ) : (
              <p className="text-muted-foreground text-xs">
                {detail.bodyUnavailableReason === "expired" ? t("webhooks.bodyExpired") : detail.bodyUnavailableReason === "revoked" ? t("webhooks.bodyRevoked") : detail.bodyUnavailableReason === "text_disabled" ? t("webhooks.bodyTextDisabled") : t("webhooks.noBody")}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
