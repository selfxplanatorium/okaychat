import { AssistantChatTransport, createResumableSessionStorage, RESUMABLE_STREAM_ID_HEADER, useChatRuntime } from "@assistant-ui/ai-sdk";
import {
  AssistantRuntimeProvider,
  AuiConfig,
  Tools,
  CompositeAttachmentAdapter,
  useAui,
  useRemoteThreadListRuntime,
  type RemoteThreadListAdapter,
  type ThreadHistoryAdapter,
} from "@assistant-ui/react";
import { generateId, lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { createAssistantStream } from "assistant-stream";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { resolveReasoningEffort } from "@shared/reasoning";
import { applyImagePartUpdates, type ImagePartUpdate } from "@shared/media";
import type { MessageEditResult, ThreadSummary } from "@shared/types";
import { t } from "@/i18n";
import { api, structuredResponseError, takePrefetched } from "@/lib/api";
import { toolkit, widgetHelperRenders } from "@/components/chat/tool-ui";
import { WidgetInstructions, widgets } from "@/components/genui/toolkit";
import { chatIdFromPath, getActiveModel, selectedThreadKey, threadsPath, useData } from "@/state/data";
import { loadThreadDetail, useChatModel } from "@/state/thread-meta";
import { StoredImageAttachmentAdapter, AudioAttachmentAdapter, DocumentAttachmentAdapter, CodeAttachmentAdapter, BinaryAttachmentAdapter } from "./attachments";
import { chatPrivacyFor, isTemporaryChat, useChatPrivacy, useChatPrivacyStore } from "@/state/chat-privacy";
import { useVoiceAdapters } from "@/speech/adapters";
import { chatSearchFor, useChatSearch } from "@/state/chat-search";
import { chatResearchFor } from "@/state/chat-research";
import { useChatWebStore } from "@/state/chat-web-mode";
import { persistKnowledgeAttachments, useChatKnowledgeStore } from "@/state/chat-knowledge";
import { dropThread, readThread, sameRows, ServerRows, writeThread } from "./threadCache";
import { editedAtOf, rememberEdits } from "@/state/message-edits";
import { forgetStoredThread, reportStoredMessage, reportStoredRows } from "./message-persistence";
import { setThreadSync, useThreadSyncStore } from "@/state/thread-sync";
import { applyRetryNotice, clearRetryNotice, retryChunkData, retryOwnerId } from "@/state/retry-status";

/** Thread metadata the sidebar reads from `threadListItem.custom`. */
export type ThreadCustom = { pinned: boolean; projectId: string | null; branchedFrom: ThreadSummary["branchedFrom"] };
const threadCustom = (t: ThreadSummary): ThreadCustom => ({ pinned: t.pinned, projectId: t.projectId, branchedFrom: t.branchedFrom });

type MessageRow = { id: string; parent_id: string | null; format: string; content: unknown; edited_at?: number };

// Ids the server returned per chat. assistant-ui persists every settled message it did not load itself, so after a
// swap it would POST the server's own rows back (and drop the cache entry each time); append skips those ids.
const serverIds = new Map<string, Set<string>>();
// Chats whose server rows arrived and whose swap has not run yet.
const swapping = new Set<string>();
// Message writes in flight per chat, so a swap deferred past a run can wait for the run's reply to be stored.
const writes = new Map<string, Promise<unknown>>();
// The server's rows per chat as far as this page knows, so acknowledged writes refresh the cache entry.
const serverRows = new ServerRows<MessageRow>();

type Aui = ReturnType<typeof useAui>;

// Waits for a thread state on the open chat only: a chat in the background re-applies its loaded history when it
// is opened again, which would undo an import made while it was away.
function whenThread(aui: Aui, ready: (s: ReturnType<Aui["thread"]["getState"]>) => boolean, then: () => void) {
  const met = () => aui.threads.getState().mainThreadId === aui.threadListItem.getState().id && ready(aui.thread.getState());
  if (met()) return then();
  const unsubscribe = aui.subscribe(() => {
    if (!met()) return;
    unsubscribe();
    then();
  });
}

const whenLoaded = (aui: Aui, then: () => void) => whenThread(aui, (s) => !s.isLoading, then);
const whenIdle = (aui: Aui, then: () => void) => whenThread(aui, (s) => !s.isRunning, then);

/**
 * Applies a live retry notice to the chat this runtime owns. `aui` is scoped to the runtime's own
 * `threadListItem`, so a run finishing in a background chat never writes or clears the notice of the
 * chat on screen. A new chat has no remote id until `initialize()` resolves; wait for it then.
 */
function onOwningThread(aui: Aui, apply: (threadId: string) => void) {
  const threadId = retryOwnerId(aui.threadListItem.getState());
  if (threadId) {
    apply(threadId);
    return;
  }
  const unsubscribe = aui.subscribe(() => {
    const remoteId = retryOwnerId(aui.threadListItem.getState());
    if (!remoteId) return;
    unsubscribe();
    apply(remoteId);
  });
}

function tracked<T>(remoteId: string, write: Promise<T>): Promise<T> {
  const settled = write.catch(() => {});
  writes.set(remoteId, Promise.all([writes.get(remoteId), settled]));
  return write;
}

/** Applies a cache decision from `serverRows`: store the rows, drop the entry, or leave it. */
function cacheRows(remoteId: string, rows: MessageRow[] | null | undefined, activeAt: number | undefined) {
  if (rows === null) void dropThread(remoteId);
  else if (rows) void writeThread(remoteId, rows, activeAt);
}

/** Stores one message. Only a write the server acknowledged reaches the cache. */
async function saveRow(remoteId: string, row: MessageRow): Promise<void> {
  // Normalization can replace inline images; only the server's canonical row belongs in the cache.
  const body = JSON.stringify(row);
  serverRows.beginWrite(remoteId);
  let stored: MessageRow;
  try {
    const result = await tracked(remoteId, api<{ images: ImagePartUpdate[] }>(`/threads/${remoteId}/messages`, { method: "POST", body, headers: { "Content-Type": "application/json" } }));
    stored = JSON.parse(body) as MessageRow;
    stored.content = applyImagePartUpdates(stored.content, result.images ?? []);
  } catch (error) {
    cacheRows(remoteId, serverRows.failed(remoteId), undefined);
    throw error;
  }
  // The body of a re-sent message never carries `edited_at`; the server keeps the row's edit, so the cache must too.
  reportStoredMessage(remoteId, stored.id);
  const editedAt = editedAtOf(remoteId, stored.id);
  cacheRows(remoteId, serverRows.acknowledged(remoteId, editedAt === undefined ? stored : { ...stored, edited_at: editedAt }), Date.now());
}

/**
 * The edit routes are message writes like any other: tracked while in flight so a concurrent GET is not trusted,
 * then acknowledged into `serverRows` so the IndexedDB copy carries the new text and `edited_at`.
 */
async function saveEdit(remoteId: string, path: string, method: "PATCH" | "DELETE", json?: unknown): Promise<MessageEditResult> {
  serverRows.beginWrite(remoteId);
  try {
    const result = await tracked(remoteId, api<MessageEditResult>(path, { method, ...(json === undefined ? {} : { json }) }));
    const row: MessageRow = {
      id: result.message.id,
      parent_id: result.message.parent_id,
      format: result.message.format,
      content: result.message.content,
      ...(result.editedAt === null ? {} : { edited_at: result.editedAt }),
    };
    serverIds.get(remoteId)?.add(row.id);
    reportStoredMessage(remoteId, row.id);
    cacheRows(remoteId, serverRows.acknowledged(remoteId, row), Date.now());
    return result;
  } catch (error) {
    cacheRows(remoteId, serverRows.failed(remoteId), undefined);
    throw error;
  }
}

/** Saves the user's text for one assistant reply. The server replaces only text parts and keeps everything else. */
export const editStoredMessage = (remoteId: string, messageId: string, input: { text?: string; parts?: Array<{ type: "text"; text: string }> }) =>
  saveEdit(remoteId, `/threads/${remoteId}/messages/${encodeURIComponent(messageId)}`, "PATCH", input);

/** Restores the reply's first original text. Works even after the account setting was turned off. */
export const undoStoredMessage = (remoteId: string, messageId: string) =>
  saveEdit(remoteId, `/threads/${remoteId}/messages/${encodeURIComponent(messageId)}/edit`, "DELETE");

const threadListAdapter: RemoteThreadListAdapter = {
  async list() {
    const path = threadsPath(useData.getState().activeProject);
    const threads = await (takePrefetched<ThreadSummary[]>(path) ?? api<ThreadSummary[]>(path));
    useData.getState().rememberThreadModels(Object.fromEntries(threads.flatMap((t) => (t.modelRef ? [[t.id, t.modelRef]] : []))));
    useChatKnowledgeStore.getState().hydrateMany(threads);
    return {
      threads: threads.map((t) => ({
        remoteId: t.id,
        status: t.status,
        title: t.title ?? undefined,
        lastMessageAt: new Date(t.updatedAt),
        custom: threadCustom(t),
      })),
    };
  },
  async initialize(localId) {
    // The new chat's composer choice becomes the thread's own, so later new-chat choices cannot change it.
    // Read it now: the first request already captured it, and another new chat may pick a different
    // model while the thread POST below is in flight.
    const chosen = getActiveModel()?.ref;
    const bindModel = (remoteId: string) => {
      const ref = chosen;
      if (ref) useData.setState((s) => ({ threadModels: { ...s.threadModels, [remoteId]: ref } }));
    };
    if (chatPrivacyFor({ id: localId }).temporary) {
      const remoteId = `tmp_${generateId()}`;
      useChatPrivacyStore.getState().bind(localId, remoteId);
      useChatWebStore.getState().bind(localId, remoteId);
      bindModel(remoteId);
      return { remoteId, externalId: undefined };
    }
    const thread = await api<ThreadSummary>("/threads", { method: "POST", json: { projectId: useData.getState().activeProject } });
    serverRows.created(thread.id);
    useChatWebStore.getState().bind(localId, thread.id);
    const knowledgeIds = useChatKnowledgeStore.getState().byId[localId];
    // Persist a choice made on the optimistic chat before the first message is sent, and only then mirror
    // it into the stored chat. A failed PATCH clears the remote entry, so the selector never claims an
    // attachment the next request does not have; the error reaches the thread-initialisation path.
    if (knowledgeIds?.length) await persistKnowledgeAttachments(thread.id, knowledgeIds);
    useChatKnowledgeStore.getState().bind(localId, thread.id);
    bindModel(thread.id);
    return { remoteId: thread.id, externalId: undefined };
  },
  async rename(remoteId, title) {
    if (isTemporaryChat(remoteId)) return;
    await api(`/threads/${remoteId}`, { method: "PATCH", json: { title } });
  },
  async updateCustom(remoteId, custom) {
    if (isTemporaryChat(remoteId)) return;
    const { pinned, projectId } = (custom ?? {}) as Partial<ThreadCustom>;
    // Undefined fields drop out of the JSON body, so an unknown project is left alone.
    await api(`/threads/${remoteId}`, { method: "PATCH", json: { pinned, projectId } });
  },
  async archive(remoteId) {
    if (isTemporaryChat(remoteId)) return;
    await api(`/threads/${remoteId}`, { method: "PATCH", json: { status: "archived" } });
  },
  async unarchive(remoteId) {
    if (isTemporaryChat(remoteId)) return;
    await api(`/threads/${remoteId}`, { method: "PATCH", json: { status: "regular" } });
  },
  async delete(remoteId) {
    if (isTemporaryChat(remoteId)) return;
    await api(`/threads/${remoteId}`, { method: "DELETE" });
    forgetStoredThread(remoteId);
  },
  async fetch(remoteId) {
    if (isTemporaryChat(remoteId)) return { remoteId, status: "regular", title: t("composer.temporaryChat") };
    // Shares the request with the open chat's metadata refresh, which asks for the same response.
    const thread = await loadThreadDetail(remoteId, { reuse: true });
    if (thread.modelRef) useData.getState().rememberThreadModels({ [thread.id]: thread.modelRef });
    useChatKnowledgeStore.getState().hydrate(thread.id, thread.knowledgeIds);
    return { remoteId: thread.id, status: thread.status, title: thread.title ?? undefined, lastMessageAt: new Date(thread.updatedAt), custom: threadCustom(thread) };
  },
  async generateTitle(remoteId, messages) {
    if (isTemporaryChat(remoteId)) return createAssistantStream(async (controller) => { controller.appendText(t("composer.temporaryChat")); });
    const text = messages
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content)
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n")
      .slice(0, 4000);
    const modelRef = getActiveModel(remoteId)?.ref;
    return createAssistantStream(async (controller) => {
      const { title } = await api<{ title: string }>(`/threads/${remoteId}/title`, { method: "POST", json: { text, modelRef } });
      controller.appendText(title);
    });
  },
  unstable_useAdapters: function useThreadAdapters() {
    const aui = useAui();
    const history = useMemo<ThreadHistoryAdapter>(
      () => ({
        async load() {
          return { messages: [] };
        },
        async append() {},
        withFormat: (fmt) => ({
          async load() {
            const { remoteId } = aui.threadListItem.getState();
            if (!remoteId || isTemporaryChat(remoteId)) return { messages: [] };
            const decode = (rows: MessageRow[]) => ({ messages: rows.map((row) => fmt.decode(row as Parameters<typeof fmt.decode>[0])) });
            const path = `/threads/${remoteId}/messages`;
            const fetchRows = (request: () => Promise<MessageRow[]>) => {
              const token = serverRows.beginLoad(remoteId);
              return request().then((rows) => {
                serverIds.set(remoteId, new Set(rows.map((row) => row.id)));
                reportStoredRows(remoteId, rows.map((row) => row.id));
                rememberEdits(remoteId, rows);
                cacheRows(remoteId, serverRows.loaded(remoteId, token, rows), aui.threadListItem.getState().lastMessageAt?.getTime());
                return rows;
              });
            };
            const prefetched = takePrefetched<MessageRow[]>(path);
            const network = fetchRows(() => prefetched ?? api<MessageRow[]>(path));
            // Rows that are already here (a prefetch during startup) win over the cache: no swap, no read-only wait.
            const cached = await Promise.race([
              readThread<MessageRow>(remoteId),
              network.then(() => undefined, () => readThread<MessageRow>(remoteId)),
            ]);
            if (!cached) return decode(await network);
            // The cached rows carry the last acknowledged edit state, so the badge paints with the text.
            rememberEdits(remoteId, cached);
            setThreadSync(remoteId, "pending");
            const shownIds = () => aui.thread.getState().messages.map((m) => m.id);
            // A resumed stream owns the messages, and the rows fetched at load lack its reply. Once it ends and the
            // reply is stored, fetch again and swap only if the server has everything on screen.
            const afterRun = () =>
              whenIdle(aui, () => {
                if (aui.threadListItem.getState().remoteId !== remoteId) return setThreadSync(remoteId, null);
                void new Promise((resolve) => setTimeout(resolve))
                  .then(() => writes.get(remoteId))
                  .then(() => fetchRows(() => api<MessageRow[]>(path)))
                  .then(
                    (rows) => {
                      if (aui.threadListItem.getState().remoteId !== remoteId) return setThreadSync(remoteId, null);
                      if (aui.thread.getState().isRunning) return afterRun();
                      const shown = shownIds();
                      const ids = serverIds.get(remoteId);
                      // A message on screen that the server lacks (its write failed) must not become a parent.
                      const complete = shown.every((id) => ids?.has(id));
                      // Same ids can still carry newer content (an edit made in another tab while this one showed
                      // cached rows), so complete server rows always replace what is on screen.
                      if (complete) aui.thread.importExternalState(decode(rows));
                      setThreadSync(remoteId, complete ? null : "stale");
                    },
                    () => setThreadSync(remoteId, "stale"),
                  );
              });
            network.then(
              (rows) => {
                if (swapping.has(remoteId)) return;
                swapping.add(remoteId);
                // The import must land after assistant-ui has applied the cached rows, or they overwrite it.
                whenLoaded(aui, () => {
                  swapping.delete(remoteId);
                  if (aui.threadListItem.getState().remoteId !== remoteId) return setThreadSync(remoteId, null);
                  if (aui.thread.getState().isRunning) return afterRun();
                  if (!sameRows(cached, rows)) aui.thread.importExternalState(decode(rows));
                  setThreadSync(remoteId, null);
                });
              },
              () => setThreadSync(remoteId, "stale"),
            );
            return decode(cached);
          },
          async append(item) {
            const { remoteId } = await aui.threadListItem.initialize();
            if (isTemporaryChat(remoteId) || serverIds.get(remoteId)?.has(fmt.getId(item.message))) return;
            await saveRow(remoteId, { id: fmt.getId(item.message), parent_id: item.parentId, format: fmt.format, content: fmt.encode(item) });
          },
          async update(item, localMessageId) {
            const { remoteId } = await aui.threadListItem.initialize();
            if (isTemporaryChat(remoteId)) return;
            // The UI blocks edits until the server's rows are on screen; this catches any caller that slips past.
            // Throwing leaves the message unpersisted in assistant-ui, so it is written again on the next settle.
            if (useThreadSyncStore.getState().byId[remoteId]) throw new Error(t("composer.notSynced"));
            await saveRow(remoteId, { id: localMessageId, parent_id: item.parentId, format: fmt.format, content: fmt.encode(item) });
          },
        }),
      }),
      [aui],
    );
    const threadAttachments = useMemo(() => new CompositeAttachmentAdapter([
      new StoredImageAttachmentAdapter(() => chatPrivacyFor(aui.threadListItem.getState()).temporary),
      new DocumentAttachmentAdapter(() => chatPrivacyFor(aui.threadListItem.getState()).temporary),
      new CodeAttachmentAdapter(() => chatPrivacyFor(aui.threadListItem.getState()).temporary),
      new AudioAttachmentAdapter(() => chatPrivacyFor(aui.threadListItem.getState()).temporary),
      new BinaryAttachmentAdapter(() => chatPrivacyFor(aui.threadListItem.getState()).temporary),
    ]), [aui]);
    return useMemo(() => ({ history, attachments: threadAttachments }), [history, threadAttachments]);
  },
};

/** Sends the composer's model and reasoning effort with every request as model context `config`. */
function ModelContextBridge() {
  const aui = useAui();
  const model = useChatModel();
  const privacy = useChatPrivacy();
  const effort = useData((s) => (model ? resolveReasoningEffort(model, s.settings) : undefined));
  const webSearch = useChatSearch().enabled;
  useEffect(
    () =>
      aui.modelContext.register({
        getModelContext: () => {
          // Retry can select a model and start its run before React installs the next registration.
          const item = aui.threadListItem.getState();
          const active = getActiveModel(item.remoteId);
          const ref = active?.ref;
          return { config: { modelName: ref, reasoningEffort: active ? resolveReasoningEffort(active, useData.getState().settings) : undefined, webSearch: chatSearchFor(item), deepResearch: chatResearchFor(item), temporaryPersonalization: chatPrivacyFor(item).personalized } };
        },
      }),
    [aui, model?.ref, effort, webSearch, privacy.personalized, privacy.temporary],
  );
  return null;
}

// The server keeps generating when the request drops, so a reload can reattach. Stop must therefore cancel
// explicitly; a page unload must not.
let unloading = false;
addEventListener("pagehide", () => (unloading = true));
addEventListener("pageshow", () => (unloading = false));

const cancellableFetch = (onCancel: () => void): typeof fetch => async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  // A resume names its stream in the URL, so a Stop before the headers can still reach it.
  let streamId: string | undefined = url.match(/\/api\/chat\/resume\/([\w-]+)/)?.[1];
  const outer = init?.signal;
  const sendCancel = () => {
    if (streamId) void fetch(`/api/chat/${streamId}/cancel`, { method: "POST", credentials: "same-origin", keepalive: true }).catch(() => {});
  };
  // The request itself is aborted only once its stream id is known. Aborting a send before its headers
  // arrive would lose the id, and the server keeps generating a stored turn when its request drops.
  const inner = new AbortController();
  const cancel = () => {
    if (unloading) return;
    // Clear the live retry notice at once, even while the provider is still deciding.
    onCancel();
    if (streamId) {
      sendCancel();
      inner.abort(outer?.reason);
    }
  };
  if (outer?.aborted) cancel();
  else outer?.addEventListener("abort", cancel, { once: true });
  const res = await fetch(input, { ...init, signal: inner.signal });
  streamId = res.headers.get(RESUMABLE_STREAM_ID_HEADER) ?? streamId;
  if (outer?.aborted && !inner.signal.aborted) {
    if (!unloading) sendCancel();
    inner.abort(outer.reason);
    void res.body?.cancel().catch(() => {});
    throw outer.reason instanceof Error ? outer.reason : new DOMException("Aborted", "AbortError");
  }
  // A send that never opened the stream still carries the wire JSON; keep it for the error block.
  const failure = await structuredResponseError(res);
  if (failure) throw new Error(failure);
  return res;
};

/** One transport per thread, with its own resumable stream slot so streams never resume in the wrong thread. */
function useThreadTransport() {
  const aui = useAui();
  return useMemo(() => {
    const storage = createResumableSessionStorage({
      key: () => {
        const remoteId = aui.threadListItem.getState().remoteId;
        return remoteId && !isTemporaryChat(remoteId) ? `okaychat:stream:${remoteId}` : undefined;
      },
    });
    return new AssistantChatTransport({
      api: "/api/chat",
      credentials: "same-origin",
      // Stop also drops this chat's live retry notice; the runtime is scoped to the chat that owns it.
      fetch: cancellableFetch(() => {
        storage.clear();
        clearRetryNotice(retryOwnerId(aui.threadListItem.getState()));
      }),
      resumable: { storage, resumeApi: (streamId) => `/api/chat/resume/${streamId}` },
    });
  }, [aui]);
}

export function RuntimeProvider({ children }: { children: ReactNode }) {
  // Keep selection per tab and account. A reload must mount the saved thread before automatic resume runs.
  const userId = useData((s) => s.me?.id);
  const selectionKey = selectedThreadKey(userId);
  const [initialThreadId] = useState(() => {
    // A chat URL wins over this tab's saved selection.
    const fromPath = chatIdFromPath(location.pathname);
    if (fromPath && !isTemporaryChat(fromPath)) return fromPath;
    // Older "Open in New Tab" links carry the thread as a query parameter, which then leaves the URL.
    const url = new URL(location.href);
    const linked = url.searchParams.get("thread");
    if (linked !== null) {
      url.searchParams.delete("thread");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
      if (linked && !isTemporaryChat(linked)) return linked;
    }
    try {
      const saved = sessionStorage.getItem(selectionKey);
      return saved && !isTemporaryChat(saved) ? saved : undefined;
    } catch {
      return undefined;
    }
  });
  const runtime = useRemoteThreadListRuntime({
    initialThreadId,
    onThreadIdChange: (id) => {
      if (!id) useData.getState().resetModel();
      try {
        if (id && !isTemporaryChat(id)) sessionStorage.setItem(selectionKey, id);
        else sessionStorage.removeItem(selectionKey);
      } catch {
        // Session storage may be disabled.
      }
    },
    runtimeHook: () => {
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const aui = useAui();
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const transport = useThreadTransport();
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const adapters = useVoiceAdapters();
      // eslint-disable-next-line react-hooks/rules-of-hooks
      return useChatRuntime({
        transport,
        adapters,
        // A provider retry is a live wait, not a message part: the server sends transient data-retry chunks.
        onData: (chunk) => {
          const data = retryChunkData(chunk);
          if (data === undefined) return;
          onOwningThread(aui, (threadId) => applyRetryNotice(threadId, data));
        },
        onError: () => clearRetryNotice(retryOwnerId(aui.threadListItem.getState())),
        onFinish: () => {
          clearRetryNotice(retryOwnerId(aui.threadListItem.getState()));
          void useData.getState().refreshStorage().catch(() => {});
        },
        // Browser-executed tools (generative UI) and tool approvals resolve locally; this sends them back to finish the turn.
        sendAutomaticallyWhen: (options) => lastAssistantMessageIsCompleteWithToolCalls(options) || lastAssistantMessageIsCompleteWithApprovalResponses(options),
      });
    },
    adapter: threadListAdapter,
  });
  const config = useMemo(() => {
    const all: Record<string, object> = { ...toolkit, ...widgets.toolkit };
    for (const [name, render] of Object.entries(widgetHelperRenders)) {
      if (all[name]) all[name] = { ...all[name], render };
    }
    return AuiConfig({ tools: Tools({ toolkit: all as typeof widgets.toolkit }) });
  }, []);
  return (
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      <ModelContextBridge />
      <WidgetInstructions />
      {children}
    </AssistantRuntimeProvider>
  );
}
