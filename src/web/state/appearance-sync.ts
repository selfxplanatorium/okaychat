import { useEffect, useState } from "react";
import { create } from "zustand";
import { appearanceSchema, type UserAppearance } from "@shared/appearance";
import { api } from "@/lib/api";
import { subscribeToCustomThemes } from "@/theme/palette";
import { appearanceSnapshot, DEFAULT_APPEARANCE, restoreAppearance, useAppearance } from "./appearance";

const OWNER_KEY = "okaychat:appearance-owner";
const cacheKey = (userId: string) => `okaychat:appearance:${userId}`;
type Patch = Partial<UserAppearance>;
type Cache = { value: UserAppearance; pending: Patch };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const useAppearanceSyncStatus = create<{ error: string | null }>(() => ({ error: null }));

/** Local edits stay immediate. Only changed fields are sent, so another device's unrelated edits survive. */
export function useSyncAppearance(userId: string | undefined): boolean {
  const [readyFor, setReadyFor] = useState<string>();
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    let applying = false;
    let initialized = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Patch = {};
    let value: UserAppearance;
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey(userId)) ?? "null") as Cache | null;
      const owner = localStorage.getItem(OWNER_KEY);
      value = cached ? appearanceSchema.parse(cached.value) : !owner || owner === userId
        ? appearanceSnapshot()
        : { ...DEFAULT_APPEARANCE, theme: "", mode: "system", halves: null, customThemes: [] };
      pending = cached ? appearanceSchema.partial().parse(cached.pending) : {};
      localStorage.setItem(OWNER_KEY, userId);
    } catch {
      value = { ...DEFAULT_APPEARANCE, theme: "", mode: "system", halves: null, customThemes: [] };
    }
    useAppearanceSyncStatus.setState({ error: null });

    const cache = () => {
      try { localStorage.setItem(cacheKey(userId), JSON.stringify({ value, pending })); } catch { /* Live preferences still work without storage. */ }
    };
    const apply = (next: UserAppearance) => {
      applying = true;
      value = next;
      try {
        restoreAppearance(next);
      } finally {
        applying = false;
      }
      cache();
    };
    const fail = () => {
      if (alive) useAppearanceSyncStatus.setState({ error: "Appearance is saved on this device. Sync will retry when you reconnect or return to the app." });
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), 400);
    };
    const flush = async () => {
      if (!alive || busy || !initialized || !Object.keys(pending).length) return;
      busy = true;
      const sent = { ...pending };
      let saved = false;
      try {
        const remote = await api<UserAppearance>("/appearance", { method: "PATCH", json: sent });
        if (!alive) return;
        // Keep edits made while this request was in flight.
        for (const key of Object.keys(sent) as Array<keyof UserAppearance>) {
          if (same(pending[key], sent[key])) delete pending[key];
        }
        apply({ ...remote, ...pending });
        useAppearanceSyncStatus.setState({ error: null });
        saved = true;
      } catch {
        fail();
      } finally {
        busy = false;
        if (saved && Object.keys(pending).length) schedule();
      }
    };
    const refresh = async () => {
      if (busy || !alive) return;
      busy = true;
      try {
        const remote = await api<UserAppearance | null>("/appearance");
        if (!alive) return;
        const initial = remote ?? await api<UserAppearance>("/appearance", { method: "PUT", json: value });
        if (!alive) return;
        initialized = true;
        apply({ ...initial, ...pending });
        useAppearanceSyncStatus.setState({ error: null });
      } catch {
        fail();
      } finally {
        busy = false;
        if (alive) {
          setReadyFor(userId);
          if (initialized) void flush();
        }
      }
    };
    apply(value);
    const onEdit = () => {
      if (applying) return;
      const next = appearanceSnapshot();
      const patch = Object.fromEntries(
        (Object.keys(next) as Array<keyof UserAppearance>).filter((key) => !same(value[key], next[key])).map((key) => [key, next[key]]),
      );
      if (!Object.keys(patch).length) return;
      pending = { ...pending, ...patch };
      value = next;
      cache();
      schedule();
    };
    const unsubscribe = useAppearance.subscribe(onEdit);
    const unsubscribeThemes = subscribeToCustomThemes(onEdit);
    // Keep a short debounce from dropping the last edit when the user reloads or closes the tab.
    const onPageHide = () => {
      if (initialized && Object.keys(pending).length) {
        void api("/appearance", { method: "PATCH", json: pending, keepalive: true }).catch(() => {});
      }
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("pagehide", onPageHide);
    void refresh();
    return () => {
      onPageHide();
      alive = false;
      clearTimeout(timer);
      unsubscribe();
      unsubscribeThemes();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [userId]);
  return !!userId && readyFor === userId;
}
