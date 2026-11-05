import { create } from "zustand";
import type { SavedPrompt, SavedPromptWrite } from "@shared/saved-prompts";
import { api } from "@/lib/api";
import { compareText } from "@/i18n/format";

// The account's saved prompts, in memory only. Loaded on first use of the picker or slash menu, never at startup.
// An account generation revokes late answers for a previous account; a mutation epoch keeps a GET that started
// before an acknowledged write from bringing back the old list.

interface SavedPromptsState {
  prompts: SavedPrompt[];
  loaded: boolean;
  loading: boolean;
  error: boolean;
}

const initial: SavedPromptsState = { prompts: [], loaded: false, loading: false, error: false };

export const useSavedPrompts = create<SavedPromptsState>(() => initial);

let account: string | null = null;
let generation = 0;
let mutations = 0;
let inflight: Promise<void> | null = null;

const idOrder = (a: SavedPrompt, b: SavedPrompt) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byName = (a: SavedPrompt, b: SavedPrompt) => compareText(a.name, b.name) || idOrder(a, b);

/** Called when the signed-in account is known or changes (null on sign-out). */
export function setSavedPromptsAccount(userId: string | null) {
  if (account === userId) return;
  account = userId;
  generation++;
  inflight = null;
  useSavedPrompts.setState(initial, true);
}

/** Shares a request in flight. `force` refetches only once the previous request has settled. */
export function loadSavedPrompts(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && useSavedPrompts.getState().loaded) return Promise.resolve();
  const started = generation;
  const epoch = mutations;
  useSavedPrompts.setState({ loading: true, error: false });
  const request: Promise<void> = api<{ prompts: SavedPrompt[] }>("/saved-prompts")
    .then(
      ({ prompts }) => {
        if (started !== generation) return;
        // A write acknowledged meanwhile is newer than this answer; its result is already in the list.
        if (epoch !== mutations) {
          useSavedPrompts.setState({ loading: false });
          return;
        }
        useSavedPrompts.setState({ prompts: [...prompts].sort(byName), loaded: true, loading: false, error: false });
      },
      () => {
        if (started === generation) useSavedPrompts.setState({ loading: false, error: true });
      },
    )
    .finally(() => {
      if (inflight === request) inflight = null;
    });
  inflight = request;
  return request;
}

function acknowledge(started: number, apply: (prompts: SavedPrompt[]) => SavedPrompt[]) {
  if (started !== generation) return;
  mutations++;
  useSavedPrompts.setState((s) => ({ prompts: apply(s.prompts).sort(byName) }));
}

/** Resolves with the stored prompt; rejects with the ApiError so the form can keep its content. */
export async function createSavedPrompt(write: SavedPromptWrite): Promise<SavedPrompt> {
  const started = generation;
  const prompt = await api<SavedPrompt>("/saved-prompts", { method: "POST", json: write });
  acknowledge(started, (prompts) => [...prompts.filter((p) => p.id !== prompt.id), prompt]);
  return prompt;
}

export async function updateSavedPrompt(id: string, write: SavedPromptWrite, revision: number): Promise<SavedPrompt> {
  const started = generation;
  const prompt = await api<SavedPrompt>(`/saved-prompts/${encodeURIComponent(id)}`, { method: "PUT", json: { ...write, revision } });
  acknowledge(started, (prompts) => [...prompts.filter((p) => p.id !== id), prompt]);
  return prompt;
}

export async function deleteSavedPrompt(id: string, revision: number): Promise<void> {
  const started = generation;
  await api(`/saved-prompts/${encodeURIComponent(id)}`, { method: "DELETE", json: { revision } });
  acknowledge(started, (prompts) => prompts.filter((p) => p.id !== id));
}
