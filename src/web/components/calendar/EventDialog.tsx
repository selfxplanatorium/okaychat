import { ExternalLinkIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CalendarEvent, CalendarEventWrite, CalendarResolveResult } from "@shared/calendar";
import { MAX_EVENT_SPAN_DAYS } from "@shared/calendar";
import { addCivilDays, canonicalZone, formatDateString, formatInZone, parseDateString, parseLocalDateTime } from "@shared/calendar-time";
import type { Project, ThreadSummary } from "@shared/types";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCommand } from "@/keyboard/registry";
import { ApiError, api } from "@/lib/api";
import { uuidV4 } from "@/lib/ids";
import { useCalendar } from "@/state/calendar";
import { CalendarConflictDialog } from "./CalendarConflictDialog";
import { EventTimeFields } from "./EventTimeFields";
import { ReminderOffsets } from "./ReminderOffsets";
import { TimeZonePicker } from "./TimeZonePicker";

interface Form {
  title: string;
  allDay: boolean;
  startLocal: string;
  endLocal: string;
  startDate: string;
  endDate: string;
  timeZone: string;
  description: string;
  location: string;
  url: string;
  reminderOffsets: number[];
  threadId: string | null;
  projectId: string | null;
}

const localOf = (zone: string, at: number): string => {
  const parts = formatInZone(zone, at);
  return `${formatDateString(parts)}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
};

function nextHalfHour(zone: string, now = Date.now()): { start: string; end: string } {
  const civil = formatInZone(zone, now);
  const base = { year: civil.year, month: civil.month, day: civil.day };
  let minute = civil.minute < 30 ? 30 : 0;
  let hour = civil.minute < 30 ? civil.hour : civil.hour + 1;
  let date = base;
  if (hour >= 24) {
    hour -= 24;
    date = addCivilDays(base, 1);
  }
  const start = `${formatDateString(date)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const endDate = hour === 23 ? addCivilDays(date, 1) : date;
  const end = `${formatDateString(endDate)}T${String((hour + 1) % 24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return { start, end };
}

function formOf(event: CalendarEvent | null, zone: string, initialDate: string): Form {
  if (!event) {
    const defaults = nextHalfHour(zone);
    return {
      title: "",
      allDay: false,
      startLocal: defaults.start,
      endLocal: defaults.end,
      startDate: initialDate,
      endDate: formatDateString(addCivilDays(parseDateString(initialDate) ?? { year: 1970, month: 1, day: 1 }, 1)),
      timeZone: zone,
      description: "",
      location: "",
      url: "",
      reminderOffsets: [],
      threadId: null,
      projectId: null,
    };
  }
  return {
    title: event.title,
    allDay: event.allDay,
    startLocal: event.allDay ? "" : localOf(event.timeZone, event.effectiveStartAt),
    endLocal: event.allDay ? "" : localOf(event.timeZone, event.effectiveEndAt),
    startDate: event.startDate ?? initialDate,
    endDate: event.endDate ?? initialDate,
    timeZone: event.timeZone,
    description: event.description,
    location: event.location,
    url: event.url,
    reminderOffsets: [...event.reminderOffsets],
    threadId: event.threadId,
    projectId: event.projectId,
  };
}

/** Explicit-save event form. Timed writes resolve clock strings through the authoritative server. */
export function EventDialog({
  open,
  event,
  initialDate,
  zone,
  projects,
  onClose,
}: {
  open: boolean;
  event: CalendarEvent | null;
  initialDate: string;
  zone: string;
  projects: Project[];
  onClose: () => void;
}) {
  const [form, setForm] = useState<Form>(() => formOf(event, zone, initialDate));
  const [resolved, setResolved] = useState<CalendarResolveResult | null>(null);
  const [selectedStart, setSelectedStart] = useState<number | null>(event && !event.allDay ? event.startAt : null);
  const [selectedEnd, setSelectedEnd] = useState<number | null>(event && !event.allDay ? event.endAt : null);
  const [resolveFailed, setResolveFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const initial = useRef<Form>(formOf(event, zone, initialDate));
  const titleRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const resolveToken = useRef(0);

  useEffect(() => {
    if (!open) return;
    const next = formOf(event, zone, initialDate);
    initial.current = next;
    setForm(next);
    setResolved(null);
    setSelectedStart(event && !event.allDay ? event.startAt : null);
    setSelectedEnd(event && !event.allDay ? event.endAt : null);
    setError(null);
    setNotice(null);
    const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
    requestAnimationFrame(() => (coarse ? headingRef.current : titleRef.current)?.focus());
  }, [open, event, zone, initialDate]);

  useEffect(() => {
    if (!open) return;
    void api<ThreadSummary[]>("/threads").then(setThreads).catch(() => setThreads([]));
  }, [open]);

  useEffect(() => {
    if (!open || form.allDay) {
      setResolved(null);
      return;
    }
    if (!parseLocalDateTime(form.startLocal) || !parseLocalDateTime(form.endLocal)) {
      setResolved(null);
      return;
    }
    const token = ++resolveToken.current;
    const timer = setTimeout(() => {
      void api<CalendarResolveResult>("/calendar/resolve-time", {
        method: "POST",
        json: { timeZone: form.timeZone, startLocal: form.startLocal, endLocal: form.endLocal },
      })
        .then((result) => {
          if (token !== resolveToken.current) return;
          setResolved(result);
          setResolveFailed(false);
          setSelectedStart((current) => (result.startCandidates.some((candidate) => candidate.at === current) ? current : result.startCandidates.length === 1 ? result.startCandidates[0]!.at : null));
          setSelectedEnd((current) => (result.endCandidates.some((candidate) => candidate.at === current) ? current : result.endCandidates.length === 1 ? result.endCandidates[0]!.at : null));
        })
        .catch(() => {
          if (token === resolveToken.current) {
            setResolved(null);
            setResolveFailed(true);
          }
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [open, form.allDay, form.timeZone, form.startLocal, form.endLocal]);

  const dirty = JSON.stringify(form) !== JSON.stringify(initial.current);

  const requestClose = () => {
    if (dirty) setDiscardOpen(true);
    else onClose();
  };

  const set = (patch: Partial<Form>) => setForm((current) => ({ ...current, ...patch }));

  const toggleAllDay = (allDay: boolean) => {
    if (allDay) {
      const start = form.startLocal ? form.startLocal.slice(0, 10) : initialDate;
      const date = parseDateString(start) ?? { year: 1970, month: 1, day: 1 };
      set({ allDay, startDate: start, endDate: formatDateString(addCivilDays(date, 1)) });
    } else {
      set({ allDay, startLocal: `${form.startDate}T09:00`, endLocal: `${form.startDate}T10:00` });
    }
  };

  const payload = (): CalendarEventWrite | null => {
    if (!form.title.trim()) {
      setError(t("calendar.requiredTitle"));
      return null;
    }
    const zoneValue = canonicalZone(form.timeZone);
    if (!zoneValue) {
      setError(t("calendar.invalidZone"));
      return null;
    }
    if (form.allDay) {
      const start = parseDateString(form.startDate);
      const end = parseDateString(form.endDate);
      if (!start || !end) {
        setError(t("calendar.skippedDate", { zone: form.timeZone }));
        return null;
      }
      if (formatDateString(end) <= formatDateString(start)) {
        setError(t("calendar.invalidRange"));
        return null;
      }
      const days = Math.round((Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day)) / 86_400_000);
      if (days > MAX_EVENT_SPAN_DAYS) {
        setError(t("calendar.tooLong"));
        return null;
      }
      return {
        allDay: true,
        timeZone: zoneValue,
        startAt: null,
        endAt: null,
        startDate: form.startDate,
        endDate: form.endDate,
        title: form.title,
        description: form.description,
        location: form.location,
        url: form.url,
        reminderOffsets: form.reminderOffsets,
        threadId: form.threadId,
        projectId: form.projectId,
      };
    }
    if (form.reminderOffsets.length > 5 || new Set(form.reminderOffsets).size !== form.reminderOffsets.length || form.reminderOffsets.some((offset) => !Number.isInteger(offset) || offset < 0 || offset > 40_320)) {
      setError(t("calendar.invalidOffset"));
      return null;
    }
    if (!resolved || resolveFailed) {
      setError(t("calendar.resolveFailed"));
      return null;
    }
    const startAt = resolved.startCandidates.length === 1 ? resolved.startCandidates[0]!.at : selectedStart;
    const endAt = resolved.endCandidates.length === 1 ? resolved.endCandidates[0]!.at : selectedEnd;
    if (startAt === null || endAt === null) {
      setError(resolved.startCandidates.length === 0 || resolved.endCandidates.length === 0 ? t("calendar.gap", { zone: form.timeZone }) : t("calendar.fold"));
      return null;
    }
    if (endAt <= startAt) {
      setError(t("calendar.invalidRange"));
      return null;
    }
    return {
      allDay: false,
      timeZone: zoneValue,
      startAt,
      endAt,
      startDate: null,
      endDate: null,
      title: form.title,
      description: form.description,
      location: form.location,
      url: form.url,
      reminderOffsets: form.reminderOffsets,
      threadId: form.threadId,
      projectId: form.projectId,
    };
  };

  const save = async () => {
    const write = payload();
    if (!write) return;
    setSaving(true);
    setError(null);
    try {
      if (event) {
        const result = await api<{ event: CalendarEvent }>(`/calendar/events/${encodeURIComponent(event.id)}`, {
          method: "PUT",
          json: { ...write, revision: event.revision },
        });
        useCalendar.getState().applyEvent(result.event);
        setNotice(t("calendar.saved"));
        initial.current = form;
        onClose();
      } else {
        const result = await api<{ event: CalendarEvent }>("/calendar/events", {
          method: "POST",
          json: { ...write, requestId: uuidV4() },
        });
        useCalendar.getState().applyEvent(result.event);
        setNotice(t("calendar.saved"));
        initial.current = form;
        onClose();
      }
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        if (failure.message.includes("10,000")) setError(t("calendar.limit", { count: 10_000 }));
        else setConflictOpen(true);
      }
      else if (failure instanceof ApiError && failure.status === 413) setError(t("calendar.saveFailed"));
      else if (failure instanceof ApiError && failure.status === 403) setError(t("calendar.disabled"));
      else setError(t("calendar.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!event) return;
    try {
      await api(`/calendar/events/${encodeURIComponent(event.id)}`, { method: "DELETE", json: { revision: event.revision } });
      useCalendar.getState().removeEvent(event.id);
      setDeleteOpen(false);
      onClose();
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 409 ? t("calendar.conflict") : t("calendar.saveFailed"));
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${form.title}\n${form.startLocal || form.startDate}\n${form.endLocal || form.endDate}\n${form.description}`);
    } catch {
      setError(t("calendar.saveFailed"));
    }
  };

  const saveCopy = async () => {
    const write = payload();
    if (!write) return;
    try {
      const result = await api<{ event: CalendarEvent }>("/calendar/events", { method: "POST", json: { ...write, requestId: uuidV4() } });
      useCalendar.getState().applyEvent(result.event);
      setConflictOpen(false);
      onClose();
    } catch {
      setError(t("calendar.saveFailed"));
    }
  };

  useCommand("calendar.save", () => void save(), open && !saving);
  useCommand("calendar.delete", () => (event ? setDeleteOpen(true) : undefined), open && !!event);
  useCommand("calendar.copyLocal", () => void copy(), open);

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && requestClose()}>
        <DialogContent className="flex max-h-[min(92dvh,50rem)] flex-col gap-4 overflow-hidden sm:max-w-2xl max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:translate-0 max-sm:rounded-none max-sm:p-4">
          <DialogHeader>
            <DialogTitle ref={headingRef} className="text-base">{event ? t("calendar.title") : t("calendar.new")}</DialogTitle>
            <DialogDescription className="sr-only">{t("calendar.optional")}</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pe-1">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{t("calendar.titleLabel")}</span>
              <Input ref={titleRef} value={form.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} aria-label={t("calendar.titleLabel")} />
            </label>
            <label className="flex min-h-8 items-center gap-2 text-sm">
              <input type="checkbox" checked={form.allDay} onChange={(e) => toggleAllDay(e.target.checked)} /> {t("calendar.allDay")}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <TimeZonePicker value={form.timeZone} onChange={(timeZone) => set({ timeZone })} disabled={saving} />
              {form.timeZone !== initial.current.timeZone && <span className="text-muted-foreground text-xs">{t("calendar.zoneChange")}</span>}
            </div>
            <EventTimeFields
              allDay={form.allDay}
              timeZone={form.timeZone}
              startLocal={form.startLocal}
              endLocal={form.endLocal}
              startDate={form.startDate}
              endDate={form.endDate}
              startCandidates={resolved?.startCandidates ?? []}
              endCandidates={resolved?.endCandidates ?? []}
              selectedStart={selectedStart}
              selectedEnd={selectedEnd}
              onStartLocal={(startLocal) => set({ startLocal })}
              onEndLocal={(endLocal) => set({ endLocal })}
              onStartDate={(startDate) => set({ startDate })}
              onEndDate={(endDate) => set({ endDate })}
              onSelectStart={setSelectedStart}
              onSelectEnd={setSelectedEnd}
              disabled={saving}
            />
            <details className="border-border rounded-lg border p-2" open={!!(form.description || form.location || form.url || form.reminderOffsets.length || form.threadId || form.projectId)}>
              <summary className="cursor-pointer text-sm">{t("calendar.optional")}</summary>
              <div className="mt-2 flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">{t("calendar.description")}</span>
                  <Textarea value={form.description} maxLength={20_000} onChange={(e) => set({ description: e.target.value })} aria-label={t("calendar.description")} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">{t("calendar.location")}</span>
                  <Input value={form.location} maxLength={500} onChange={(e) => set({ location: e.target.value })} aria-label={t("calendar.location")} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">{t("calendar.url")}</span>
                  <Input value={form.url} maxLength={2048} inputMode="url" onChange={(e) => set({ url: e.target.value })} aria-label={t("calendar.url")} />
                  {form.url && !/^https?:\/\//i.test(form.url) && <span role="alert" className="text-destructive text-xs">{t("calendar.invalidUrl")}</span>}
                  {form.url && /^https?:\/\//i.test(form.url) && (
                    <a href={form.url} target="_blank" rel="noopener noreferrer" className="text-primary inline-flex items-center gap-1 text-xs underline">
                      <ExternalLinkIcon aria-hidden className="size-3" /> {t("calendar.openLink")}
                    </a>
                  )}
                </label>
                <ReminderOffsets offsets={form.reminderOffsets} onChange={(reminderOffsets) => set({ reminderOffsets })} allDay={form.allDay} zone={form.timeZone} disabled={saving} />
                {(form.threadId || form.projectId) && (
                  <div className="flex flex-wrap gap-3 text-xs">
                    {form.threadId && <a className="text-primary underline" href={`/c/${form.threadId}`}>{t("calendar.openThread")}</a>}
                    {form.projectId && <a className="text-primary underline" href="/projects">{t("calendar.openProject")}</a>}
                  </div>
                )}
                <div className="grid gap-2 sm:grid-cols-2">
                  <Select
                    aria-label={t("calendar.linkedThread")}
                    value={form.threadId ?? ""}
                    onValueChange={(threadId) => set({ threadId: threadId || null })}
                    options={[{ value: "", label: t("calendar.noThread") }, ...threads.map((thread) => ({ value: thread.id, label: thread.title || t("calendar.linkedThread") }))]}
                  />
                  <Select
                    aria-label={t("calendar.project")}
                    value={form.projectId ?? ""}
                    onValueChange={(projectId) => set({ projectId: projectId || null })}
                    options={[{ value: "", label: t("calendar.noProject") }, ...projects.map((project) => ({ value: project.id, label: project.name }))]}
                  />
                </div>
              </div>
            </details>
            {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
            {resolveFailed && <p role="alert" className="text-destructive text-sm">{t("calendar.resolveFailed")}</p>}
          </div>
          <DialogFooter className="flex-wrap">
            {event && (
              <Button variant="destructive" onClick={() => setDeleteOpen(true)} className="me-auto">
                <Trash2Icon aria-hidden /> {t("calendar.delete")}
              </Button>
            )}
            <Button variant="outline" onClick={requestClose}>{t("calendar.cancel")}</Button>
            <Button onClick={() => void save()} disabled={saving} data-command="calendar.save">
              {saving ? t("calendar.saving") : t("calendar.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("calendar.deleteTitle", { title: form.title || t("calendar.title") })}</DialogTitle>
            <DialogDescription>{t("calendar.deleteBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>{t("calendar.cancel")}</Button>
            <Button variant="destructive" onClick={() => void remove()}>{t("calendar.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("calendar.discardTitle")}</DialogTitle>
            <DialogDescription>{t("calendar.discardTitle")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscardOpen(false)}>{t("calendar.keepEditing")}</Button>
            <Button variant="destructive" onClick={() => { setDiscardOpen(false); onClose(); }}>{t("calendar.cancel")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <CalendarConflictDialog
        open={conflictOpen}
        onClose={() => setConflictOpen(false)}
        onReload={async () => {
          if (!event) return;
          try {
            const latest = await api<{ event: CalendarEvent }>(`/calendar/events/${encodeURIComponent(event.id)}`);
            useCalendar.getState().applyEvent(latest.event);
            const next = formOf(latest.event, zone, initialDate);
            initial.current = next;
            setForm(next);
            setConflictOpen(false);
          } catch {
            setError(t("calendar.loadFailed"));
          }
        }}
        onSaveCopy={() => void saveCopy()}
        onCopy={() => void copy()}
      />
      <span role="status" aria-live="polite" className="sr-only">{notice ?? ""}</span>
    </>
  );
}
