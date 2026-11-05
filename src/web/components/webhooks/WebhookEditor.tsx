import { useEffect, useId, useMemo, useState } from "react";
import type { EndpointCreateInput, EndpointDetail, EndpointPatchInput, ProductionEventType, RequestPreview } from "@shared/outgoing-webhooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { t, type PlainMessageKey } from "@/i18n";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { WebhookTestPreview } from "./WebhookTestPreview";

const EVENT_GROUPS: Array<{ label: PlainMessageKey; events: Array<{ id: ProductionEventType; label: PlainMessageKey }> }> = [
  {
    label: "webhooks.groupChat",
    events: [
      { id: "chat.turn.completed", label: "webhooks.eventChatCompleted" },
      { id: "chat.turn.failed", label: "webhooks.eventChatFailed" },
    ],
  },
  {
    label: "webhooks.groupSchedules",
    events: [
      { id: "schedule.run.completed", label: "webhooks.eventScheduleCompleted" },
      { id: "schedule.run.failed", label: "webhooks.eventScheduleFailed" },
    ],
  },
  {
    label: "webhooks.groupChannels",
    events: [
      { id: "channel.message.created", label: "webhooks.eventChannelCreated" },
      { id: "channel.message.edited", label: "webhooks.eventChannelEdited" },
      { id: "channel.message.deleted", label: "webhooks.eventChannelDeleted" },
      { id: "channel.mention", label: "webhooks.eventChannelMention" },
    ],
  },
  {
    label: "webhooks.groupArchives",
    events: [
      { id: "archive.export.finished", label: "webhooks.eventExportFinished" },
      { id: "archive.import.finished", label: "webhooks.eventImportFinished" },
    ],
  },
];

interface DraftHeader {
  name: string;
  value: string;
}

const blankHeader = (): DraftHeader => ({ name: "", value: "" });

export function WebhookEditor({
  endpoint,
  rooms,
  channelsDisabled,
  resetToken,
  onCreate,
  onUpdate,
  onDelete,
  onRotate,
  onPrepareTest,
  onSendTest,
  onReload,
  onChanged,
}: {
  endpoint: EndpointDetail | null;
  rooms: Array<{ id: string; name: string }>;
  channelsDisabled: boolean;
  resetToken: number;
  onCreate: (input: EndpointCreateInput) => Promise<{ endpoint: EndpointDetail; signingSecret: string }>;
  onUpdate: (id: string, input: EndpointPatchInput) => Promise<EndpointDetail>;
  onDelete: (id: string, revision: number) => Promise<void>;
  onRotate: (id: string, revision: number) => Promise<{ endpoint: EndpointDetail; signingSecret: string }>;
  onPrepareTest: (id: string, revision: number) => Promise<{ preparationId: string; expiresAt: number; preview: RequestPreview }>;
  onSendTest: (id: string, revision: number, preparationId: string) => Promise<{ deliveryId: string }>;
  onReload: () => Promise<EndpointDetail | null>;
  onChanged: () => void;
}) {
  const baseId = useId();
  const [name, setName] = useState(endpoint?.name ?? "");
  const [url, setUrl] = useState(endpoint?.url ?? "");
  const [includeText, setIncludeText] = useState(endpoint?.includeMessageText ?? false);
  const [enabled, setEnabled] = useState(endpoint?.enabled ?? false);
  const [subscriptions, setSubscriptions] = useState<Set<ProductionEventType>>(new Set(endpoint?.subscriptions ?? []));
  const [channelIds, setChannelIds] = useState<Set<string>>(new Set(endpoint?.channelIds ?? []));
  const [keptHeaders, setKeptHeaders] = useState(endpoint?.headerNames ?? []);
  const [headerValues, setHeaderValues] = useState<Record<string, string>>({});
  const [removedHeaders, setRemovedHeaders] = useState<Set<string>>(new Set());
  const [newHeaders, setNewHeaders] = useState<DraftHeader[]>([blankHeader()]);
  const [replacementHeaders, setReplacementHeaders] = useState<DraftHeader[]>([blankHeader()]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"delete" | "rotate" | null>(null);
  const [preparation, setPreparation] = useState<{ preparationId: string; expiresAt: number; preview: RequestPreview } | null>(null);
  const [testSent, setTestSent] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const reset = () => {
    setName(endpoint?.name ?? "");
    setUrl(endpoint?.url ?? "");
    setIncludeText(endpoint?.includeMessageText ?? false);
    setEnabled(endpoint?.enabled ?? false);
    setSubscriptions(new Set(endpoint?.subscriptions ?? []));
    setChannelIds(new Set(endpoint?.channelIds ?? []));
    setKeptHeaders(endpoint?.headerNames ?? []);
    setHeaderValues({});
    setRemovedHeaders(new Set());
    setNewHeaders([blankHeader()]);
    setReplacementHeaders([blankHeader()]);
    setConflict(false);
    setError(null);
    setNotice(null);
    setPreparation(null);
    setTestSent(false);
    setTestError(null);
    setConfirmAction(null);
  };

  useEffect(() => {
    reset();
    // A deliberate reload replaces the draft; ordinary list refreshes pass the same token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint?.id, resetToken]);

  const urlChanged = !!endpoint && url.trim() !== endpoint.url;
  const dirty = useMemo(() => {
    if (!endpoint) return true;
    return name !== endpoint.name || urlChanged || includeText !== endpoint.includeMessageText || enabled !== endpoint.enabled ||
      [...subscriptions].sort().join("|") !== [...endpoint.subscriptions].sort().join("|") ||
      [...channelIds].sort().join("|") !== [...endpoint.channelIds].sort().join("|") ||
      Object.values(headerValues).some((value) => value.length > 0) ||
      removedHeaders.size > 0 ||
      newHeaders.some((header) => header.name.trim() && header.value.length > 0);
  }, [endpoint, name, urlChanged, includeText, enabled, subscriptions, channelIds, headerValues, removedHeaders, newHeaders]);

  const headersForCreate = () => {
    const headers: Record<string, string> = {};
    for (const header of [...replacementHeaders, ...newHeaders]) {
      if (!header.name.trim()) continue;
      headers[header.name.trim()] = header.value;
    }
    return headers;
  };

  const buildPatch = (): EndpointPatchInput | null => {
    if (!endpoint) return null;
    const patch: EndpointPatchInput = { revision: endpoint.revision };
    let changed = false;
    if (name !== endpoint.name) { patch.name = name; changed = true; }
    if (urlChanged) {
      patch.url = url;
      patch.replaceHeaders = headersForCreate();
      changed = true;
    } else {
      const headerChanges: Record<string, string | null> = {};
      for (const [header, value] of Object.entries(headerValues)) if (value.length > 0) headerChanges[header] = value;
      for (const header of removedHeaders) headerChanges[header] = null;
      for (const header of newHeaders) if (header.name.trim() && header.value.length > 0) headerChanges[header.name.trim()] = header.value;
      if (Object.keys(headerChanges).length) { patch.headerChanges = headerChanges; changed = true; }
    }
    if ([...subscriptions].sort().join("|") !== [...endpoint.subscriptions].sort().join("|")) { patch.subscriptions = [...subscriptions].sort(); changed = true; }
    if ([...channelIds].sort().join("|") !== [...endpoint.channelIds].sort().join("|")) { patch.channelIds = [...channelIds].sort(); changed = true; }
    if (includeText !== endpoint.includeMessageText) { patch.includeMessageText = includeText; changed = true; }
    if (enabled !== endpoint.enabled) { patch.enabled = enabled; changed = true; }
    return changed ? patch : null;
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    setNotice(null);
    setConflict(false);
    try {
      if (!endpoint) {
        const result = await onCreate({
          name,
          url,
          headers: headersForCreate(),
          subscriptions: [...subscriptions],
          channelIds: [...channelIds],
          includeMessageText: includeText,
        });
        onChanged();
        setNotice(t("webhooks.created"));
        // The parent shows the one-time secret; the draft resets because a new endpoint replaces it.
        return result;
      }
      const patch = buildPatch();
      if (!patch) {
        setNotice(t("webhooks.saved"));
        return;
      }
      const updated = await onUpdate(endpoint.id, patch);
      onChanged();
      setNotice(t("webhooks.saved"));
      reset();
      // Keep the saved revision visible without discarding the editor is handled by the parent.
      void updated;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) setConflict(true);
      else setError(t("webhooks.saveFailed"));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!endpoint) return;
    setBusy("delete");
    try {
      await onDelete(endpoint.id, endpoint.revision);
      onChanged();
      setConfirmAction(null);
    } catch {
      setError(t("webhooks.deleteFailed"));
    } finally {
      setBusy(null);
    }
  };

  const rotate = async () => {
    if (!endpoint) return;
    setBusy("rotate");
    try {
      await onRotate(endpoint.id, endpoint.revision);
      onChanged();
      setConfirmAction(null);
    } catch {
      setError(t("webhooks.rotateFailed"));
    } finally {
      setBusy(null);
    }
  };

  const prepare = async () => {
    if (!endpoint) return;
    if (dirty) {
      setTestError(t("webhooks.testSaveFirst"));
      return;
    }
    setBusy("prepare");
    setTestError(null);
    try {
      setPreparation(await onPrepareTest(endpoint.id, endpoint.revision));
      setTestSent(false);
    } catch {
      setTestError(t("webhooks.testFailed"));
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    if (!endpoint || !preparation) return;
    setBusy("send-test");
    setTestError(null);
    try {
      await onSendTest(endpoint.id, endpoint.revision, preparation.preparationId);
      setTestSent(true);
      onChanged();
    } catch {
      setTestError(t("webhooks.testFailed"));
    } finally {
      setBusy(null);
    }
  };

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const fieldId = (suffix: string) => `${baseId}-${suffix}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{endpoint ? t("webhooks.title") : t("webhooks.new")}</h2>
        {endpoint && (
          <span className={cn("rounded-full px-2 py-0.5 text-xs", endpoint.enabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>
            {endpoint.enabled ? t("webhooks.enabledLabel") : t("webhooks.disabledLabel")}
          </span>
        )}
      </div>

      <div aria-live="polite" aria-atomic="true" className="min-h-5 text-sm">
        {notice && <p className="text-success">{notice}</p>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {endpoint?.autoDisabledAt && <p className="text-destructive">{t("webhooks.autoDisabled")}</p>}
      </div>

      <section className="flex flex-col gap-3" aria-labelledby={fieldId("destination")}>
        <h3 id={fieldId("destination")} className="text-sm font-medium">{t("webhooks.url")}</h3>
        <div className="flex flex-col gap-2">
          <label htmlFor={fieldId("name")} className="text-sm font-medium">{t("webhooks.name")}</label>
          <Input id={fieldId("name")} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder={t("webhooks.namePlaceholder")} autoComplete="off" />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor={fieldId("url")} className="text-sm font-medium">{t("webhooks.url")}</label>
          <Input
            id={fieldId("url")}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            inputMode="url"
            className="font-mono text-xs"
          />
          <p className="text-muted-foreground text-xs">{t("webhooks.urlHelp")}</p>
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby={fieldId("headers")}>
        <h3 id={fieldId("headers")} className="text-sm font-medium">{t("webhooks.headers")}</h3>
        <p className="text-muted-foreground text-xs">{t("webhooks.headersHelp")}</p>
        {urlChanged ? (
          <div className="flex flex-col gap-2">
            <p className="text-destructive text-xs">{t("webhooks.urlChangedHeaders")}</p>
            {replacementHeaders.map((header, index) => (
              <div key={`replace-${index}`} className="flex flex-wrap gap-2">
                <Input aria-label={`${t("webhooks.headerName")} ${index + 1}`} value={header.name} onChange={(event) => setReplacementHeaders((rows) => rows.map((row, i) => (i === index ? { ...row, name: event.target.value } : row)))} placeholder={t("webhooks.headerName")} className="min-w-0 flex-1 font-mono text-xs" autoComplete="off" />
                <Input aria-label={`${t("webhooks.headerValue")} ${index + 1}`} value={header.value} onChange={(event) => setReplacementHeaders((rows) => rows.map((row, i) => (i === index ? { ...row, value: event.target.value } : row)))} placeholder={t("webhooks.headerValue")} type="password" className="min-w-0 flex-1 font-mono text-xs" autoComplete="off" />
              </div>
            ))}
            <Button variant="outline" size="sm" className="self-start pointer-coarse:h-11" onClick={() => setReplacementHeaders((rows) => [...rows, blankHeader()])}>{t("webhooks.addHeader")}</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {keptHeaders.filter((header) => !removedHeaders.has(header)).map((header) => (
              <div key={header} className="flex flex-wrap items-center gap-2">
                <span className="min-w-24 font-mono text-xs">{header}</span>
                <Input aria-label={`${header} ${t("webhooks.headerValue")}`} value={headerValues[header] ?? ""} onChange={(event) => setHeaderValues((values) => ({ ...values, [header]: event.target.value }))} placeholder={t("webhooks.keepValue")} type="password" className="min-w-0 flex-1 font-mono text-xs" autoComplete="off" />
                <Button variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={() => setRemovedHeaders((removed) => toggle(removed, header))} aria-label={t("webhooks.removeHeader", { name: header })}>{t("webhooks.removeHeader", { name: header })}</Button>
              </div>
            ))}
            {newHeaders.map((header, index) => (
              <div key={`new-${index}`} className="flex flex-wrap gap-2">
                <Input aria-label={`${t("webhooks.headerName")} ${index + 1}`} value={header.name} onChange={(event) => setNewHeaders((rows) => rows.map((row, i) => (i === index ? { ...row, name: event.target.value } : row)))} placeholder={t("webhooks.headerName")} className="min-w-0 flex-1 font-mono text-xs" autoComplete="off" />
                <Input aria-label={`${t("webhooks.headerValue")} ${index + 1}`} value={header.value} onChange={(event) => setNewHeaders((rows) => rows.map((row, i) => (i === index ? { ...row, value: event.target.value } : row)))} placeholder={t("webhooks.headerValue")} type="password" className="min-w-0 flex-1 font-mono text-xs" autoComplete="off" />
              </div>
            ))}
            <Button variant="outline" size="sm" className="self-start pointer-coarse:h-11" onClick={() => setNewHeaders((rows) => [...rows, blankHeader()])}>{t("webhooks.addHeader")}</Button>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">{t("webhooks.subscriptions")}</h3>
        <p className="text-muted-foreground text-xs">{t("webhooks.subscriptionsHelp")}</p>
        {EVENT_GROUPS.map((group) => (
          <fieldset key={group.label} className="flex flex-col gap-1">
            <legend className="text-xs font-medium">{t(group.label)}</legend>
            {group.events.map((event) => (
              <label key={event.id} className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--primary)]"
                  checked={subscriptions.has(event.id)}
                  onChange={() => setSubscriptions((set) => toggle(set, event.id))}
                />
                {t(event.label)}
              </label>
            ))}
          </fieldset>
        ))}
        <p className="text-muted-foreground text-xs">{t("webhooks.externalTargetNote")}</p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t("webhooks.channelScope")}</h3>
        <p className="text-muted-foreground text-xs">{t("webhooks.channelScopeHelp")}</p>
        <p className="text-muted-foreground text-xs">{t("webhooks.channelDmNote")}</p>
        {channelsDisabled ? (
          <p className="text-muted-foreground text-xs">{t("webhooks.channelsFeature")}</p>
        ) : !rooms.length ? (
          <p className="text-muted-foreground text-xs">{t("webhooks.noRooms")}</p>
        ) : (
          <div className="grid gap-1 sm:grid-cols-2">
            {rooms.map((room) => (
              <label key={room.id} className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
                <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={channelIds.has(room.id)} onChange={() => setChannelIds((set) => toggle(set, room.id))} />
                {room.name}
              </label>
            ))}
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Switch aria-label={t("webhooks.textOptIn")} checked={includeText} onCheckedChange={setIncludeText} />
          <div>
            <p className="text-sm font-medium">{t("webhooks.textOptIn")}</p>
            <p className="text-muted-foreground text-xs">{t("webhooks.textOptInHelp")}</p>
          </div>
        </div>
        {endpoint && (
          <div className="flex items-center gap-3">
            <Switch aria-label={t("webhooks.enabled")} checked={enabled} onCheckedChange={setEnabled} />
            <div>
              <p className="text-sm font-medium">{t("webhooks.enabled")}</p>
              <p className="text-muted-foreground text-xs">{t("webhooks.enabledHelp")}</p>
            </div>
          </div>
        )}
      </div>

      {conflict && (
        <div className="bg-destructive/10 flex flex-col gap-2 rounded-xl px-3 py-3 text-sm">
          <p role="alert">{t("webhooks.conflict")}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="pointer-coarse:h-11" onClick={async () => { await onReload(); reset(); }}>{t("webhooks.reload")}</Button>
            <Button variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={() => setConflict(false)}>{t("webhooks.keepDraft")}</Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save()} disabled={busy !== null || (!endpoint && (!name.trim() || !url.trim()))} className="pointer-coarse:h-11">
          {busy === "save" ? t("webhooks.saving") : endpoint ? t("webhooks.save") : t("webhooks.create")}
        </Button>
        {endpoint && (
          <>
            <Button variant="outline" className="pointer-coarse:h-11" onClick={() => void prepare()} disabled={busy !== null || dirty}>
              {busy === "prepare" ? t("webhooks.preparing") : t("webhooks.prepare")}
            </Button>
            <Button variant="outline" className="pointer-coarse:h-11" onClick={() => setConfirmAction("rotate")} disabled={busy !== null}>{t("webhooks.rotate")}</Button>
            <Button variant="destructive" className="pointer-coarse:h-11" onClick={() => setConfirmAction("delete")} disabled={busy !== null}>{t("webhooks.delete")}</Button>
          </>
        )}
      </div>

      {endpoint && dirty && <p className="text-muted-foreground text-xs">{t("webhooks.testSaveFirst")}</p>}

      {confirmAction && endpoint && (
        <div className="bg-muted/50 flex flex-col gap-2 rounded-xl px-3 py-3">
          <p className="text-sm font-medium">{confirmAction === "delete" ? t("webhooks.deleteTitle", { name: endpoint.name }) : t("webhooks.rotateTitle")}</p>
          <p className="text-muted-foreground text-xs">{confirmAction === "delete" ? t("webhooks.deleteBody") : t("webhooks.rotateBody")}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant={confirmAction === "delete" ? "destructive" : "default"} className="pointer-coarse:h-11" onClick={() => void (confirmAction === "delete" ? remove() : rotate())} disabled={busy !== null}>
              {confirmAction === "delete" ? t("webhooks.delete") : t("webhooks.rotate")}
            </Button>
            <Button variant="ghost" className="pointer-coarse:h-11" onClick={() => setConfirmAction(null)}>{t("webhooks.cancel")}</Button>
          </div>
        </div>
      )}

      {preparation && (
        <WebhookTestPreview preview={preparation.preview} expiresAt={preparation.expiresAt} sending={busy === "send-test"} sent={testSent} error={testError} onSend={() => void sendTest()} />
      )}

      {!endpoint && (
        <p className="text-muted-foreground text-xs">{t("webhooks.testHelp")}</p>
      )}
    </div>
  );
}
