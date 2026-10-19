import { useAui } from "@assistant-ui/react";
import { Loader2Icon, MessageSquareIcon, PencilIcon, PlayIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import type { Schedule, ScheduleSpec } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useActiveModel, useData } from "@/state/data";
import { SettingsPage, SettingsSection } from "./SettingsUI";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const INTERVALS = [
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "hour" },
  { value: "180", label: "3 hours" },
  { value: "360", label: "6 hours" },
  { value: "720", label: "12 hours" },
];

function describe(spec: ScheduleSpec): string {
  if (spec.kind === "interval") return `Every ${INTERVALS.find((i) => Number(i.value) === spec.minutes)?.label ?? `${spec.minutes} minutes`}`;
  const days =
    spec.weekdays.length === 0 || spec.weekdays.length === 7
      ? "Every day"
      : spec.weekdays.join() === "1,2,3,4,5"
        ? "Weekdays"
        : spec.weekdays.map((d) => DAYS[d]).join(", ");
  return `${days} at ${spec.time}`;
}

const when = (t: number | null) => (t ? new Date(t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

function ScheduleForm({ initial, onDone }: { initial?: Schedule; onDone: () => void }) {
  const models = useData((s) => s.models);
  const active = useActiveModel();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [modelRef, setModelRef] = useState(initial?.modelRef ?? active?.ref ?? "");
  const [kind, setKind] = useState<ScheduleSpec["kind"]>(initial?.spec.kind ?? "daily");
  const [time, setTime] = useState(initial?.spec.kind === "daily" ? initial.spec.time : "08:00");
  const [weekdays, setWeekdays] = useState<number[]>(initial?.spec.kind === "daily" ? initial.spec.weekdays : [1, 2, 3, 4, 5]);
  const [minutes, setMinutes] = useState(initial?.spec.kind === "interval" ? String(initial.spec.minutes) : "60");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const spec: ScheduleSpec =
      kind === "daily" ? { kind, time, weekdays, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : { kind, minutes: Number(minutes) };
    try {
      const body = { title, prompt, modelRef, spec, enabled: initial?.enabled ?? true };
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
      className="flex flex-col gap-3 px-4 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input placeholder="Name (e.g. Morning news brief)" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
      <Textarea placeholder="Prompt, e.g. Search the web for today's top AI news and give me five bullet points with links." value={prompt} onChange={(e) => setPrompt(e.target.value)} className="min-h-24" required />
      <Select aria-label="Model" value={modelRef} onValueChange={setModelRef} options={models.map((m) => ({ value: m.ref, label: `${m.name} · ${m.providerId}` }))} />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Select
          aria-label="Repeat"
          className="w-auto"
          value={kind}
          onValueChange={setKind}
          options={[
            { value: "daily", label: "At a time" },
            { value: "interval", label: "Every" },
          ]}
        />
        {kind === "daily" ? (
          <>
            <Input type="time" className="h-8 w-32" value={time} onChange={(e) => setTime(e.target.value)} required />
            <div className="flex gap-1">
              {DAYS.map((d, i) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={weekdays.includes(i)}
                  onClick={() => setWeekdays(weekdays.includes(i) ? weekdays.filter((w) => w !== i) : [...weekdays, i].sort())}
                  className={cn("h-8 rounded-lg border px-2 text-xs", weekdays.includes(i) ? "bg-primary text-primary-foreground border-transparent" : "text-muted-foreground hover:bg-muted")}
                >
                  {d}
                </button>
              ))}
            </div>
          </>
        ) : (
          <Select aria-label="Interval" className="w-auto" value={minutes} onValueChange={setMinutes} options={INTERVALS} />
        )}
      </div>
      <p className="text-muted-foreground text-xs">Runs on the server, so your browser can be closed. Results land in this schedule's own chat. Tools that need approval wait until you open it.</p>
      {error && <p className="text-error text-xs">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2Icon className="animate-spin" />}
          {initial ? "Save" : "Add schedule"}
        </Button>
      </div>
    </form>
  );
}

export function ScheduleSettings() {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const models = useData((s) => s.models);
  const aui = useAui();
  const [, navigate] = useLocation();
  const refresh = useCallback(() => api<Schedule[]>("/schedules").then(setSchedules), []);

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
    api(`/schedules/${s.id}`, { method: "PUT", json: { title: s.title, prompt: s.prompt, modelRef: s.modelRef, spec: s.spec, enabled: s.enabled, ...patch } }).then(refresh);

  const openThread = async (threadId: string) => {
    await aui.threads.reload();
    navigate("/");
    aui.threads.switchToThread(threadId);
  };

  return (
    <SettingsPage title="Scheduled prompts" description="Run a prompt on a schedule, even when okaychat is closed.">
      <SettingsSection
        action={
          editing !== "new" && (
            <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
              <PlusIcon /> New schedule
            </Button>
          )
        }
      >
        {editing === "new" && (
          <ScheduleForm
            onDone={() => {
              setEditing(null);
              void refresh();
            }}
          />
        )}
        {schedules?.length === 0 && editing !== "new" && <p className="text-muted-foreground px-4 py-6 text-sm">No schedules yet.</p>}
        {schedules?.map((s) =>
          editing === s.id ? (
            <ScheduleForm
              key={s.id}
              initial={s}
              onDone={() => {
                setEditing(null);
                void refresh();
              }}
            />
          ) : (
            <div key={s.id} className="flex items-start gap-3 px-4 py-3">
              <Switch className="mt-0.5" checked={s.enabled} onCheckedChange={(enabled) => void save(s, { enabled })} aria-label={`Enable ${s.title}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{s.title}</p>
                <p className="text-muted-foreground text-xs">
                  {describe(s.spec)} · {models.find((m) => m.ref === s.modelRef)?.name ?? s.modelRef}
                </p>
                <p className="text-muted-foreground text-xs">
                  {s.lastStatus === "running" ? (
                    <span className="inline-flex items-center gap-1">
                      <Loader2Icon className="size-3 animate-spin" /> Running
                    </span>
                  ) : (
                    <>
                      Last {when(s.lastRunAt)}
                      {s.lastStatus === "error" && <span className="text-error"> · {s.lastError}</span>}
                    </>
                  )}
                  {s.enabled && ` · Next ${when(s.nextRunAt)}`}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                {s.threadId && (
                  <Button size="icon-sm" variant="ghost" aria-label="Open chat" onClick={() => void openThread(s.threadId!)}>
                    <MessageSquareIcon />
                  </Button>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Run now"
                  disabled={s.lastStatus === "running"}
                  onClick={() => void api(`/schedules/${s.id}/run`, { method: "POST" }).then(() => setTimeout(() => void refresh(), 300))}
                >
                  <PlayIcon />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Edit" onClick={() => setEditing(s.id)}>
                  <PencilIcon />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Delete" onClick={() => void api(`/schedules/${s.id}`, { method: "DELETE" }).then(refresh)}>
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
