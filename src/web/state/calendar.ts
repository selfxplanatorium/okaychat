import { create } from "zustand";
import type { CalendarEvent, CalendarEventSummary, CalendarPage } from "@shared/calendar";
import { ApiError, api } from "@/lib/api";
import { DENSE_RANGE_LIMIT, viewBounds, type CalendarView } from "@/lib/calendar-layout";

/**
 * Calendar workspace state: view, anchor date, display zone, range query, paged summaries, and the
 * independently fetched selected event. Focus/online refresh is explicit; there is no polling.
 */

export interface CalendarPrefs {
  view: CalendarView;
  anchor: string;
  zone: string;
}

export const summaryOfEvent = (event: CalendarEvent): CalendarEventSummary => {
  const { description: _description, location: _location, url: _url, ...rest } = event;
  return rest;
};

const prefsKey = (accountId: string) => `okaychat:calendar-view:${accountId}`;

export function readCalendarPrefs(accountId: string): CalendarPrefs | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(prefsKey(accountId)) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const prefs = parsed as Partial<CalendarPrefs>;
    if (prefs.view !== "agenda" && prefs.view !== "month" && prefs.view !== "week") return null;
    if (typeof prefs.anchor !== "string" || typeof prefs.zone !== "string") return null;
    return { view: prefs.view, anchor: prefs.anchor, zone: prefs.zone };
  } catch {
    return null;
  }
}

export function writeCalendarPrefs(accountId: string, prefs: CalendarPrefs): void {
  try {
    localStorage.setItem(prefsKey(accountId), JSON.stringify(prefs));
  } catch {
    // A denied storage write only loses the remembered view.
  }
}

type LoadStatus = "idle" | "loading" | "ready" | "error";

interface CalendarState {
  accountId: string | null;
  view: CalendarView;
  anchor: string;
  zone: string;
  q: string;
  projectId: string | null | undefined;
  events: CalendarEventSummary[];
  from: number;
  to: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  partial: boolean;
  dense: boolean;
  nextCursor: string | null;
  selectedId: string | null;
  selected: CalendarEvent | null;
  selectedStatus: LoadStatus;
  selectedError: string | null;
  disabled: boolean;
  begin: (accountId: string, prefs: CalendarPrefs) => void;
  reset: () => void;
  setView: (view: CalendarView) => void;
  setAnchor: (anchor: string) => void;
  setZone: (zone: string) => void;
  setSearch: (q: string) => void;
  setProject: (projectId: string | null | undefined) => void;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  openEvent: (id: string) => Promise<void>;
  closeEvent: () => void;
  applyEvent: (event: CalendarEvent) => void;
  removeEvent: (id: string) => void;
  markDisabled: () => void;
}

let generation = 0;
let rangeToken = 0;

const errorText = (error: unknown) => (error instanceof ApiError ? error.message : String(error));

function eventsQuery(state: Pick<CalendarState, "q" | "projectId">, from: number, to: number, cursor?: string): string {
  const params = new URLSearchParams({ from: String(from), to: String(to), limit: "100" });
  if (state.q) params.set("q", state.q);
  if (state.projectId !== undefined) params.set("projectId", state.projectId ?? "none");
  if (cursor) params.set("cursor", cursor);
  return `/calendar/events?${params.toString()}`;
}

export const useCalendar = create<CalendarState>((set, get) => {
  const loadRange = async () => {
    const state = get();
    if (!state.accountId) return;
    const token = generation;
    const request = ++rangeToken;
    const bounds = viewBounds(state.view, state.anchor, state.zone);
    set({ loading: true, error: null, partial: false, dense: false, nextCursor: null, events: [], from: bounds.from, to: bounds.to });
    try {
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: CalendarPage = await api<CalendarPage>(eventsQuery(state, bounds.from, bounds.to, cursor ?? undefined));
        if (token !== generation || request !== rangeToken) return;
        cursor = page.nextCursor;
        pages++;
        set((current) => {
          const seen = new Set(current.events.map((item) => item.id));
          const events = [...current.events, ...page.items.filter((item) => !seen.has(item.id))];
          return {
            events,
            nextCursor: cursor,
            loading: false,
            dense: events.length >= DENSE_RANGE_LIMIT,
          };
        });
        // A dense range stops paging until the user asks for more; agenda shows the density notice.
        if (get().dense) break;
      } while (cursor && pages < 12);
    } catch (error) {
      if (token !== generation || request !== rangeToken) return;
      if (error instanceof ApiError && error.status === 403) set({ disabled: true, loading: false, error: error.message });
      else if (get().events.length) set({ loading: false, partial: true, error: errorText(error) });
      else set({ loading: false, error: errorText(error) });
    }
  };

  const savePrefs = () => {
    const { accountId, view, anchor, zone } = get();
    if (accountId) writeCalendarPrefs(accountId, { view, anchor, zone });
  };

  return {
    accountId: null,
    view: "agenda",
    anchor: "1970-01-01",
    zone: "UTC",
    q: "",
    projectId: undefined,
    events: [],
    from: 0,
    to: 0,
    loading: false,
    loadingMore: false,
    error: null,
    partial: false,
    dense: false,
    nextCursor: null,
    selectedId: null,
    selected: null,
    selectedStatus: "idle",
    selectedError: null,
    disabled: false,
    begin(accountId, prefs) {
      if (get().accountId === accountId) {
        set({ view: prefs.view, anchor: prefs.anchor, zone: prefs.zone });
        void loadRange();
        return;
      }
      generation++;
      rangeToken++;
      set({
        accountId,
        view: prefs.view,
        anchor: prefs.anchor,
        zone: prefs.zone,
        q: "",
        projectId: undefined,
        events: [],
        from: 0,
        to: 0,
        loading: true,
        loadingMore: false,
        error: null,
        partial: false,
        dense: false,
        nextCursor: null,
        selectedId: null,
        selected: null,
        selectedStatus: "idle",
        selectedError: null,
        disabled: false,
      });
      void loadRange();
    },
    reset() {
      generation++;
      rangeToken++;
      set({
        accountId: null,
        view: "agenda",
        anchor: "1970-01-01",
        zone: "UTC",
        q: "",
        projectId: undefined,
        events: [],
        from: 0,
        to: 0,
        loading: false,
        loadingMore: false,
        error: null,
        partial: false,
        dense: false,
        nextCursor: null,
        selectedId: null,
        selected: null,
        selectedStatus: "idle",
        selectedError: null,
        disabled: false,
      });
    },
    setView(view) {
      set({ view });
      savePrefs();
      void loadRange();
    },
    setAnchor(anchor) {
      set({ anchor });
      savePrefs();
      void loadRange();
    },
    setZone(zone) {
      set({ zone });
      savePrefs();
      void loadRange();
    },
    setSearch(q) {
      set({ q });
      void loadRange();
    },
    setProject(projectId) {
      set({ projectId });
      void loadRange();
    },
    refresh: async () => {
      await loadRange();
      // Keep the editor snapshot stable; background refresh must not reset edits or advance its CAS base.
      // Explicit Reload or reopening fetches the selected record.
    },
    loadMore: async () => {
      const state = get();
      const cursor = state.nextCursor;
      if (!cursor || state.loadingMore) return;
      set({ loadingMore: true });
      const token = generation;
      try {
        const page = await api<CalendarPage>(eventsQuery(state, state.from, state.to, cursor));
        if (token !== generation) return;
        set((current) => {
          const seen = new Set(current.events.map((item) => item.id));
          const events = [...current.events, ...page.items.filter((item) => !seen.has(item.id))];
          return { events, nextCursor: page.nextCursor, loadingMore: false, dense: events.length >= DENSE_RANGE_LIMIT };
        });
      } catch (error) {
        if (token === generation) set({ loadingMore: false, partial: true, error: errorText(error) });
      }
    },
    async openEvent(id) {
      const token = generation;
      set({ selectedId: id, selectedStatus: "loading", selectedError: null });
      try {
        const result = await api<{ event: CalendarEvent }>(`/calendar/events/${encodeURIComponent(id)}`);
        if (token !== generation || get().selectedId !== id) return;
        set({ selected: result.event, selectedStatus: "ready" });
      } catch (error) {
        if (token !== generation || get().selectedId !== id) return;
        if (error instanceof ApiError && error.status === 403) set({ disabled: true, selectedStatus: "error", selectedError: error.message });
        else set({ selected: null, selectedStatus: "error", selectedError: errorText(error) });
      }
    },
    closeEvent() {
      set({ selectedId: null, selected: null, selectedStatus: "idle", selectedError: null });
    },
    applyEvent(event) {
      set((state) => ({
        selected: state.selectedId === event.id ? event : state.selected,
        selectedStatus: state.selectedId === event.id ? "ready" : state.selectedStatus,
        events: state.events.some((item) => item.id === event.id)
          ? state.events.map((item) => (item.id === event.id ? summaryOfEvent(event) : item))
          : [...state.events, summaryOfEvent(event)],
      }));
    },
    removeEvent(id) {
      set((state) => ({
        events: state.events.filter((item) => item.id !== id),
        selectedId: state.selectedId === id ? null : state.selectedId,
        selected: state.selectedId === id ? null : state.selected,
        selectedStatus: state.selectedId === id ? "idle" : state.selectedStatus,
      }));
    },
    markDisabled() {
      set({ disabled: true });
    },
  };
});

export const resetCalendar = () => useCalendar.getState().reset();
