import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch, useLocation } from "wouter";
import { t } from "@/i18n";
import { formatDate } from "@/i18n/format";
import { Button } from "@/components/ui/button";
import { useCommand } from "@/keyboard/registry";
import { canonicalZone } from "@shared/calendar-time";
import { useData } from "@/state/data";
import { readCalendarPrefs, useCalendar } from "@/state/calendar";
import { isSupportedDate, shiftAnchor, todayInZone, viewBounds, type CalendarView } from "@/lib/calendar-layout";
import { AgendaView } from "./AgendaView";
import { CalendarToolbar } from "./CalendarToolbar";
import { EventDialog } from "./EventDialog";
import { MonthView } from "./MonthView";
import { WeekView } from "./WeekView";

const dateLabel = (date: string) => formatDate(`${date}T12:00:00Z`, { month: "short", day: "numeric", timeZone: "UTC" });

function parseParams(search: string) {
  return new URLSearchParams(search);
}

export function CalendarPage() {
  const me = useData((state) => state.me);
  const projects = useData((state) => state.projects);
  const search = useSearch();
  const [location, navigate] = useLocation();
  const params = parseParams(search);
  const prefs = me ? readCalendarPrefs(me.id) : null;
  const fallbackZone = canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC";
  const initialZone = canonicalZone(params.get("zone")) ?? prefs?.zone ?? fallbackZone;
  const initialDate = isSupportedDate(params.get("date") ?? "") ? params.get("date")! : prefs?.anchor ?? todayInZone(initialZone);
  const initialView = (["agenda", "month", "week"] as const).find((value) => value === params.get("view"))
    ?? prefs?.view
    ?? (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches ? "agenda" : "month");

  const view = useCalendar((state) => state.view);
  const anchor = useCalendar((state) => state.anchor);
  const zone = useCalendar((state) => state.zone);
  const events = useCalendar((state) => state.events);
  const loading = useCalendar((state) => state.loading);
  const loadingMore = useCalendar((state) => state.loadingMore);
  const error = useCalendar((state) => state.error);
  const partial = useCalendar((state) => state.partial);
  const dense = useCalendar((state) => state.dense);
  const nextCursor = useCalendar((state) => state.nextCursor);
  const selectedId = useCalendar((state) => state.selectedId);
  const selected = useCalendar((state) => state.selected);
  const selectedStatus = useCalendar((state) => state.selectedStatus);
  const selectedError = useCalendar((state) => state.selectedError);
  const disabled = useCalendar((state) => state.disabled);
  const q = useCalendar((state) => state.q);
  const started = useRef<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDate, setCreateDate] = useState(initialDate);
  const [eventParam, setEventParam] = useState(params.get("event"));

  useEffect(() => {
    if (!me) return;
    if (started.current === me.id) return;
    started.current = me.id;
    useCalendar.getState().begin(me.id, { view: initialView, anchor: initialDate, zone: initialZone });
    // Deep links open their event independently of the visible range.
    const linked = params.get("event");
    if (linked) void useCalendar.getState().openEvent(linked);
  }, [me, initialView, initialDate, initialZone, params]);

  const handledNew = useRef(false);
  useEffect(() => {
    if (params.get("new") !== "1" || handledNew.current) return;
    handledNew.current = true;
    openCreate(anchor);
  }, [params, anchor]);

  useEffect(() => {
    const refresh = () => void useCalendar.getState().refresh();
    const online = () => void useCalendar.getState().refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", online);
    };
  }, []);

  useEffect(() => {
    if (!me || started.current !== me.id) return;
    const next = new URLSearchParams();
    next.set("view", view);
    next.set("date", anchor);
    next.set("zone", zone);
    const q = useCalendar.getState().q;
    if (q) next.set("q", q);
    if (selectedId) next.set("event", selectedId);
    const target = `/calendar?${next.toString()}`;
    if (location !== target) navigate(target, { replace: true });
  }, [me, view, anchor, zone, selectedId, location, navigate]);

  const bounds = useMemo(() => viewBounds(view, anchor, zone), [view, anchor, zone]);
  const rangeLabel = useMemo(() => {
    const first = bounds.dates[0]!;
    const last = bounds.dates.at(-1)!;
    return t("calendar.range", { start: dateLabel(first), end: dateLabel(last) });
  }, [bounds.dates]);

  const setView = (next: CalendarView) => useCalendar.getState().setView(next);
  const setAnchor = (next: string) => useCalendar.getState().setAnchor(next);
  const goToday = () => setAnchor(todayInZone(zone));
  const openEvent = (id: string) => {
    setCreateOpen(false);
    setEventParam(id);
    void useCalendar.getState().openEvent(id);
  };
  const openCreate = (date: string) => {
    useCalendar.getState().closeEvent();
    setEventParam(null);
    setCreateDate(date);
    setCreateOpen(true);
  };
  const closeEvent = () => {
    setEventParam(null);
    useCalendar.getState().closeEvent();
  };

  useCommand("calendar.create", () => openCreate(anchor), !disabled);
  useCommand("calendar.search", () => document.querySelector<HTMLElement>("[data-command=calendar.search]")?.focus(), !disabled);
  useCommand("calendar.today", goToday, !disabled);
  useCommand("calendar.previous", () => setAnchor(shiftAnchor(view, anchor, -1)), !disabled);
  useCommand("calendar.next", () => setAnchor(shiftAnchor(view, anchor, 1)), !disabled);
  useCommand("calendar.agenda", () => setView("agenda"), !disabled);
  useCommand("calendar.month", () => setView("month"), !disabled);
  useCommand("calendar.week", () => setView("week"), !disabled);

  if (!me) return null;

  if (disabled) {
    return (
      <main className="grid min-h-0 flex-1 place-items-center p-8">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold">{t("calendar.title")}</h1>
          <p role="alert" className="text-muted-foreground mt-2 text-sm">{t("calendar.disabled")}</p>
        </div>
      </main>
    );
  }

  const missing = !!selectedId && selectedStatus === "error";

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <CalendarToolbar
        view={view}
        zone={zone}
        rangeLabel={rangeLabel}
        count={events.length}
        search={q}
        onView={setView}
        onToday={goToday}
        onPrevious={() => setAnchor(shiftAnchor(view, anchor, -1))}
        onNext={() => setAnchor(shiftAnchor(view, anchor, 1))}
        onZone={(next) => useCalendar.getState().setZone(next)}
        onSearch={(value) => useCalendar.getState().setSearch(value)}
        onNew={() => openCreate(anchor)}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && !events.length && <p role="status" className="text-muted-foreground p-6 text-sm">{t("calendar.loading")}</p>}
        {error && !events.length && (
          <div role="alert" className="flex flex-col items-start gap-2 p-6 text-sm">
            <p>{t("calendar.loadFailed")}</p>
            <Button size="sm" variant="outline" onClick={() => void useCalendar.getState().refresh()}>{t("common.retry")}</Button>
          </div>
        )}
        {partial && <p role="alert" className="text-warning p-3 text-sm">{t("calendar.partialFailed")}</p>}
        {loadingMore && <p role="status" className="text-muted-foreground px-3 py-1 text-xs">{t("calendar.moreIncomplete")}</p>}
        {q && !events.length && !loading && (
          <div className="flex flex-col items-start gap-2 p-6 text-sm">
            <p>{t("calendar.noResults")}</p>
            <Button size="sm" variant="outline" onClick={() => useCalendar.getState().setSearch("")}>{t("calendar.clearFilters")}</Button>
          </div>
        )}
        {!loading && !events.length && !q && (
          <div className="flex flex-col items-center gap-1 p-8 text-center">
            <p className="text-sm font-medium">{t("calendar.empty")}</p>
            <p className="text-muted-foreground text-sm">{t("calendar.emptyBody")}</p>
          </div>
        )}
        {view === "agenda" && events.length > 0 && (
          <AgendaView
            dates={bounds.dates}
            events={events}
            zone={zone}
            onOpen={openEvent}
            dense={dense}
            onLoadMore={() => void useCalendar.getState().loadMore()}
            loadingMore={loadingMore}
          />
        )}
        {view === "month" && events.length > 0 && (
          <MonthView
            dates={bounds.dates}
            events={events}
            zone={zone}
            anchor={anchor}
            today={todayInZone(zone)}
            onOpen={openEvent}
            onDay={(date) => { setAnchor(date); setView("agenda"); }}
            onNewOnDay={openCreate}
          />
        )}
        {view === "week" && events.length > 0 && <WeekView dates={bounds.dates} events={events} zone={zone} onOpen={openEvent} />}
        {nextCursor && !dense && <Button variant="ghost" size="sm" className="m-3" onClick={() => void useCalendar.getState().loadMore()}>{t("calendar.loadingMore")}</Button>}
        {dense && view !== "agenda" && (
          <div role="status" className="border-warning/40 bg-warning/5 m-3 rounded-lg border p-3 text-sm">
            <p>{t("calendar.dense")}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => setView("agenda")}>{t("calendar.agenda")}</Button>
          </div>
        )}
        {missing && (
          <div role="alert" className="p-6 text-sm">
            <p>{t("calendar.missing")}</p>
            <p className="text-muted-foreground mt-1 text-xs">{selectedError}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={closeEvent}>{t("calendar.title")}</Button>
          </div>
        )}
        <p className="text-muted-foreground px-3 pb-4 text-[0.7rem]" title={t("calendar.rangeLimit")}>{t("calendar.range", { start: dateLabel(bounds.dates[0]!), end: dateLabel(bounds.dates.at(-1)!) })}</p>
      </div>
      <EventDialog
        open={createOpen || (!!selectedId && !missing)}
        event={createOpen ? null : selected}
        initialDate={createOpen ? createDate : anchor}
        zone={zone}
        projects={projects}
        onClose={() => {
          setCreateOpen(false);
          if (!createOpen) closeEvent();
        }}
      />
      {eventParam && !selectedId && <span className="sr-only">{t("calendar.loading")}</span>}
    </main>
  );
}
