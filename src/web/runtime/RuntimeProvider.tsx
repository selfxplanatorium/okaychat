import { AssistantChatTransport, createResumableSessionStorage, RESUMABLE_STREAM_ID_HEADER, useChatRuntime } from "@assistant-ui/ai-sdk";
import {
  AssistantRuntimeProvider,
  AuiConfig,
  Tools,
  CompositeAttachmentAdapter,
  SimpleImageAttachmentAdapter,
  SimpleTextAttachmentAdapter,
  useAui,
  useRemoteThreadListRuntime,
  WebSpeechDictationAdapter,
  WebSpeechSynthesisAdapter,
  type AttachmentAdapter,
  type RemoteThreadListAdapter,
  type ThreadHistoryAdapter,
} from "@assistant-ui/react";
import { generateId, lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { createAssistantStream } from "assistant-stream";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ThreadSummary } from "@shared/types";
import { api } from "@/lib/api";
import { toolkit } from "@/components/chat/tool-ui";
import { WidgetInstructions, widgets } from "@/components/genui/toolkit";
import { useActiveModel, useData } from "@/state/data";
import { chatPrivacyFor, isAnonymousChat, useChatPrivacy, useChatPrivacyStore } from "@/state/chat-privacy";

const CODE_EXTENSIONS =
  ".txt,.md,.mdx,.csv,.tsv,.json,.jsonl,.yaml,.yml,.toml,.xml,.html,.css,.scss,.js,.jsx,.ts,.tsx,.mjs,.cjs,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.hpp,.cs,.php,.sh,.bash,.zsh,.sql,.graphql,.proto,.ini,.env,.log,.r,.lua,.dart,.vue,.svelte,.tex";

/** Native PDFs up to this size. Larger ones are sent as extracted text, so requests and history stay small. */
const NATIVE_PDF_BYTES = 10 * 1024 * 1024;

const readDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/**
 * PDFs go as files: models that read PDFs see the pages, and the server extracts text for the rest.
 * Word files are always converted to text on the server.
 */
class DocumentAttachmentAdapter implements AttachmentAdapter {
  constructor(private readonly temporary: () => boolean = () => false) {}
  accept =
    "application/pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  async add({ file }: { file: File }) {
    return {
      // Not crypto.randomUUID: it only exists in secure contexts, and plain-HTTP origins would fail silently.
      id: generateId(),
      type: "document" as const,
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action" as const, reason: "composer-send" as const },
    };
  }

  async send(attachment: Parameters<AttachmentAdapter["send"]>[0], options?: { signal?: AbortSignal }) {
    const isPdf = attachment.file.type === "application/pdf" || attachment.name.toLowerCase().endsWith(".pdf");
    if (isPdf && attachment.file.size <= NATIVE_PDF_BYTES) {
      // The bytes stay with us too, so the model can import and restructure the PDF later.
      const form = new FormData();
      form.append("file", attachment.file);
      const stored = await api<{ fileId: string | null }>(`/files/store${this.temporary() ? "?temporary=1" : ""}`, {
        method: "POST",
        body: form,
        signal: options?.signal,
      }).catch(() => ({ fileId: null }));
      return {
        ...attachment,
        status: { type: "complete" as const },
        content: [
          { type: "file" as const, data: await readDataUrl(attachment.file), mimeType: "application/pdf", filename: attachment.name },
          ...(stored.fileId ? [{ type: "text" as const, text: `<attachment name="${attachment.name.replaceAll('"', "'")}" file_id="${stored.fileId}"></attachment>` }] : []),
        ],
      };
    }
    const form = new FormData();
    form.append("file", attachment.file);
    const { text, pages, fileId } = await api<{ text: string; pages?: number; fileId?: string }>(this.temporary() ? "/files/extract?temporary=1" : "/files/extract", {
      method: "POST",
      body: form,
      signal: options?.signal,
    });
    // file_id lets the model import the original bytes as an editable document artifact.
    const meta = `${pages ? ` pages="${pages}"` : ""}${fileId ? ` file_id="${fileId}"` : ""}`;
    return {
      ...attachment,
      status: { type: "complete" as const },
      content: [{ type: "text" as const, text: `<attachment name="${attachment.name.replaceAll('"', "'")}"${meta}>\n${text}\n</attachment>` }],
    };
  }

  async remove() {}
}

class CodeAttachmentAdapter extends SimpleTextAttachmentAdapter {
  override accept = `${new SimpleTextAttachmentAdapter().accept},${CODE_EXTENSIONS}`;
  constructor(private readonly temporary: () => boolean = () => false) {
    super();
  }

  override async send(attachment: Parameters<AttachmentAdapter["send"]>[0], options?: { signal?: AbortSignal }) {
    const sent = await super.send(attachment, options);
    if (this.temporary()) return sent;
    // With a code sandbox on the server the bytes are kept, so run_code can copy the file in by file_id.
    const form = new FormData();
    form.append("file", attachment.file);
    const { fileId } = await api<{ fileId: string | null }>("/files/store", { method: "POST", body: form, signal: options?.signal }).catch(() => ({ fileId: null }));
    if (!fileId) return sent;
    return {
      ...sent,
      content: sent.content.map((part) => (part.type === "text" ? { ...part, text: part.text.replace(/^<attachment name="([^"]*)">/, `<attachment name="$1" file_id="${fileId}">`) } : part)),
    };
  }
}

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

const threadListAdapter: RemoteThreadListAdapter = {
  async list() {
    const project = useData.getState().activeProject;
    const threads = await api<ThreadSummary[]>(project ? `/threads?project=${encodeURIComponent(project)}` : "/threads");
    return {
      threads: threads.map((t) => ({
        remoteId: t.id,
        status: t.status,
        title: t.title ?? undefined,
      })),
    };
  },
  async initialize(localId) {
    if (chatPrivacyFor({ id: localId }).temporary) {
      const remoteId = `tmp_${generateId()}`;
      useChatPrivacyStore.getState().bind(localId, remoteId);
      return { remoteId, externalId: undefined };
    }
    const thread = await api<ThreadSummary>("/threads", { method: "POST", json: { projectId: useData.getState().activeProject } });
    return { remoteId: thread.id, externalId: undefined };
  },
  async rename(remoteId, title) {
    if (isAnonymousChat(remoteId)) return;
    await api(`/threads/${remoteId}`, { method: "PATCH", json: { title } });
  },
  async archive(remoteId) {
    if (isAnonymousChat(remoteId)) return;
    await api(`/threads/${remoteId}`, { method: "PATCH", json: { status: "archived" } });
  },
  async unarchive(remoteId) {
    if (isAnonymousChat(remoteId)) return;
    await api(`/threads/${remoteId}`, { method: "PATCH", json: { status: "regular" } });
  },
  async delete(remoteId) {
    if (isAnonymousChat(remoteId)) return;
    await api(`/threads/${remoteId}`, { method: "DELETE" });
  },
  async fetch(remoteId) {
    if (isAnonymousChat(remoteId)) return { remoteId, status: "regular", title: "Anonymous chat" };
    const t = await api<ThreadSummary>(`/threads/${remoteId}`);
    return { remoteId: t.id, status: t.status, title: t.title ?? undefined };
  },
  async generateTitle(remoteId, messages) {
    if (isAnonymousChat(remoteId)) return createAssistantStream(async (controller) => { controller.appendText("Anonymous chat"); });
    const text = messages
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content)
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n")
      .slice(0, 4000);
    const modelRef = useData.getState().selectedModel ?? useData.getState().settings?.defaultModel ?? undefined;
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
            if (!remoteId || isAnonymousChat(remoteId)) return { messages: [] };
            const rows = await api<Array<{ id: string; parent_id: string | null; format: string; content: unknown }>>(
              `/threads/${remoteId}/messages`,
            );
            return { messages: rows.map((row) => fmt.decode(row as Parameters<typeof fmt.decode>[0])) };
          },
          async append(item) {
            const { remoteId } = await aui.threadListItem.initialize();
            if (isAnonymousChat(remoteId)) return;
            await api(`/threads/${remoteId}/messages`, {
              method: "POST",
              json: { id: fmt.getId(item.message), parent_id: item.parentId, format: fmt.format, content: fmt.encode(item) },
            });
          },
          async update(item, localMessageId) {
            const { remoteId } = await aui.threadListItem.initialize();
            if (isAnonymousChat(remoteId)) return;
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
      new SimpleImageAttachmentAdapter(),
      new DocumentAttachmentAdapter(() => chatPrivacyFor(aui.threadListItem.getState()).temporary),
      new CodeAttachmentAdapter(() => chatPrivacyFor(aui.threadListItem.getState()).temporary),
    ]), [aui]);
    return useMemo(() => ({ history, attachments: threadAttachments }), [history, threadAttachments]);
  },
};

/** Sends the composer's model and reasoning effort with every request as model context `config`. */
function ModelContextBridge() {
  const aui = useAui();
  const model = useActiveModel();
  const privacy = useChatPrivacy();
  const effort = useData((s) => (model ? s.settings?.reasoningEffort[model.ref] : undefined));
  useEffect(
    () =>
      aui.modelContext.register({
        getModelContext: () => ({ config: { modelName: model?.ref, reasoningEffort: effort, temporaryPersonalization: chatPrivacyFor(aui.threadListItem.getState()).personalized } }),
      }),
    [aui, model?.ref, effort, privacy.personalized, privacy.temporary],
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
        return remoteId && !isAnonymousChat(remoteId) ? `okaychat:stream:${remoteId}` : undefined;
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
  const selectionKey = `okaychat:thread:${userId}`;
  const [initialThreadId] = useState(() => {
    try {
      const saved = sessionStorage.getItem(selectionKey);
      return saved && !isAnonymousChat(saved) ? saved : undefined;
    } catch {
      return undefined;
    }
  });
  const runtime = useRemoteThreadListRuntime({
    initialThreadId,
    onThreadIdChange: (id) => {
      try {
        if (id && !isAnonymousChat(id)) sessionStorage.setItem(selectionKey, id);
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
        // Browser-executed tools (generative UI) and tool approvals resolve locally; this sends them back to finish the turn.
        sendAutomaticallyWhen: (options) => lastAssistantMessageIsCompleteWithToolCalls(options) || lastAssistantMessageIsCompleteWithApprovalResponses(options),
      }),
    adapter: threadListAdapter,
  });
  const config = useMemo(() => AuiConfig({ tools: Tools({ toolkit: { ...toolkit, ...widgets.toolkit } }) }), []);
  return (
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      <ModelContextBridge />
      <WidgetInstructions />
      {children}
    </AssistantRuntimeProvider>
  );
}
