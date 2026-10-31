import { useAui } from "@assistant-ui/react";
import { Loader2Icon, MessageSquareIcon, PencilIcon, PlayIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useLocation, useSearch } from "wouter";
import type { Schedule, ScheduleSpec, ThreadSummary } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { t, type PlainMessageKey } from "@/i18n";
import { formatDate, formatList, formatTime } from "@/i18n/format";
import { Trans } from "@/i18n/react";
import { cn } from "@/lib/utils";
import { showChat, useActiveModel, useData } from "@/state/data";
import { ModelSelect } from "../chat/ModelPicker";
import { SettingsPage, SettingsSection } from "./SettingsUI";

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const INTERVALS = [
  { value: "15", label: "schedules.interval15", every: "schedules.every15" },
  { value: "30", label: "schedules.interval30", every: "schedules.every30" },
  { value: "60", label: "schedules.interval60", every: "schedules.every60" },
  { value: "180", label: "schedules.interval180", every: "schedules.every180" },
  { value: "360", label: "schedules.interval360", every: "schedules.every360" },
  { value: "720", label: "schedules.interval720", every: "schedules.every720" },
] as const satisfies ReadonlyArray<{ value: string; label: PlainMessageKey; every: PlainMessageKey }>;

// 2024-01-07 was a Sunday, so day index 0 is Sunday.
const dayName = (day: number) => formatDate(new Date(2024, 0, 7 + day), { weekday: "short" });

function describe(spec: ScheduleSpec): string {
  if (spec.kind === "interval") {
    const known = INTERVALS.find((i) => Number(i.value) === spec.minutes);
    return known ? t(known.every) : t("schedules.everyMinutes", { count: spec.minutes });
  }
  const [hours = 0, minutes = 0] = spec.time.split(":").map(Number);
  const time = formatTime(new Date(2000, 0, 1, hours, minutes));
  if (spec.weekdays.length === 0 || spec.weekdays.length === 7) return t("schedules.everyDayAt", { time });
  if (spec.weekdays.join() === "1,2,3,4,5") return t("schedules.weekdaysAt", { time });
  return t("schedules.daysAt", { days: formatList(spec.weekdays.map(dayName), { type: "unit", style: "narrow" }), time });
}

type Target = "own" | "new" | "existing";

const TARGETS: Array<{ value: Target; label: PlainMessageKey }> = [
  { value: "own", label: "schedules.targetOwn" },
  { value: "new", label: "schedules.targetNew" },
  { value: "existing", label: "schedules.targetExisting" },
];

const HINTS = {
  own: "schedules.hintOwn",
  new: "schedules.hintNew",
  existing: "schedules.hintExisting",
} as const satisfies Record<Target, PlainMessageKey>;

const targetOf = (s: Schedule): Target => (s.threadMode === "new" ? "new" : s.threadAttached ? "existing" : "own");

const when = (time: number | null) =>
  time ? formatDate(time, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

function ScheduleForm({ initial, initialThreadId, onDone }: { initial?: Schedule; initialThreadId?: string; onDone: () => void }) {
  const projects = useData((s) => s.projects);
  const active = useActiveModel();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [modelRef, setModelRef] = useState(initial?.modelRef ?? active?.ref ?? "");
  const [kind, setKind] = useState<ScheduleSpec["kind"]>(initial?.spec.kind ?? "daily");
  const [time, setTime] = useState(initial?.spec.kind === "daily" ? initial.spec.time : "08:00");
  const [weekdays, setWeekdays] = useState<number[]>(initial?.spec.kind === "daily" ? initial.spec.weekdays : [1, 2, 3, 4, 5]);
  const [minutes, setMinutes] = useState(initial?.spec.kind === "interval" ? String(initial.spec.minutes) : "60");
  const [target, setTarget] = useState<Target>(initial ? targetOf(initial) : initialThreadId ? "existing" : "own");
  const [threadId, setThreadId] = useState(initial?.threadAttached ? initial.threadId : (initialThreadId ?? null));
  const [projectId, setProjectId] = useState(initial?.projectId ?? "");
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (target !== "existing" || threads) return;
    void api<ThreadSummary[]>("/threads").then(setThreads, () => setThreads([]));
  }, [target, threads]);

  const submit = async () => {
    if (target === "existing" && !threadId) return setError(t("schedules.pickChatError"));
    setBusy(true);
    setError(null);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const spec: ScheduleSpec =
      kind === "daily" ? { kind, time, weekdays, timeZone } : { kind, minutes: Number(minutes), timeZone };
    try {
      const body = {
        title,
        prompt,
        modelRef,
        spec,
        enabled: initial?.enabled ?? true,
        threadMode: target === "new" ? "new" : "same",
        threadId: target === "existing" ? threadId : null,
        projectId: target === "existing" ? null : projectId || null,
      };
      if (initial) await api(`/schedules/${initial.id}`, { method: "PUT", json: body });
      else await api("/schedules", { method: "POST", json: body });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="animate-rise-in flex flex-col gap-3 px-4 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input placeholder={t("schedules.namePlaceholder")} value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
      <Textarea placeholder={t("schedules.promptPlaceholder")} value={prompt} onChange={(e) => setPrompt(e.target.value)} className="min-h-24" required />
      <ModelSelect aria-label={t("schedules.model")} value={modelRef} onValueChange={setModelRef} />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Select
          aria-label={t("schedules.repeat")}
          className="w-auto"
          value={kind}
          onValueChange={setKind}
          options={[
            { value: "daily", label: t("schedules.atATime") },
            { value: "interval", label: t("schedules.every") },
          ]}
        />
        {kind === "daily" ? (
          <>
            <Input type="time" className="h-8 w-32" value={time} onChange={(e) => setTime(e.target.value)} required />
            <div className="flex gap-1">
              {WEEKDAYS.map((i) => (
                <button
                  key={i}
                  type="button"
                  aria-pressed={weekdays.includes(i)}
                  onClick={() => setWeekdays(weekdays.includes(i) ? weekdays.filter((w) => w !== i) : [...weekdays, i].sort())}
                  className={cn(
                    "h-8 rounded-lg border px-2 text-xs transition-colors duration-(--motion-fast)",
                    weekdays.includes(i) ? "bg-primary text-primary-foreground border-transparent" : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {dayName(i)}
                </button>
              ))}
            </div>
          </>
        ) : (
          <Select
            aria-label={t("schedules.interval")}
            className="w-auto"
            value={minutes}
            onValueChange={setMinutes}
            options={INTERVALS.map((i) => ({ value: i.value, label: t(i.label) }))}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label={t("schedules.resultsGoTo")} className="w-auto" value={target} onValueChange={setTarget} options={TARGETS.map((x) => ({ value: x.value, label: t(x.label) }))} />
        {target === "existing" ? (
          <Select
            aria-label={t("schedules.chat")}
            className="min-w-0 flex-1"
            value={threadId}
            onValueChange={setThreadId}
            placeholder={threads ? t("schedules.pickChat") : t("schedules.loadingChats")}
            disabled={!threads}
            options={(threads ?? []).map((thread) => ({ value: thread.id, label: thread.title || t("schedules.untitledChat") }))}
          />
        ) : (
          projects.length > 0 && (
            <Select
              aria-label={t("schedules.project")}
              className="w-auto"
              value={projectId}
              onValueChange={setProjectId}
              options={[{ value: "", label: t("schedules.noProject") }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
            />
          )
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {t(HINTS[target])}
      </p>
      {error && <p className="text-error settings-error text-xs">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2Icon className="animate-spin" />}
          {initial ? t("common.save") : t("schedules.addSchedule")}
        </Button>
      </div>
    </form>
  );
}

export function ScheduleSettings() {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const models = useData((s) => s.models);
  const aui = useAui();
  const [path, navigate] = useLocation();
  // "Schedule a prompt" in a chat's options opens the form with that chat picked.
  const params = new URLSearchParams(useSearch());
  const fromThread = params.get("thread") ?? undefined;
  // The sidebar's + and the command palette arrive with ?new=1, so the form is waiting.
  const requested = params.get("new") === "1";
  const [editing, setEditing] = useState<string | "new" | null>(fromThread || requested ? "new" : null);
  useEffect(() => {
    if (fromThread || requested) setEditing("new");
  }, [fromThread, requested]);
  const refresh = useCallback(() => api<Schedule[]>("/schedules").then(setSchedules), []);
  const done = () => {
    setEditing(null);
    // Clear the query, or navigating back to this page would reopen a form the user closed.
    if (fromThread || requested) navigate(path, { replace: true });
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Follow runs started with "Run now" until they finish.
  const anyRunning = schedules?.some((s) => s.lastStatus === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [anyRunning, refresh]);

  const save = (s: Schedule, patch: Partial<Schedule>) =>
    api(`/schedules/${s.id}`, {
      method: "PUT",
      json: { title: s.title, prompt: s.prompt, modelRef: s.modelRef, spec: s.spec, enabled: s.enabled, threadMode: s.threadMode, threadId: s.threadId, projectId: s.projectId, ...patch },
    }).then(refresh);

  const openThread = async (threadId: string) => {
    await aui.threads.reload();
    await aui.threads.switchToThread(threadId);
    showChat(navigate);
  };

  return (
    <SettingsPage title={t("schedules.title")} description={t("schedules.description")}>
      <SettingsSection
        action={
          editing !== "new" && (
            <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
              <PlusIcon /> {t("schedules.newSchedule")}
            </Button>
          )
        }
      >
        {editing === "new" && (
          <ScheduleForm
            initialThreadId={fromThread}
            onDone={() => {
              done();
              void refresh();
            }}
          />
        )}
        {schedules?.length === 0 && editing !== "new" && (
          <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
            <p className="text-muted-foreground animate-fade-in text-sm">{t("schedules.empty")}</p>
            <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
              <PlusIcon /> {t("schedules.newSchedule")}
            </Button>
          </div>
        )}
        {schedules?.map((s, index) =>
          editing === s.id ? (
            <ScheduleForm
              key={s.id}
              initial={s}
              onDone={() => {
                done();
                void refresh();
              }}
            />
          ) : (
            <div key={s.id} className="stagger animate-rise-in flex items-start gap-3 px-4 py-3" style={{ "--i": index } as CSSProperties}>
              <Switch className="mt-0.5" checked={s.enabled} onCheckedChange={(enabled) => void save(s, { enabled })} aria-label={t("schedules.enable", { title: s.title })} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{s.title}</p>
                <p className="text-muted-foreground text-xs">
                  {describe(s.spec)} · {models.find((m) => m.ref === s.modelRef)?.name ?? s.modelRef}
                  {s.threadMode === "new" && ` · ${t("schedules.newChatEachRun")}`}
                </p>
                <p className="text-muted-foreground text-xs">
                  {s.lastStatus === "running" ? (
                    <span className="animate-fade-in inline-flex items-center gap-1">
                      <Loader2Icon className="size-3 animate-spin" /> {t("schedules.running")}
                    </span>
                  ) : (
                    s.lastStatus === "error" ? (
                      <Trans k="schedules.lastRunError" params={{ date: when(s.lastRunAt), error: <span className="text-error">{s.lastError}</span> }} />
                    ) : (
                      t("schedules.lastRun", { date: when(s.lastRunAt) })
                    )
                  )}
                  {s.enabled && ` · ${t("schedules.nextRun", { date: when(s.nextRunAt) })}`}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                {s.threadId && (
                  <Button size="icon-sm" variant="ghost" aria-label={s.threadMode === "new" ? t("schedules.openLatestChat") : t("schedules.openChat")} onClick={() => void openThread(s.threadId!)}>
                    <MessageSquareIcon />
                  </Button>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("schedules.runNow")}
                  disabled={s.lastStatus === "running"}
                  onClick={() => void api(`/schedules/${s.id}/run`, { method: "POST" }).then(() => setTimeout(() => void refresh(), 300))}
                >
                  <PlayIcon />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={t("common.edit")} onClick={() => setEditing(s.id)}>
                  <PencilIcon />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={t("common.delete")} onClick={() => void api(`/schedules/${s.id}`, { method: "DELETE" }).then(refresh)}>
                  <TrashIcon />
                </Button>
              </div>
            </div>
          ),
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
