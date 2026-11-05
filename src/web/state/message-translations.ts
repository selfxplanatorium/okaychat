import { create } from "zustand";
import type { MessageTranslation, MessageTranslationList, TranslateMessageInput } from "@shared/message-translations";
import { currentLocale } from "@/i18n";
import { ApiError, api } from "@/lib/api";
import { useData } from "@/state/data";

// Per-message translations, in memory only and keyed by account. The server owns the text; this store is a
// read cache for the open page, so nothing is written to local storage. A reply can show one language at a
// time, and only a confirmed write activates one.

export const translationKey = (threadId: string, messageId: string) => `${threadId} ${messageId}`;

export interface TranslationEntry extends MessageTranslation {
  stale: boolean;
}

export interface MessageState {
  sourceHash: string | null;
  sourceChars: number;
  entries: Record<string, TranslationEntry>;
  status: "idle" | "loading" | "translating" | "error";
  error: unknown;
  /** Language currently shown under the message; null hides the block. */
  active: string | null;
}

interface TranslationsState {
  messages: Record<string, MessageState>;
}

const EMPTY: MessageState = { sourceHash: null, sourceChars: 0, entries: {}, status: "idle", error: null, active: null };

export const useTranslations = create<TranslationsState>(() => ({ messages: {} }));

let account: string | null = null;
let generation = 0;
const inflight = new Map<string, Promise<void>>();
const controllers = new Map<string, AbortController>();
const epochs = new Map<string, number>();
const loaded = new Set<string>();
/** The language each in-flight or failed request tried, so Retry repeats exactly that one. */
const attempted = new Map<string, string>();

const entry = (key: string) => useTranslations.getState().messages[key] ?? EMPTY;
const bump = (key: string) => epochs.set(key, (epochs.get(key) ?? 0) + 1);
const path = (threadId: string, messageId: string) =>
  `/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/translations`;

/** Called when the signed-in account is known or changes (null on sign-out). */
export function setTranslationsAccount(userId: string | null) {
  if (account === userId) return;
  account = userId;
  generation++;
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  inflight.clear();
  epochs.clear();
  loaded.clear();
  attempted.clear();
  useTranslations.setState({ messages: {} }, true);
}

/** A deleted chat drops its translations on this page; the server removes the rows itself. */
export function dropThreadTranslations(threadId: string) {
  for (const key of [...loaded, ...inflight.keys()]) {
    if (!key.startsWith(`${threadId} `)) continue;
    loaded.delete(key);
    inflight.delete(key);
    attempted.delete(key);
    controllers.get(key)?.abort();
    controllers.delete(key);
  }
  useTranslations.setState((s) => {
    const messages = Object.fromEntries(Object.entries(s.messages).filter(([key]) => !key.startsWith(`${threadId} `)));
    return { messages };
  });
}

/** An edited or restored reply has new text: every cached translation now describes the old one. */
export function invalidateMessageTranslations(threadId: string, messageId: string) {
  const key = translationKey(threadId, messageId);
  if (!useTranslations.getState().messages[key]) return;
  // A request still running translates the old text, so it must not land as current.
  controllers.get(key)?.abort();
  bump(key);
  loaded.delete(key);
  useTranslations.setState((s) => {
    const current = entry(key);
    const entries = Object.fromEntries(Object.entries(current.entries).map(([lang, value]) => [lang, { ...value, stale: true }]));
    return { messages: { ...s.messages, [key]: { ...current, entries, active: null } } };
  });
}

/** Shares a request in flight. `force` refetches after the previous request settled. */
export function loadTranslations(threadId: string, messageId: string, force = false): Promise<void> {
  const key = translationKey(threadId, messageId);
  const running = inflight.get(key);
  if (running) return running;
  if (!force && loaded.has(key)) return Promise.resolve();
  const started = generation;
  const epoch = epochs.get(key) ?? 0;
  useTranslations.setState((s) => ({
    messages: { ...s.messages, [key]: { ...entry(key), status: entry(key).status === "translating" ? "translating" : "loading", error: null } },
  }));
  const request: Promise<void> = api<MessageTranslationList>(path(threadId, messageId))
    .then(
      (data) => {
        // A deleted chat or an acknowledged write that started later wins; never resurrect old state.
        if (started !== generation || epoch !== (epochs.get(key) ?? 0)) return;
        loaded.add(key);
        useTranslations.setState((s) => {
          const current = s.messages[key] ?? EMPTY;
          const entries: Record<string, TranslationEntry> = {};
          for (const translation of data.translations) entries[translation.lang] = translation;
          const shown = current.active ? entries[current.active] : undefined;
          const active = current.active && shown && !shown.stale ? current.active : null;
          return {
            messages: {
              ...s.messages,
              [key]: {
                ...current,
                sourceHash: data.sourceHash,
                sourceChars: data.sourceChars,
                entries,
                active,
                status: current.status === "translating" ? "translating" : "idle",
                error: null,
              },
            },
          };
        });
      },
      () => {
        // A list failure is not an error under the message: the dialog simply shows nothing until reopened.
        if (started !== generation) return;
        useTranslations.setState((s) => ({
          messages: { ...s.messages, [key]: { ...entry(key), status: entry(key).status === "translating" ? "translating" : "idle" } },
        }));
      },
    )
    .finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

const aborted = (error: unknown) => error instanceof ApiError && error.code === "aborted";

/** One request per message: a second Translate aborts the first, whose signal stops its provider call. */
export async function translateMessage(
  threadId: string,
  messageId: string,
  lang: string,
  options: { refresh?: boolean } = {},
): Promise<void> {
  const key = translationKey(threadId, messageId);
  controllers.get(key)?.abort();
  const controller = new AbortController();
  attempted.set(key, lang);
  controllers.set(key, controller);
  const started = generation;
  useTranslations.setState((s) => ({
    messages: { ...s.messages, [key]: { ...entry(key), status: "translating", error: null } },
  }));
  try {
    const input: TranslateMessageInput = options.refresh ? { refresh: true } : {};
    const translation = await api<MessageTranslation>(`${path(threadId, messageId)}/${encodeURIComponent(lang)}`, {
      method: "PUT",
      json: input,
      signal: controller.signal,
    });
    if (started !== generation) return;
    bump(key);
    loaded.add(key);
    useTranslations.setState((s) => ({
      messages: {
        ...s.messages,
        [key]: {
          ...entry(key),
          entries: { ...entry(key).entries, [translation.lang]: { ...translation, stale: false } },
          active: translation.lang,
          status: "idle",
          error: null,
        },
      },
    }));
  } catch (error) {
    if (started !== generation) return;
    // A cancel is not a failure: the block returns to idle and nothing is cached.
    if (aborted(error)) {
      useTranslations.setState((s) => ({ messages: { ...s.messages, [key]: { ...entry(key), status: "idle" } } }));
      return;
    }
    useTranslations.setState((s) => ({ messages: { ...s.messages, [key]: { ...entry(key), status: "error", error } } }));
  } finally {
    if (controllers.get(key) === controller) controllers.delete(key);
  }
}

/** The language of this message's last translate attempt, for an error Retry. */
export const lastTranslationLang = (threadId: string, messageId: string): string | null =>
  attempted.get(translationKey(threadId, messageId)) ?? null;

export function cancelTranslation(threadId: string, messageId: string): void {
  const key = translationKey(threadId, messageId);
  controllers.get(key)?.abort();
  controllers.delete(key);
  useTranslations.setState((s) => ({ messages: { ...s.messages, [key]: { ...entry(key), status: "idle" } } }));
}

export function removeTranslation(threadId: string, messageId: string, lang: string): Promise<void> {
  const key = translationKey(threadId, messageId);
  return api(`${path(threadId, messageId)}/${encodeURIComponent(lang)}`, { method: "DELETE" }).then(() => {
    bump(key);
    useTranslations.setState((s) => {
      const current = entry(key);
      const { [lang]: _removed, ...entries } = current.entries;
      return { messages: { ...s.messages, [key]: { ...current, entries, active: current.active === lang ? null : current.active } } };
    });
  });
}

/** Hides the block without deleting the stored translation. */
export function hideTranslation(threadId: string, messageId: string): void {
  const key = translationKey(threadId, messageId);
  useTranslations.setState((s) => ({ messages: { ...s.messages, [key]: { ...entry(key), active: null } } }));
}

/** The account's chosen target, falling back to the UI language. */
export function preferredTranslationTarget(): string {
  return useData.getState().settings?.translationTarget ?? currentLocale();
}

export const useMessageTranslations = (threadId: string | null | undefined, messageId: string | null | undefined): MessageState =>
  useTranslations((s) => (threadId && messageId ? s.messages[translationKey(threadId, messageId)] : undefined)) ?? EMPTY;
