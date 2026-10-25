import { AssistantChatTransport, createResumableSessionStorage, RESUMABLE_STREAM_ID_HEADER, useChatRuntime } from "@assistant-ui/ai-sdk";
import {
  AssistantRuntimeProvider,
  AuiConfig,
  Tools,
  CompositeAttachmentAdapter,
  useAui,
  useRemoteThreadListRuntime,
  WebSpeechDictationAdapter,
  WebSpeechSynthesisAdapter,
  type RemoteThreadListAdapter,
  type ThreadHistoryAdapter,
} from "@assistant-ui/react";
import { generateId, lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { createAssistantStream } from "assistant-stream";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ThreadSummary } from "@shared/types";
import { api, takePrefetched } from "@/lib/api";
import { toolkit, widgetHelperRenders } from "@/components/chat/tool-ui";
import { WidgetInstructions, widgets } from "@/components/genui/toolkit";
import { getActiveModel, selectedThreadKey, threadsPath, useData } from "@/state/data";
import { useChatModel } from "@/state/thread-meta";
import { StoredImageAttachmentAdapter, DocumentAttachmentAdapter, CodeAttachmentAdapter, BinaryAttachmentAdapter } from "./attachments";
import { chatPrivacyFor, isTemporaryChat, useChatPrivacy, useChatPrivacyStore } from "@/state/chat-privacy";
import { chatSearchFor, useChatSearch, useChatSearchStore } from "@/state/chat-search";

/** Reads the answer, not its Markdown: code blocks, link targets, and formatting marks are dropped. */
class SpokenTextAdapter extends WebSpeechSynthesisAdapter {
  override speak(text: string) {
    const plain = text
      .replace(/```[\s\S]*?```/g, " (code omitted) ")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/^#+\s*/gm, "")
      .replace(/[*_`~>|]/g, "")
      .replace(/\$\$?[^$]*\$\$?/g, " (formula) ");
    return super.speak(plain);
  }
}

// Browser speech: no server or keys. Recognition needs a secure context (HTTPS or localhost) and, in Chrome,
// sends audio to Google. Both are left out where the browser lacks them, which hides their buttons.
const voiceAdapters = {
  ...(WebSpeechDictationAdapter.isSupported() && window.isSecureContext ? { dictation: new WebSpeechDictationAdapter({ language: navigator.language }) } : {}),
  ...("speechSynthesis" in window ? { speech: new SpokenTextAdapter() } : {}),
};

/** Thread metadata the sidebar reads from `threadListItem.custom`. */
export type ThreadCustom = { pinned: boolean; projectId: string | null };
const threadCustom = (t: ThreadSummary): ThreadCustom => ({ pinned: t.pinned, projectId: t.projectId });

const threadListAdapter: RemoteThreadListAdapter = {
  async list() {
    const path = threadsPath(useData.getState().activeProject);
    const threads = await (takePrefetched<ThreadSummary[]>(path) ?? api<ThreadSummary[]>(path));
    useData.getState().rememberThreadModels(Object.fromEntries(threads.flatMap((t) => (t.modelRef ? [[t.id, t.modelRef]] : []))));
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
    const bindModel = (remoteId: string) => {
      const ref = getActiveModel()?.ref;
      if (ref) useData.setState((s) => ({ threadModels: { ...s.threadModels, [remoteId]: ref } }));
    };
    if (chatPrivacyFor({ id: localId }).temporary) {
      const remoteId = `tmp_${generateId()}`;
      useChatPrivacyStore.getState().bind(localId, remoteId);
      useChatSearchStore.getState().bind(localId, remoteId);
      bindModel(remoteId);
      return { remoteId, externalId: undefined };
    }
    const thread = await api<ThreadSummary>("/threads", { method: "POST", json: { projectId: useData.getState().activeProject } });
    useChatSearchStore.getState().bind(localId, thread.id);
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
  },
  async fetch(remoteId) {
    if (isTemporaryChat(remoteId)) return { remoteId, status: "regular", title: "Temporary chat" };
    const t = await api<ThreadSummary>(`/threads/${remoteId}`);
    if (t.modelRef) useData.getState().rememberThreadModels({ [t.id]: t.modelRef });
    return { remoteId: t.id, status: t.status, title: t.title ?? undefined, lastMessageAt: new Date(t.updatedAt), custom: threadCustom(t) };
  },
  async generateTitle(remoteId, messages) {
    if (isTemporaryChat(remoteId)) return createAssistantStream(async (controller) => { controller.appendText("Temporary chat"); });
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
            type Row = { id: string; parent_id: string | null; format: string; content: unknown };
            const path = `/threads/${remoteId}/messages`;
            const rows = await (takePrefetched<Row[]>(path) ?? api<Row[]>(path));
            return { messages: rows.map((row) => fmt.decode(row as Parameters<typeof fmt.decode>[0])) };
          },
          async append(item) {
            const { remoteId } = await aui.threadListItem.initialize();
            if (isTemporaryChat(remoteId)) return;
            await api(`/threads/${remoteId}/messages`, {
              method: "POST",
              json: { id: fmt.getId(item.message), parent_id: item.parentId, format: fmt.format, content: fmt.encode(item) },
            });
          },
          async update(item, localMessageId) {
            const { remoteId } = await aui.threadListItem.initialize();
            if (isTemporaryChat(remoteId)) return;
            await api(`/threads/${remoteId}/messages`, {
              method: "POST",
              json: { id: localMessageId, parent_id: item.parentId, format: fmt.format, content: fmt.encode(item) },
            });
          },
        }),
      }),
      [aui],
    );
    const threadAttachments = useMemo(() => new CompositeAttachmentAdapter([
      new StoredImageAttachmentAdapter(() => chatPrivacyFor(aui.threadListItem.getState()).temporary),
      new DocumentAttachmentAdapter(() => chatPrivacyFor(aui.threadListItem.getState()).temporary),
      new CodeAttachmentAdapter(() => chatPrivacyFor(aui.threadListItem.getState()).temporary),
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
  const effort = useData((s) => (model ? s.settings?.reasoningEffort[model.ref] : undefined));
  const webSearch = useChatSearch().enabled;
  useEffect(
    () =>
      aui.modelContext.register({
        getModelContext: () => ({ config: { modelName: getActiveModel(aui.threadListItem.getState().remoteId)?.ref, reasoningEffort: effort, webSearch: chatSearchFor(aui.threadListItem.getState()), temporaryPersonalization: chatPrivacyFor(aui.threadListItem.getState()).personalized } }),
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
  const res = await fetch(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const streamId = res.headers.get(RESUMABLE_STREAM_ID_HEADER) ?? url.match(/\/api\/chat\/resume\/([\w-]+)/)?.[1];
  init?.signal?.addEventListener(
    "abort",
    () => {
      if (streamId && !unloading) {
        onCancel();
        void fetch(`/api/chat/${streamId}/cancel`, { method: "POST", credentials: "same-origin", keepalive: true }).catch(() => {});
      }
    },
    { once: true },
  );
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
      fetch: cancellableFetch(() => storage.clear()),
      resumable: { storage, resumeApi: (streamId) => `/api/chat/resume/${streamId}` },
    });
  }, [aui]);
}

export function RuntimeProvider({ children }: { children: ReactNode }) {
  // Keep selection per tab and account. A reload must mount the saved thread before automatic resume runs.
  const userId = useData((s) => s.me?.id);
  const selectionKey = selectedThreadKey(userId);
  const [initialThreadId] = useState(() => {
    // "Open in New Tab" links carry the thread; it wins over this tab's saved selection once, then leaves the URL.
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
    runtimeHook: () =>
      // eslint-disable-next-line react-hooks/rules-of-hooks
      useChatRuntime({
        // eslint-disable-next-line react-hooks/rules-of-hooks
        transport: useThreadTransport(),
        adapters: { ...voiceAdapters },
        onFinish: () => { void useData.getState().refreshStorage().catch(() => {}); },
        // Browser-executed tools (generative UI) and tool approvals resolve locally; this sends them back to finish the turn.
        sendAutomaticallyWhen: (options) => lastAssistantMessageIsCompleteWithToolCalls(options) || lastAssistantMessageIsCompleteWithApprovalResponses(options),
      }),
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
