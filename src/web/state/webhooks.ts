import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useData } from "@/state/data";
import type {
  EndpointCreateInput,
  EndpointCreateResult,
  EndpointDetail,
  EndpointPatchInput,
  EndpointSummary,
  RequestPreview,
} from "@shared/outgoing-webhooks";

/**
 * Page-local webhook settings state (docs/implementation/outgoing-webhooks.md). Endpoints and statistics
 * only: a URL/header draft and the one-time signing secret belong to mounted components and are never
 * written to localStorage, an outbox, or a store. Late answers for a previous account are discarded.
 */

export interface WebhookState {
  endpoints: EndpointSummary[];
  loading: boolean;
  error: boolean;
  refresh: () => void;
  create: (input: EndpointCreateInput) => Promise<EndpointCreateResult>;
  update: (id: string, input: EndpointPatchInput) => Promise<EndpointDetail>;
  remove: (id: string, revision: number) => Promise<void>;
  rotate: (id: string, revision: number) => Promise<{ endpoint: EndpointDetail; signingSecret: string }>;
  prepareTest: (id: string, revision: number) => Promise<{ preparationId: string; expiresAt: number; preview: RequestPreview }>;
  sendTest: (id: string, revision: number, preparationId: string) => Promise<{ deliveryId: string }>;
}

export function useWebhooks(): WebhookState {
  const userId = useData((state) => state.me?.id ?? null);
  const [endpoints, setEndpoints] = useState<EndpointSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const controllers = useRef(new Set<AbortController>());

  const request = useCallback(<T,>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> => {
    const controller = new AbortController();
    controllers.current.add(controller);
    return api<T>(path, { ...init, signal: controller.signal }).finally(() => controllers.current.delete(controller));
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    if (!userId) {
      setEndpoints([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    request<{ items: EndpointSummary[] }>("/webhooks")
      .then((next) => {
        if (generation.current !== current) return;
        setEndpoints(next.items);
        setError(false);
      })
      .catch(() => {
        if (generation.current !== current) return;
        setError(true);
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      // A late response from the previous account never paints this one.
      generation.current++;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    };
  }, [userId, request]);

  const refresh = useCallback(() => {
    if (!userId) return;
    const current = generation.current;
    request<{ items: EndpointSummary[] }>("/webhooks")
      .then((next) => {
        if (generation.current !== current) return;
        setEndpoints(next.items);
        setError(false);
        setLoading(false);
      })
      .catch(() => {
        if (generation.current === current) setError(true);
      });
  }, [userId, request]);

  const create = useCallback(async (input: EndpointCreateInput) => {
    const result = await request<EndpointCreateResult>("/webhooks", { method: "POST", json: input });
    refresh();
    return result;
  }, [request, refresh]);

  const update = useCallback(async (id: string, input: EndpointPatchInput) => {
    const result = await request<{ endpoint: EndpointDetail }>(`/webhooks/${encodeURIComponent(id)}`, { method: "PATCH", json: input });
    refresh();
    return result.endpoint;
  }, [request, refresh]);

  const remove = useCallback(async (id: string, revision: number) => {
    await request(`/webhooks/${encodeURIComponent(id)}`, { method: "DELETE", json: { revision } });
    refresh();
  }, [request, refresh]);

  const rotate = useCallback(async (id: string, revision: number) => {
    const result = await request<{ endpoint: EndpointDetail; signingSecret: string }>(`/webhooks/${encodeURIComponent(id)}/rotate-secret`, {
      method: "POST",
      json: { revision },
    });
    refresh();
    return result;
  }, [request, refresh]);

  const prepareTest = useCallback(async (id: string, revision: number) => {
    return request<{ preparationId: string; expiresAt: number; preview: RequestPreview }>(`/webhooks/${encodeURIComponent(id)}/test/prepare`, {
      method: "POST",
      json: { revision },
    });
  }, [request]);

  const sendTest = useCallback(async (id: string, revision: number, preparationId: string) => {
    return request<{ deliveryId: string }>(`/webhooks/${encodeURIComponent(id)}/test/send`, {
      method: "POST",
      json: { revision, preparationId },
    });
  }, [request]);

  return { endpoints, loading, error, refresh, create, update, remove, rotate, prepareTest, sendTest };
}
