import { create } from "zustand";
import type { ServiceId, ServiceStatus } from "@shared/services";
import { api } from "@/lib/api";
import { parseServices, pruneDismissed, type ServiceView } from "./services-derive";

// Service health for the signed-in account. One request in flight per account, no timer: the shell starts it
// once, and a focus or a failed action asks again (the server keeps its own short cache and single-flight
// probe). Late answers for a previous account are dropped. See docs/implementation/service-health.md.

interface ServicesState extends ServiceView {
  /** The account these statuses belong to. Null before the first start and after reset. */
  accountId: string | null;
  /** True while this account has never had an answer. The banner shows "checking", never "down". */
  loading: boolean;
  /** The last request failed; keep the previous answer rather than showing an outage. */
  error: boolean;
  /** Called once from startup data and idempotent for the same account. */
  start: (accountId: string) => void;
  /** `force` asks the server to skip its cache; it is throttled and shares the in-flight probe. */
  refresh: (force?: boolean) => Promise<void>;
  /** A real interaction or a returned tool use, never a page load. */
  markUsed: (id: ServiceId) => void;
  dismiss: (ids: readonly ServiceId[]) => void;
  reset: () => void;
}

const DISMISS_KEY = "okaychat:services-dismissed";
const CHECK_COOLDOWN_MS = 10_000;

let generation = 0;
let inflight: { accountId: string; promise: Promise<void> } | null = null;
let lastCheck = 0;

const session = (fn: (storage: Storage) => void) => {
  try {
    fn(sessionStorage);
  } catch {
    // Session storage may be disabled; dismissal then only lasts until reload.
  }
};

const readDismissed = (accountId: string): Record<string, number> => {
  let value: unknown;
  session((storage) => {
    value = JSON.parse(storage.getItem(`${DISMISS_KEY}:${accountId}`) ?? "{}");
  });
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, at]) => typeof at === "number")) as Record<string, number>;
};

const writeDismissed = (accountId: string, dismissed: Record<string, number>) =>
  session((storage) => storage.setItem(`${DISMISS_KEY}:${accountId}`, JSON.stringify(dismissed)));

export const useServices = create<ServicesState>((set, get) => ({
  accountId: null,
  statuses: null,
  used: {},
  dismissed: {},
  loading: false,
  error: false,

  start: (accountId) => {
    if (get().accountId === accountId) return;
    generation++;
    inflight = null;
    lastCheck = 0;
    set({ accountId, statuses: null, used: {}, dismissed: readDismissed(accountId), loading: true, error: false });
    void get().refresh();
  },

  refresh: async (force = false) => {
    const accountId = get().accountId;
    if (!accountId) return;
    if (inflight?.accountId === accountId) return inflight.promise;
    // The server's own answer lives for 15 s; asking more often only adds requests.
    if (!force && get().statuses && Date.now() - lastCheck < CHECK_COOLDOWN_MS) return;
    const request = generation;
    const promise: Promise<void> = api<unknown>(`/services${force ? "?refresh=1" : ""}`)
      .then((payload) => {
        if (request !== generation || get().accountId !== accountId) return;
        const statuses = parseServices(payload);
        lastCheck = Date.now();
        set((state) => ({ statuses, dismissed: pruneDismissed(state, statuses), loading: false, error: false }));
      })
      .catch(() => {
        if (request !== generation || get().accountId !== accountId) return;
        // A failed health request is not evidence that a service is down.
        set({ loading: false, error: true });
      })
      .finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
    inflight = { accountId, promise };
    return promise;
  },

  markUsed: (id) => set((state) => ({ used: { ...state.used, [id]: Date.now() } })),

  dismiss: (ids) => {
    const { accountId } = get();
    if (!accountId || !ids.length) return;
    const dismissed = { ...get().dismissed };
    for (const id of ids) dismissed[id] = Date.now();
    writeDismissed(accountId, dismissed);
    set({ dismissed });
  },

  reset: () => {
    generation++;
    inflight = null;
    lastCheck = 0;
    set({ accountId: null, statuses: null, used: {}, dismissed: {}, loading: false, error: false });
  },
}));

/** Marks services used by a tool part that just appeared in the running reply. */
export function markUsedServices(ids: readonly ServiceId[]) {
  const markUsed = useServices.getState().markUsed;
  for (const id of ids) markUsed(id);
}

/** Tests and sign-out: forget the session and ignore any answer still in flight. */
export function resetServices() {
  useServices.getState().reset();
}
