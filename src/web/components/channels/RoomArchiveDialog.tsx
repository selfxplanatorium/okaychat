import { DownloadIcon, FileArchiveIcon, Loader2Icon, UploadIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChannelMessage, ChannelSummary } from "@shared/channels";
import {
  ROOM_ARCHIVE_LIMITS,
  type RoomArchiveErrorCode,
  type RoomArchiveJob,
  type RoomArchivePhase,
  type RoomArchiveSelection,
  type RoomArchiveSummary,
  type RoomArchiveWarningCode,
} from "@shared/room-archive";
import { t, type MessageKey, type PlainMessageKey } from "@/i18n";
import { formatBytes, formatDateTime, formatNumber } from "@/i18n/format";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { channelsApi } from "@/state/channels-api";
import { useRoomArchives } from "@/state/room-archives";
import { settingsHref } from "@/lib/settings-link";
import { cn } from "@/lib/utils";
import { RoomArchiveRoster } from "./RoomArchiveRoster";

/**
 * Export and import for one room. The dialog only holds review state; the durable job lives on the
 * server, so closing it, reloading, or losing the network never repeats an import. Escape closes the
 * dialog without cancelling: Cancel is an explicit button.
 */

const PHASE_KEYS: Record<RoomArchivePhase, PlainMessageKey> = {
  upload: "roomArchives.phaseUpload",
  snapshot: "roomArchives.phaseSnapshot",
  zip: "roomArchives.phaseZip",
  validate: "roomArchives.phaseValidate",
  inspect: "roomArchives.phaseInspect",
  promote: "roomArchives.phasePromote",
  commit: "roomArchives.phaseCommit",
  download: "roomArchives.phaseDownload",
  cleanup: "roomArchives.phaseCleanup",
  complete: "roomArchives.phaseComplete",
};

const WARNING_KEYS: Record<RoomArchiveWarningCode, MessageKey> = {
  plaintextSensitive: "roomArchives.plaintextWarning",
  membersNotJoined: "roomArchives.membersNotice",
  rolesInactive: "roomArchives.rolesInactive",
  privateDestination: "roomArchives.privateNotice",
  aiSettingsOmitted: "roomArchives.aiSettingsOmitted",
  aiHistoryOnly: "roomArchives.aiHistoryOnly",
  quoteUnavailable: "roomArchives.quoteUnavailable",
  unknownAuthors: "roomArchives.unknownAuthorsWarning",
  emailsIncluded: "roomArchives.emailsIncluded",
  emailsDiscarded: "roomArchives.emailsDiscarded",
  historicalRolesFlattened: "roomArchives.historicalRolesFlattened",
  reactionProvenanceFlattened: "roomArchives.reactionProvenanceFlattened",
  linksNotRewritten: "roomArchives.linksNotRewritten",
  sourceMetadataHistorical: "roomArchives.sourceMetadataHistorical",
};

const ERROR_KEYS: Record<RoomArchiveErrorCode, PlainMessageKey> = {
  invalid_archive: "roomArchives.errInvalidArchive",
  wrong_format: "roomArchives.errWrongFormat",
  unsupported_version: "roomArchives.errUnsupportedVersion",
  limit_exceeded: "roomArchives.errLimitExceeded",
  asset_unavailable: "roomArchives.errAssetUnavailable",
  attachment_type: "roomArchives.errAttachmentType",
  attachment_invalid: "roomArchives.errAttachmentInvalid",
  room_busy: "roomArchives.errRoomBusy",
  busy: "roomArchives.errBusy",
  queue_full: "roomArchives.errQueueFull",
  rate_limited: "roomArchives.errRateLimited",
  storage_quota: "roomArchives.errStorageQuota",
  staging_full: "roomArchives.errStagingFull",
  capacity: "roomArchives.errCapacity",
  review_changed: "roomArchives.errReviewChanged",
  expired: "roomArchives.errExpired",
  interrupted: "roomArchives.errInterrupted",
  timeout: "roomArchives.errTimeout",
  import_failed: "roomArchives.errImportFailed",
  export_failed: "roomArchives.errExportFailed",
  not_ready: "roomArchives.errNotReady",
  imported_read_only: "roomArchives.errImportedReadOnly",
  imported_source: "roomArchives.errImportedSource",
};

const activeState = (job: RoomArchiveJob | null) =>
  job?.state === "uploading" || job?.state === "queued" || job?.state === "preparing" || job?.state === "committing";

const progressText = (job: RoomArchiveJob): string => {
  if (job.progress.unit === "bytes") {
    return job.progress.total === null
      ? t("roomArchives.progressUnknown", { done: formatBytes(job.progress.done) })
      : t("roomArchives.progressBytes", { done: formatBytes(job.progress.done), total: formatBytes(job.progress.total) });
  }
  return job.progress.total === null
    ? t("roomArchives.progressUnknown", { done: formatNumber(job.progress.done) })
    : t("roomArchives.progressBytes", { done: formatNumber(job.progress.done), total: formatNumber(job.progress.total) });
};

function WarningList({ warnings }: { warnings: RoomArchiveSummary["warnings"] }) {
  if (!warnings.length) return null;
  return (
    <ul className="text-muted-foreground ms-4 list-disc text-xs">
      {warnings.map((warning) => (
        <li key={warning.code}>
          {t(WARNING_KEYS[warning.code] ?? "roomArchives.failed", { count: formatNumber(warning.count) } as never)}
          {warning.count > 1 && <span className="ms-1">({formatNumber(warning.count)})</span>}
        </li>
      ))}
    </ul>
  );
}

export function RoomArchiveDialog({
  open,
  mode,
  channel,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  mode: "export" | "import";
  channel?: ChannelSummary;
  onOpenChange: (open: boolean) => void;
  onImported: (channelId: string) => void;
}) {
  const job = useRoomArchives((state) => state.job);
  const busy = useRoomArchives((state) => state.busy);
  const error = useRoomArchives((state) => state.error);
  const startExport = useRoomArchives((state) => state.startExport);
  const startImport = useRoomArchives((state) => state.startImport);
  const poll = useRoomArchives((state) => state.poll);
  const resume = useRoomArchives((state) => state.resume);
  const inspect = useRoomArchives((state) => state.inspect);
  const confirm = useRoomArchives((state) => state.confirm);
  const cancel = useRoomArchives((state) => state.cancel);
  const reset = useRoomArchives((state) => state.reset);

  const [step, setStep] = useState<"choose" | "job">("choose");
  const [roots, setRoots] = useState<ChannelMessage[]>([]);
  const [loadingRoots, setLoadingRoots] = useState(false);
  const [selectionMode, setSelectionMode] = useState<"all" | "roots">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeReplies, setIncludeReplies] = useState(true);
  const [includeEmails, setIncludeEmails] = useState(false);
  const [summary, setSummary] = useState<RoomArchiveSummary | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const initializedJob = useRef<string | null>(null);
  const lastJob = useRef<string | null>(null);

  // A reload or a reopened dialog recovers the durable current job instead of starting another.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void resume().then((current) => {
      if (!live) return;
      setStep(current ? "job" : "choose");
    });
    return () => { live = false; };
  }, [open, resume]);

  useEffect(() => {
    if (!open || mode !== "export" || step !== "choose" || !channel) return;
    setLoadingRoots(true);
    channelsApi.messages(channel.id, { limit: 100 })
      .then((page) => setRoots(page.items.filter((message) => !message.threadRootId && !message.deletedAt)))
      .catch(() => setRoots([]))
      .finally(() => setLoadingRoots(false));
  }, [channel?.id, mode, open, step]);

  // Visible jobs poll once a second; a hidden tab backs off to thirty seconds.
  useEffect(() => {
    if (!open || !job || !activeState(job)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      const next = await poll(job.id);
      if (stopped || !next || !activeState(next)) return;
      timer = setTimeout(tick, document.visibilityState === "visible" ? 1_000 : 30_000);
    };
    timer = setTimeout(tick, 1_000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [job?.id, job?.state, open, poll]);

  // A ready import is always inspected before it can be confirmed; a name change refreshes the digest.
  useEffect(() => {
    if (!open || !job || job.kind !== "import" || job.state !== "ready") return;
    if (initializedJob.current !== job.id) {
      initializedJob.current = job.id;
      const initial = job.summary?.name ?? "";
      setName(initial);
      setSummary(job.summary);
      setReviewing(true);
      void inspect(job.id, initial || undefined).then((result) => {
        if (result) {
          setSummary(result.summary);
          setDigest(result.reviewDigest);
        }
      }).finally(() => setReviewing(false));
      return;
    }
    if (!name.trim()) return;
    setReviewing(true);
    const timer = setTimeout(() => {
      void inspect(job.id, name.trim()).then((result) => {
        if (!result) {
          setDigest(null);
          return;
        }
        setSummary(result.summary);
        setDigest(result.reviewDigest);
      }).finally(() => setReviewing(false));
    }, 400);
    return () => clearTimeout(timer);
  }, [inspect, job?.id, job?.kind, job?.state, name, open]);

  useEffect(() => {
    if (job?.id !== lastJob.current) {
      lastJob.current = job?.id ?? null;
      if (job?.state === "ready") setStep("job");
      if (job?.state === "done") setStep("job");
    }
  }, [job?.id, job?.state]);

  const currentSummary = summary ?? job?.summary ?? null;
  const canImport = !!job && job.kind === "import" && job.state === "ready" && !!digest && !reviewing && !busy && name.trim().length > 0;

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else if (next.size < ROOM_ARCHIVE_LIMITS.roots) next.add(id);
    return next;
  });

  const selection: RoomArchiveSelection = selectionMode === "all"
    ? { mode: "all" }
    : { mode: "roots", rootIds: [...selected], includeReplies };

  const prepare = async () => {
    if (!channel) return;
    if (selectionMode === "roots" && !selected.size) {
      useRoomArchives.getState().setError(t("roomArchives.selectedRoots", { count: 0 }));
      return;
    }
    setStep("job");
    const started = await startExport(channel.id, selection, includeEmails);
    if (!started) setStep("choose");
  };

  const upload = async (file: File) => {
    if (file.size > ROOM_ARCHIVE_LIMITS.uploadBytes) {
      useRoomArchives.getState().setError(t("roomArchives.fileTooLarge"));
      return;
    }
    setStep("job");
    const started = await startImport(file);
    if (!started) setStep("choose");
  };

  const openRoom = () => {
    if (!job?.result?.channelId) return;
    const channelId = job.result.channelId;
    reset();
    onImported(channelId);
    onOpenChange(false);
  };

  const heading = mode === "export" ? t("roomArchives.exportTitle") : t("roomArchives.importTitle");
  const quotaLink = job?.error?.code === "storage_quota" || job?.error?.code === "staging_full";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100vw-1rem)] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-base">{heading}</DialogTitle>
          <DialogDescription>{mode === "export" ? t("roomArchives.exportNotice") : t("roomArchives.importNotice")}</DialogDescription>
        </DialogHeader>

        <p className="border-border bg-muted/40 text-muted-foreground rounded-lg border px-2 py-1.5 text-xs">{t("roomArchives.plaintextWarning")}</p>
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto pe-1">
          {step === "choose" && mode === "export" && channel && (
            <div className="flex flex-col gap-3">
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-sm font-medium">{t("roomArchives.exportRoom")}</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="archive-selection" checked={selectionMode === "all"} onChange={() => setSelectionMode("all")} />
                  {t("roomArchives.wholeRoom")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="archive-selection" checked={selectionMode === "roots"} onChange={() => setSelectionMode("roots")} />
                  {t("roomArchives.chooseMessages")}
                </label>
              </fieldset>

              {selectionMode === "roots" && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" size="xs" variant="outline" onClick={() => setSelected(new Set(roots.map((message) => message.id)))}>
                      {t("roomArchives.selectAllPage")}
                    </Button>
                    <Button type="button" size="xs" variant="ghost" onClick={() => setSelected(new Set())}>
                      {t("roomArchives.clearSelection")}
                    </Button>
                    <span className="text-muted-foreground text-xs">{t("roomArchives.selectedRoots", { count: selected.size })}</span>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={includeReplies} onChange={(event) => setIncludeReplies(event.currentTarget.checked)} />
                    {t("roomArchives.includeReplies")}
                  </label>
                  <div className="border-border flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-lg border p-1">
                    {loadingRoots && <Loader2Icon aria-hidden className="text-muted-foreground m-2 size-4 animate-spin" />}
                    {roots.map((message) => (
                      <label key={message.id} className="hover:bg-muted/40 flex items-start gap-2 rounded-md px-2 py-1 text-sm">
                        <input type="checkbox" checked={selected.has(message.id)} onChange={() => toggle(message.id)} className="mt-0.5" />
                        <span className="min-w-0">
                          <span className="block truncate">{message.author?.name ?? t("roomArchives.unknownAuthor")}</span>
                          <span className="text-muted-foreground line-clamp-2 break-words text-xs">{message.body}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </>
              )}

              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={includeEmails} onChange={(event) => setIncludeEmails(event.currentTarget.checked)} className="mt-0.5" />
                <span>
                  <span className="block">{t("roomArchives.includeEmails")}</span>
                  <span className="text-muted-foreground block text-xs">{t("roomArchives.includeEmailsHelp")}</span>
                </span>
              </label>
              <p className="text-muted-foreground text-xs">{t("roomArchives.membersNotice")}</p>
            </div>
          )}

          {step === "choose" && mode === "import" && (
            <div className="flex flex-col gap-3">
              <input
                ref={fileInput}
                type="file"
                accept=".zip,.okaychat-room.zip,application/zip"
                className="sr-only"
                aria-label={t("roomArchives.chooseFile")}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void upload(file);
                }}
              />
              <p className="text-sm">{t("roomArchives.importNotice")}</p>
              <Button type="button" variant="outline" className="self-start" onClick={() => fileInput.current?.click()}>
                <UploadIcon aria-hidden /> {t("roomArchives.chooseFile")}
              </Button>
            </div>
          )}

          {step === "job" && job && (
            <div className="flex flex-col gap-3">
              <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm">
                {activeState(job) && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
                <span>{t(PHASE_KEYS[job.phase])}</span>
              </p>
              {activeState(job) && <p aria-live="off" className="text-muted-foreground text-xs">{progressText(job)}</p>}
              <p className="text-muted-foreground text-xs">{t("roomArchives.expiresAt", { time: formatDateTime(job.expiresAt) })}</p>

              {job.state === "failed" && (
                <div role="alert" className="text-destructive flex flex-col gap-1 text-sm">
                  <span>{t("roomArchives.errorTitle")}</span>
                  <span>{t(ERROR_KEYS[job.error?.code ?? "import_failed"])}</span>
                  {quotaLink && (
                    <a className="text-primary text-xs underline underline-offset-2" href={settingsHref("usage")}>{t("roomArchives.errStorageQuota")}</a>
                  )}
                </div>
              )}
              {job.state === "cancelled" && <p role="status" className="text-muted-foreground text-sm">{t("roomArchives.cancelled")}</p>}
              {job.state === "expired" && <p role="status" className="text-muted-foreground text-sm">{t("roomArchives.expired")}</p>}

              {job.kind === "export" && job.state === "ready" && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm">{t("roomArchives.readyExport")}</p>
                  {currentSummary && (
                    <p className="text-muted-foreground text-xs">
                      {t("roomArchives.selectedRoots", { count: currentSummary.roots })} · {formatBytes(currentSummary.zipBytes)}
                    </p>
                  )}
                  <a
                    href={`/api/room-archives/${encodeURIComponent(job.id)}/download`}
                    download
                    className="depth-primary text-primary-foreground inline-flex h-9 items-center gap-2 self-start rounded-lg px-3 text-sm font-medium"
                  >
                    <DownloadIcon aria-hidden className="size-4" /> {t("roomArchives.download")}
                  </a>
                </div>
              )}

              {job.kind === "import" && job.state === "ready" && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm">{t("roomArchives.readyImport")}</p>
                  <label className="flex flex-col gap-1 text-sm font-medium">
                    {t("roomArchives.reviewName")}
                    <Input value={name} maxLength={80} onChange={(event) => setName(event.currentTarget.value)} aria-label={t("roomArchives.reviewName")} />
                  </label>
                  {reviewing && (
                    <p role="status" aria-live="polite" className="text-muted-foreground flex items-center gap-2 text-xs">
                      <Loader2Icon aria-hidden className="size-3 animate-spin" /> {t("roomArchives.reviewRefreshing")}
                    </p>
                  )}
                  {currentSummary && (
                    <div className="flex flex-col gap-1 text-xs">
                      <p className="text-muted-foreground">
                        {t("roomArchives.selectedRoots", { count: currentSummary.roots })} · {formatNumber(currentSummary.replies)} · {formatNumber(currentSummary.attachments)}
                      </p>
                      <p className="text-muted-foreground">
                        {t("roomArchives.identities", { recognized: formatNumber(currentSummary.recognizedAuthors), unknown: formatNumber(currentSummary.unknownAuthors) })}
                      </p>
                      <p className="text-muted-foreground">{t("roomArchives.sourceVisibility", { visibility: t(`channels.${currentSummary.sourceVisibility}` as PlainMessageKey) })}</p>
                      {currentSummary.sourceArchived && <p className="text-muted-foreground">{t("roomArchives.sourceArchived")}</p>}
                      <p className="text-muted-foreground">{t("roomArchives.finalStorage", { bytes: formatBytes(currentSummary.finalStorageBytes) })}</p>
                      <p className="text-muted-foreground">{t("roomArchives.temporaryReservation", { bytes: formatBytes(currentSummary.temporaryReservationBytes) })}</p>
                      <p className={cn("text-muted-foreground", currentSummary.quotaUsedBytes + currentSummary.finalStorageBytes > currentSummary.quotaLimitBytes && "text-destructive")}>
                        {t("roomArchives.quota", { used: formatBytes(currentSummary.quotaUsedBytes), limit: formatBytes(currentSummary.quotaLimitBytes) })}
                      </p>
                      <a className="text-primary underline underline-offset-2" href={settingsHref("usage")}>{t("roomArchives.quota", { used: formatBytes(currentSummary.quotaUsedBytes), limit: formatBytes(currentSummary.quotaLimitBytes) })}</a>
                    </div>
                  )}
                  <div>
                    <h4 className="mb-1 text-xs font-medium">{t("roomArchives.warningTitle")}</h4>
                    <WarningList warnings={currentSummary?.warnings ?? []} />
                  </div>
                  <RoomArchiveRoster jobId={job.id} />
                </div>
              )}

              {job.kind === "import" && job.state === "done" && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm">{t("roomArchives.phaseComplete")}</p>
                  <Button type="button" className="self-start" onClick={openRoom} disabled={!job.result?.channelId}>
                    <FileArchiveIcon aria-hidden /> {t("roomArchives.openRoom")}
                  </Button>
                </div>
              )}

              {(activeState(job) || job.state === "ready") && (
                <p className="text-muted-foreground text-xs">{t("roomArchives.membersNotice")}</p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex-wrap gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>
          {step === "job" && job && (activeState(job) || job.state === "ready") && (
            <Button type="button" variant="outline" onClick={() => void cancel(job.id)}>
              {t("roomArchives.cancelJob")}
            </Button>
          )}
          {step === "job" && job && (job.state === "failed" || job.state === "cancelled" || job.state === "expired") && (
            <Button type="button" variant="outline" onClick={() => { reset(); setStep("choose"); setDigest(null); setSummary(null); }}>
              {t("roomArchives.retry")}
            </Button>
          )}
          {step === "choose" && mode === "export" && (
            <Button type="button" disabled={busy || (selectionMode === "roots" && !selected.size)} onClick={() => void prepare()}>
              <DownloadIcon aria-hidden /> {t("roomArchives.exportRoom")}
            </Button>
          )}
          {step === "job" && job?.kind === "import" && job.state === "ready" && (
            <Button type="button" disabled={!canImport} onClick={() => { if (job && digest) void confirm(job.id, name.trim(), digest); }}>
              <UploadIcon aria-hidden /> {t("roomArchives.import")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
