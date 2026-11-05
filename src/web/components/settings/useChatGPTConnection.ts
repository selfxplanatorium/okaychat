import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { ChatGPTLoginIntent, ChatGPTLoginStart, ChatGPTStatus } from "@shared/chatgpt";
import type { PlainMessageKey } from "@/i18n";
import { api, responseError } from "@/lib/api";
import { errorText } from "@/lib/error-text";
import { useData } from "@/state/data";
import { useServices } from "@/state/services";
import {
  POLL_INTERVAL_MS,
  disconnectNoticeKey,
  initialChatGPTConnection,
  pendingAttempt,
  reduceChatGPTConnection,
  shouldPoll,
  type ChatGPTBusyAction,
  type ChatGPTDisconnectNotice,
} from "./chatgpt-connect-state";

// Server state, writes, same-session polling and account guards for the ChatGPT chat connection. The card
// renders this; the pure rules live in chatgpt-connect-state.ts so they can be tested without a browser.

const LAUNCH_FILE_LIMIT = 16 * 1024;

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const pageVisible = () => (typeof document === "undefined" ? true : document.visibilityState === "visible");
function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, pageVisible, () => true);
}

/**
 * A launch file is a single-use, capability-bearing download: fetch it explicitly (never through a link the
 * browser may prefetch) and hand it to the user as a file. The URL is never put in history or storage.
 */
async function downloadLaunchFile(path: string): Promise<void> {
  const url = path.startsWith("/api/") ? path : `/api${path.startsWith("/") ? "" : "/"}${path}`;
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store", redirect: "error" });
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event("okaychat:unauthorized"));
    throw await responseError(res, "/chatgpt/login/launch");
  }
  const blob = await res.blob();
  if (blob.size === 0 || blob.size > LAUNCH_FILE_LIMIT) throw new Error("unexpected launch file");
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = "okaychat-chatgpt-launch.json";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

export function useChatGPTConnection() {
  const accountId = useData((state) => state.me?.id ?? null);
  const refreshProviders = useData((state) => state.refreshProviders);
  const [state, dispatch] = useReducer(reduceChatGPTConnection, initialChatGPTConnection);
  const [busy, setBusy] = useState<ChatGPTBusyAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<PlainMessageKey | null>(null);
  /** The pending attempt's one-time launch download, held in memory only (never storage). */
  const [launch, setLaunch] = useState<{ attemptId: string; url: string } | null>(null);
  /** The attempt whose launch file this tab already saved; the server allows exactly one download. */
  const [launchSaved, setLaunchSaved] = useState<string | null>(null);
  const [welcomeDismissed, setWelcomeDismissed] = useState<ReadonlySet<string>>(() => new Set());
  /** Bumped when a focus refresh resets poll failures, so a stopped timer can start again. */
  const [pollToken, setPollToken] = useState(0);

  const sequence = useRef(0);
  const accountRef = useRef<string | null>(accountId);
  accountRef.current = accountId;
  const statusRef = useRef<ChatGPTStatus | null>(state.status);
  statusRef.current = state.status;
  const inFlight = useRef<AbortController | null>(null);
  const failures = useRef(0);
  const visible = usePageVisible();

  const load = useCallback(async () => {
    const account = accountRef.current;
    if (!account) return;
    const request = ++sequence.current;
    const controller = new AbortController();
    inFlight.current?.abort();
    inFlight.current = controller;
    try {
      const status = await api<ChatGPTStatus>("/chatgpt/status", { signal: controller.signal });
      if (controller.signal.aborted || accountRef.current !== account) return;
      failures.current = 0;
      dispatch({ type: "loaded", accountId: account, sequence: request, status });
    } catch (error) {
      if (controller.signal.aborted || accountRef.current !== account) return;
      failures.current += 1;
      dispatch({ type: "failed", accountId: account, sequence: request, text: errorText(error, "providers.chatgptStatusLoadFailed") });
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  }, []);

  // A different live attempt replaces the launch file; an old one must not be offered.
  const livePendingId = pendingAttempt(state.status, Date.now())?.id ?? null;
  useEffect(() => {
    if (!launch || !livePendingId || livePendingId === launch.attemptId) return;
    const replacedAttempt = launch.attemptId;
    setLaunch(null);
    setLaunchSaved((saved) => (saved === replacedAttempt ? null : saved));
  }, [livePendingId, launch]);

  // An account switch (or sign-out) clears every answer and aborts the request for the previous account.
  useEffect(() => {
    dispatch({ type: "account", accountId });
    inFlight.current?.abort();
    inFlight.current = null;
    failures.current = 0;
    setBusy(null);
    setActionError(null);
    setDownloadError(null);
    setNotice(null);
    setLaunch(null);
    setLaunchSaved(null);
    setWelcomeDismissed(new Set());
    if (accountId) void load();
  }, [accountId, load]);

  // Poll only a live attempt, only on a visible page, and stop at expiry or after repeated failures.
  const pending = pendingAttempt(state.status, Date.now());
  const pollKey = pending ? `${pending.id}:${pending.status}:${pending.expiresAt}` : "";
  useEffect(() => {
    if (!pollKey) return;
    if (!shouldPoll(statusRef.current, { visible, failures: failures.current })) return;
    const timer = setInterval(() => {
      if (!shouldPoll(statusRef.current, { visible, failures: failures.current })) {
        clearInterval(timer);
        return;
      }
      void load();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pollKey, visible, pollToken, load]);

  // Mobile resume (PWA focus/visibility) asks once more, with a short floor so focus storms cannot fan out.
  useEffect(() => {
    if (!accountId) return;
    let last = 0;
    const refresh = () => {
      const now = Date.now();
      if (now - last < 2_000) return;
      last = now;
      failures.current = 0;
      setPollToken((token) => token + 1);
      void load();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [accountId, load]);

  /** Every write needs the status endpoint's synchronizer token; it grants nothing without the session. */
  const write = useCallback(async <T,>(path: string, init: { method: string; json?: unknown }): Promise<T> => {
    const token = statusRef.current?.csrfToken;
    if (!token) throw new Error("The ChatGPT settings are still loading.");
    return api<T>(path, { method: init.method, json: init.json ?? {}, headers: { "X-CSRF-Token": token } });
  }, []);

  const refreshRelated = useCallback(() => {
    void refreshProviders().catch(() => {});
    void useServices.getState().refresh(true);
  }, [refreshProviders]);

  // A new registration, a plan grant or a disconnect changes the model list and provider health.
  const active = state.status?.registrations.find((registration) => registration.active) ?? null;
  const connectionSignature = `${active?.id ?? ""}:${active?.state ?? ""}`;
  const lastConnectionSignature = useRef<string | null>(null);
  useEffect(() => {
    if (lastConnectionSignature.current === null) {
      lastConnectionSignature.current = connectionSignature;
      return;
    }
    if (lastConnectionSignature.current === connectionSignature) return;
    lastConnectionSignature.current = connectionSignature;
    refreshRelated();
  }, [connectionSignature, refreshRelated]);

  const run = useCallback(async (action: Exclude<ChatGPTBusyAction, null>, task: () => Promise<void>): Promise<boolean> => {
    const account = accountRef.current;
    setBusy(action);
    setActionError(null);
    setNotice(null);
    try {
      await task();
      return accountRef.current === account;
    } catch (error) {
      if (accountRef.current === account) setActionError(errorText(error, "providers.chatgptActionFailed"));
      return false;
    } finally {
      if (accountRef.current === account) setBusy(null);
    }
  }, []);

  const start = useCallback(
    async (intent: ChatGPTLoginIntent, registrationId?: string) => {
      const account = accountRef.current;
      setBusy("start");
      setActionError(null);
      setDownloadError(null);
      setNotice(null);
      try {
        const started = await write<ChatGPTLoginStart>("/chatgpt/login", {
          method: "POST",
          json: { intent, ...(registrationId ? { registrationId } : {}) },
        });
        if (accountRef.current !== account) return;
        // Kept in memory until the user clicks Download: a browser-triggered download needs that gesture.
        setLaunch({ attemptId: started.attemptId, url: started.launchDownloadUrl });
        setLaunchSaved(null);
        await load();
      } catch (error) {
        if (accountRef.current === account) setActionError(errorText(error, "providers.chatgptStartFailed"));
      } finally {
        if (accountRef.current === account) setBusy(null);
      }
    },
    [load, write],
  );

  /** Saves the single-use launch file. A failed download is recoverable only by starting a new attempt. */
  const downloadLaunch = useCallback(
    async (attemptId: string) => {
      const account = accountRef.current;
      const target = launch;
      if (!target || target.attemptId !== attemptId || launchSaved === attemptId) return;
      setBusy("download");
      setDownloadError(null);
      try {
        await downloadLaunchFile(target.url);
        if (accountRef.current === account) {
          // The server consumes the capability before answering; it is never offered again.
          setLaunch(null);
          setLaunchSaved(attemptId);
        }
      } catch (error) {
        if (accountRef.current === account) {
          setLaunch(null);
          setDownloadError(errorText(error, "providers.chatgptDownloadFailed"));
        }
      } finally {
        if (accountRef.current === account) setBusy(null);
      }
    },
    [launch, launchSaved],
  );

  const cancel = useCallback(
    async (attemptId: string) => {
      await run("cancel", async () => {
        await write(`/chatgpt/login/${encodeURIComponent(attemptId)}`, { method: "DELETE" });
        setLaunch(null);
        setLaunchSaved(null);
        await load();
      });
    },
    [load, run, write],
  );

  const activate = useCallback(
    async (registrationId: string) => {
      await run("activate", async () => {
        await write(`/chatgpt/registrations/${encodeURIComponent(registrationId)}/activate`, { method: "POST" });
        await load();
      });
    },
    [load, run, write],
  );

  const disconnect = useCallback(
    async (registrationId: string) => {
      await run("disconnect", async () => {
        const result = await write<{ remoteRevocation: ChatGPTDisconnectNotice }>(`/chatgpt/registrations/${encodeURIComponent(registrationId)}`, { method: "DELETE" });
        setNotice(disconnectNoticeKey(result.remoteRevocation));
        await load();
      });
    },
    [load, run, write],
  );

  const forget = useCallback(
    async (registrationId: string) => {
      await run("forget", async () => {
        await write(`/chatgpt/registrations/${encodeURIComponent(registrationId)}/forget`, { method: "DELETE" });
        await load();
      });
    },
    [load, run, write],
  );

  const welcomeSeen = useCallback(
    async (registrationId: string) => {
      const account = accountRef.current;
      setWelcomeDismissed((current) => new Set(current).add(registrationId));
      const accepted = await run("welcome", async () => {
        await write(`/chatgpt/registrations/${encodeURIComponent(registrationId)}/welcome-seen`, { method: "POST" });
        await load();
      });
      // A failed acknowledgement must not hide the notice for good.
      if (!accepted && accountRef.current === account) setWelcomeDismissed((current) => {
        const next = new Set(current);
        next.delete(registrationId);
        return next;
      });
    },
    [load, run, write],
  );

  return {
    accountId,
    status: state.status,
    statusError: state.errorText,
    actionError,
    downloadError,
    notice,
    busy,
    launch,
    launchSaved,
    welcomeDismissed,
    start,
    downloadLaunch,
    cancel,
    activate,
    disconnect,
    forget,
    welcomeSeen,
    load,
  };
}

export type ChatGPTConnection = ReturnType<typeof useChatGPTConnection>;
