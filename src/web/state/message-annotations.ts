import { create } from "zustand";
import type { FeedbackWrite, MessageBookmark, MessageFeedback, ThreadAnnotations } from "@shared/message-annotations";
import { api } from "@/lib/api";

// Private bookmarks and feedback per chat, in memory only and keyed by account. One GET per chat, never one per
// message. Writes apply only the server's confirmed answer: nothing is shown as saved before it is. A GET that
// started before an acknowledged write in the same chat is ignored, so it cannot bring back the old state.

export const annotationKey = (threadId: string, messageId: string) => `${threadId} ${messageId}`;

export interface ThreadAnnotationState {
  bookmarks: Record<string, MessageBookmark>;
  feedback: Record<string, MessageFeedback>;
  loaded: boolean;
  error: boolean;
}

interface AnnotationsState {
  threads: Record<string, ThreadAnnotationState>;
  /** `bookmark <thread> <message>` / `feedback <thread> <message>` while that write is in flight. */
  pending: Record<string, true>;
}

const EMPTY: ThreadAnnotationState = { bookmarks: {}, feedback: {}, loaded: false, error: false };

export const useAnnotations = create<AnnotationsState>(() => ({ threads: {}, pending: {} }));

let account: string | null = null;
let generation = 0;
const inflight = new Map<string, Promise<void>>();
const epochs = new Map<string, number>();

const entry = (threadId: string) => useAnnotations.getState().threads[threadId] ?? EMPTY;
const bump = (threadId: string) => epochs.set(threadId, (epochs.get(threadId) ?? 0) + 1);

/** Called when the signed-in account is known or changes (null on sign-out). */
export function setAnnotationsAccount(userId: string | null) {
  if (account === userId) return;
  account = userId;
  generation++;
  inflight.clear();
  epochs.clear();
  useAnnotations.setState({ threads: {}, pending: {} }, true);
}

/** A deleted chat drops its annotations, so nothing of it outlives the chat on this page. */
export function dropThreadAnnotations(threadId: string) {
  inflight.delete(threadId);
  bump(threadId);
  useAnnotations.setState((s) => {
    const { [threadId]: _dropped, ...threads } = s.threads;
    return { threads };
  });
}

/** Shares a request in flight. `force` refetches only once the previous request has settled. */
export function loadThreadAnnotations(threadId: string, force = false): Promise<void> {
  const running = inflight.get(threadId);
  if (running) return running;
  if (!force && entry(threadId).loaded) return Promise.resolve();
  const started = generation;
  const epoch = epochs.get(threadId) ?? 0;
  const request: Promise<void> = api<ThreadAnnotations>(`/threads/${encodeURIComponent(threadId)}/annotations`)
    .then(
      (data) => {
        if (started !== generation) return;
        if (epoch !== (epochs.get(threadId) ?? 0)) {
          // Older than a confirmed write or a deleted chat. Ask again after this request settles, so a chat that
          // never loaded still gets its data.
          const retryGeneration = generation;
          if (!entry(threadId).loaded) {
            setTimeout(() => {
              if (retryGeneration === generation) void loadThreadAnnotations(threadId);
            });
          }
          return;
        }
        const bookmarks: Record<string, MessageBookmark> = {};
        for (const b of data.bookmarks) bookmarks[b.messageId] = b;
        const feedback: Record<string, MessageFeedback> = {};
        for (const f of data.feedback) feedback[f.messageId] = f;
        useAnnotations.setState((s) => ({ threads: { ...s.threads, [threadId]: { bookmarks, feedback, loaded: true, error: false } } }));
      },
      () => {
        if (started !== generation) return;
        useAnnotations.setState((s) => ({ threads: { ...s.threads, [threadId]: { ...entry(threadId), error: true } } }));
      },
    )
    .finally(() => {
      if (inflight.get(threadId) === request) inflight.delete(threadId);
    });
  inflight.set(threadId, request);
  return request;
}

async function write<T>(kind: "bookmark" | "feedback", threadId: string, messageId: string, send: () => Promise<T>, apply: (current: ThreadAnnotationState, result: T) => ThreadAnnotationState): Promise<T> {
  const started = generation;
  const epoch = epochs.get(threadId) ?? 0;
  const key = `${kind} ${annotationKey(threadId, messageId)}`;
  useAnnotations.setState((s) => ({ pending: { ...s.pending, [key]: true } }));
  try {
    const result = await send();
    // A deleted chat or newer confirmed write invalidates this answer; never resurrect dropped state.
    if (started === generation && epoch === (epochs.get(threadId) ?? 0)) {
      bump(threadId);
      useAnnotations.setState((s) => ({ threads: { ...s.threads, [threadId]: apply(s.threads[threadId] ?? EMPTY, result) } }));
    }
    return result;
  } finally {
    if (started === generation) {
      useAnnotations.setState((s) => {
        const { [key]: _done, ...pending } = s.pending;
        return { pending };
      });
    }
  }
}

const messagePath = (threadId: string, messageId: string) => `/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`;

/** Desired state, never a toggle: a repeated click cannot flip a mark the server already changed. */
export function setBookmark(threadId: string, messageId: string, bookmarked: boolean): Promise<void> {
  const path = `${messagePath(threadId, messageId)}/bookmark`;
  return bookmarked
    ? write("bookmark", threadId, messageId, () => api<MessageBookmark>(path, { method: "PUT", json: {} }), (current, bookmark) => ({
        ...current,
        bookmarks: { ...current.bookmarks, [messageId]: bookmark },
      })).then(() => undefined)
    : write("bookmark", threadId, messageId, () => api(path, { method: "DELETE" }), (current) => {
        const { [messageId]: _removed, ...bookmarks } = current.bookmarks;
        return { ...current, bookmarks };
      }).then(() => undefined);
}

/** Rejects with the ApiError (409 on a stale revision) so the form keeps its draft. */
export function saveFeedback(threadId: string, messageId: string, input: FeedbackWrite): Promise<MessageFeedback> {
  return write("feedback", threadId, messageId, () => api<MessageFeedback>(`${messagePath(threadId, messageId)}/feedback`, { method: "PUT", json: input }), (current, feedback) => ({
    ...current,
    feedback: { ...current.feedback, [messageId]: feedback },
  }));
}

/** Stored feedback revision for a reply; 0 when there is no row. */
export const feedbackRevision = (threadId: string, messageId: string) => entry(threadId).feedback[messageId]?.revision ?? 0;

export const useThreadAnnotations = (threadId: string | undefined) => useAnnotations((s) => (threadId ? s.threads[threadId] : undefined) ?? EMPTY);

export const useBookmark = (threadId: string | undefined, messageId: string) =>
  useAnnotations((s) => (threadId ? s.threads[threadId]?.bookmarks[messageId] : undefined));

export const useFeedback = (threadId: string | undefined, messageId: string) =>
  useAnnotations((s) => (threadId ? s.threads[threadId]?.feedback[messageId] : undefined));

export const useAnnotationPending = (kind: "bookmark" | "feedback", threadId: string | undefined, messageId: string) =>
  useAnnotations((s) => !!threadId && !!s.pending[`${kind} ${annotationKey(threadId, messageId)}`]);

/** Whether any bookmark or feedback write is still in flight in this chat, for the focus refresh rule. */
export const threadAnnotationsBusy = (threadId: string) =>
  Object.keys(useAnnotations.getState().pending).some((key) => key.startsWith(`bookmark ${threadId} `) || key.startsWith(`feedback ${threadId} `));
