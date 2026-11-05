import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ApiKeyAuditPage,
  type ApiKeyAuditRow,
  type ApiKeyListResponse,
  type ApiKeySummary,
  type ApiRequestPage,
  type ApiRequestSummary,
  type ApiUsageDays,
  type ApiUsageResponse,
  type CreateApiKeyInput,
  type CreateApiKeyResult,
} from "@shared/api-access";
import { api } from "@/lib/api";
import { useData } from "@/state/data";

// Page-local API access state (docs/implementation/api-access.md): no persisted store, no outbox, no
// startup fetch, and no place for a created secret. The token lives only in the created dialog.

export type ApiAccessErrorKey = "loadFailed" | "createFailed" | "revokeFailed";

export interface ApiAccessData {
  keys: ApiKeySummary[];
  enabled: boolean;
  serverTime: number;
  loading: boolean;
  error: ApiAccessErrorKey | null;
  usage: ApiUsageResponse | null;
  usageLoading: boolean;
  usageError: boolean;
  days: ApiUsageDays;
  groupBy: ApiUsageResponse["groupBy"];
  keyFilter: string | null;
  requests: ApiRequestSummary[];
  requestsCursor: string | null;
  requestsBefore: string[];
  requestsError: boolean;
  audit: ApiKeyAuditRow[];
  auditCursor: number | null;
  auditBefore: number[];
  auditError: boolean;
  setDays: (days: ApiUsageDays) => void;
  setGroupBy: (groupBy: ApiUsageResponse["groupBy"]) => void;
  setKeyFilter: (keyId: string | null) => void;
  refresh: () => void;
  nextRequests: () => void;
  previousRequests: () => void;
  nextAudit: () => void;
  previousAudit: () => void;
  createKey: (input: CreateApiKeyInput) => Promise<CreateApiKeyResult>;
  revokeKey: (id: string) => Promise<ApiKeySummary | null>;
}

export function useApiAccessData(): ApiAccessData {
  const userId = useData((s) => s.me?.id ?? null);
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [serverTime, setServerTime] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiAccessErrorKey | null>(null);
  const [usage, setUsage] = useState<ApiUsageResponse | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState(false);
  const [days, setDays] = useState<ApiUsageDays>(30);
  const [groupBy, setGroupBy] = useState<ApiUsageResponse["groupBy"]>("day");
  const [keyFilter, setKeyFilter] = useState<string | null>(null);
  const [requests, setRequests] = useState<ApiRequestSummary[]>([]);
  const [requestsCursor, setRequestsCursor] = useState<string | null>(null);
  const [requestsBefore, setRequestsBefore] = useState<string[]>([]);
  const [requestsError, setRequestsError] = useState(false);
  const [audit, setAudit] = useState<ApiKeyAuditRow[]>([]);
  const [auditCursor, setAuditCursor] = useState<number | null>(null);
  const [auditBefore, setAuditBefore] = useState<number[]>([]);
  const [auditError, setAuditError] = useState(false);
  const generation = useRef(0);
  // Each list also has its own token: a filter or page change must not be overwritten by an older answer,
  // even while both answers belong to the same account.
  const requestsToken = useRef(0);
  const auditToken = useRef(0);
  const controllers = useRef(new Set<AbortController>());

  const request = useCallback(<T,>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> => {
    const controller = new AbortController();
    controllers.current.add(controller);
    return api<T>(path, { ...init, signal: controller.signal }).finally(() => controllers.current.delete(controller));
  }, []);

  const loadUsage = useCallback(async (gen: number) => {
    const query = new URLSearchParams({ days: String(days), groupBy });
    if (keyFilter) query.set("keyId", keyFilter);
    setUsageLoading(true);
    try {
      const next = await request<ApiUsageResponse>(`/api-keys/usage?${query}`);
      if (generation.current !== gen) return;
      setUsage(next);
      setUsageError(false);
    } catch {
      if (generation.current !== gen) return;
      setUsageError(true);
    } finally {
      if (generation.current === gen) setUsageLoading(false);
    }
  }, [days, groupBy, keyFilter, request]);

  const loadRequests = useCallback(async (gen: number, before?: string) => {
    const query = new URLSearchParams({ limit: "50" });
    if (keyFilter) query.set("keyId", keyFilter);
    if (before) query.set("before", before);
    const token = ++requestsToken.current;
    try {
      const page = await request<ApiRequestPage>(`/api-keys/requests?${query}`);
      if (generation.current !== gen || requestsToken.current !== token) return;
      setRequests(page.rows);
      setRequestsCursor(page.nextCursor);
      setRequestsError(false);
    } catch {
      if (generation.current !== gen || requestsToken.current !== token) return;
      // Keep the rows already on screen; an empty table would claim there is no activity.
      setRequestsError(true);
      setRequestsCursor(null);
    }
  }, [keyFilter, request]);

  const loadAudit = useCallback(async (gen: number, before?: number) => {
    const query = new URLSearchParams({ limit: "50" });
    if (before !== undefined) query.set("before", String(before));
    const token = ++auditToken.current;
    try {
      const page = await request<ApiKeyAuditPage>(`/api-keys/audit?${query}`);
      if (generation.current !== gen || auditToken.current !== token) return;
      setAudit(page.rows);
      setAuditCursor(page.nextCursor);
      setAuditError(false);
    } catch {
      if (generation.current !== gen || auditToken.current !== token) return;
      setAuditError(true);
      setAuditCursor(null);
    }
  }, [request]);

  const loadKeys = useCallback(async (gen: number) => {
    try {
      const next = await request<ApiKeyListResponse>("/api-keys");
      if (generation.current !== gen) return;
      setKeys(next.keys);
      setEnabled(next.enabled);
      setServerTime(next.serverTime);
      setError(null);
    } catch {
      if (generation.current !== gen) return;
      setError("loadFailed");
    } finally {
      if (generation.current === gen) setLoading(false);
    }
  }, [request]);

  const reload = useCallback((resetPages: boolean) => {
    const gen = generation.current;
    void loadKeys(gen);
    void loadUsage(gen);
    if (resetPages) {
      setRequestsBefore([]);
      setAuditBefore([]);
      void loadRequests(gen);
      void loadAudit(gen);
    } else {
      void loadRequests(gen, requestsBefore.at(-1));
      void loadAudit(gen, auditBefore.at(-1));
    }
  }, [loadKeys, loadUsage, loadRequests, loadAudit, requestsBefore, auditBefore]);

  // Account switches and unmounts discard every late answer.
  useEffect(() => {
    generation.current += 1;
    const gen = generation.current;
    setKeys([]);
    setUsage(null);
    setRequests([]);
    setAudit([]);
    setRequestsBefore([]);
    setRequestsError(false);
    setAuditBefore([]);
    setAuditError(false);
    setKeyFilter(null);
    setError(null);
    setLoading(true);
    void loadKeys(gen);
    void loadUsage(gen);
    void loadRequests(gen);
    void loadAudit(gen);
    const owned = controllers.current;
    return () => {
      generation.current += 1;
      for (const controller of owned) controller.abort();
      owned.clear();
    };
    // The account is the only identity; filter changes reload through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Filter changes reload the bounded panels without touching the key list.
  useEffect(() => {
    const gen = generation.current;
    void loadUsage(gen);
  }, [days, groupBy, keyFilter, loadUsage]);

  useEffect(() => {
    const gen = generation.current;
    setRequestsBefore([]);
    setAuditBefore([]);
    void loadRequests(gen);
    void loadAudit(gen);
  }, [keyFilter, loadRequests, loadAudit]);

  // Entry and refocus refresh the page; there is no polling.
  useEffect(() => {
    const onFocus = () => {
      const gen = generation.current;
      void loadKeys(gen);
      void loadUsage(gen);
      void loadRequests(gen, requestsBefore.at(-1));
      void loadAudit(gen, auditBefore.at(-1));
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadKeys, loadUsage, loadRequests, loadAudit, requestsBefore, auditBefore]);

  const createKey = useCallback(async (input: CreateApiKeyInput): Promise<CreateApiKeyResult> => {
    const gen = generation.current;
    try {
      const result = await request<CreateApiKeyResult>("/api-keys", { method: "POST", json: input });
      if (generation.current === gen) {
        setError(null);
        reload(true);
      }
      return result;
    } catch (cause) {
      if (generation.current === gen) {
        setError("createFailed");
        // The create outcome may be unknown; a list refresh shows whether the key exists.
        reload(true);
      }
      throw cause;
    }
  }, [request, reload]);

  const revokeKey = useCallback(async (id: string): Promise<ApiKeySummary | null> => {
    const gen = generation.current;
    try {
      const result = await request<{ key: ApiKeySummary }>(`/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (generation.current === gen) {
        setError(null);
        reload(true);
      }
      return result.key;
    } catch (cause) {
      if (generation.current === gen) {
        setError("revokeFailed");
        reload(true);
      }
      throw cause;
    }
  }, [request, reload]);

  const nextRequests = useCallback(() => {
    if (!requestsCursor) return;
    setRequestsBefore((before) => [...before, requestsCursor]);
    void loadRequests(generation.current, requestsCursor);
  }, [requestsCursor, loadRequests]);

  const previousRequests = useCallback(() => {
    setRequestsBefore((before) => {
      const next = before.slice(0, -1);
      void loadRequests(generation.current, next.at(-1));
      return next;
    });
  }, [loadRequests]);

  const nextAudit = useCallback(() => {
    if (auditCursor === null) return;
    setAuditBefore((before) => [...before, auditCursor]);
    void loadAudit(generation.current, auditCursor);
  }, [auditCursor, loadAudit]);

  const previousAudit = useCallback(() => {
    setAuditBefore((before) => {
      const next = before.slice(0, -1);
      void loadAudit(generation.current, next.at(-1));
      return next;
    });
  }, [loadAudit]);

  return {
    keys,
    enabled,
    serverTime,
    loading,
    error,
    usage,
    usageLoading,
    usageError,
    days,
    groupBy,
    keyFilter,
    requests,
    requestsCursor,
    requestsError,
    requestsBefore,
    audit,
    auditCursor,
    auditError,
    auditBefore,
    setDays,
    setGroupBy,
    setKeyFilter,
    refresh: () => reload(true),
    nextRequests,
    previousRequests,
    nextAudit,
    previousAudit,
    createKey,
    revokeKey,
  };
}
