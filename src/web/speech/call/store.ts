import { create } from "zustand";
import type { CallAvailability, CallEngine, CallErrorCode } from "@shared/voice";
import { api, takePrefetched } from "@/lib/api";
import { useData } from "@/state/data";
import { callReducer, initialCallState, type CallEvent, type CallState } from "./state";

interface CallStore {
  open: boolean;
  /** The engine picked for the next start; the call switches to `state.engine` once it is ready. */
  preferred: CallEngine;
  call: CallState;
  level: number;
  /** A non-fatal server notice (a cap reached, a missed sentence); cleared by the next turn. */
  notice: CallErrorCode | null;
  availability: CallAvailability | null;
  availabilityError: boolean;
  loadAvailability: () => Promise<CallAvailability | null>;
  openCall: (engine?: CallEngine) => void;
  closeCall: () => void;
  prefer: (engine: CallEngine) => void;
  dispatch: (event: CallEvent) => void;
  setLevel: (level: number) => void;
  setNotice: (notice: CallErrorCode | null) => void;
}

let loading: Promise<CallAvailability | null> | null = null;

export const useCall = create<CallStore>((set, get) => ({
  open: false,
  preferred: "local",
  call: initialCallState(),
  level: 0,
  notice: null,
  availability: null,
  availabilityError: false,
  loadAvailability: () =>
    (loading ??= (takePrefetched<CallAvailability>("/voice") ?? api<CallAvailability>("/voice"))
      .then((availability) => {
        set({ availability, availabilityError: false, preferred: availability.local ? get().preferred : "realtime" });
        return availability;
      })
      .catch(() => {
        set({ availabilityError: true });
        return null;
      })
      .finally(() => {
        loading = null;
      })),
  openCall: (engine) => {
    // The dialog is already up (a call may be running); never reset it from a second click or command.
    if (get().open) return;
    // The account's saved engine wins for a fresh call; a per-call pick survives while the dialog is open.
    const chosen = engine ?? useData.getState().settings?.speech?.call?.engine ?? get().preferred;
    const call = initialCallState(chosen);
    set({ open: true, preferred: call.engine, call, notice: null, level: 0 });
  },
  closeCall: () => set({ open: false, level: 0, notice: null }),
  prefer: (engine) => set({ preferred: engine }),
  dispatch: (event) => {
    const next = callReducer(get().call, event);
    // A new turn clears a stale notice; a clear-to-listening does too.
    const cleared = event.type === "turn" || event.type === "ready";
    set({ call: next, ...(cleared ? { notice: null } : {}) });
  },
  setLevel: (level) => set({ level }),
  setNotice: (notice) => set({ notice }),
}));
