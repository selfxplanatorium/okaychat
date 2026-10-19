import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/ai-sdk";
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
import { lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { createAssistantStream } from "assistant-stream";
import { useEffect, useMemo, type ReactNode } from "react";
import type { ThreadSummary } from "@shared/types";
import { api } from "@/lib/api";
import { toolkit } from "@/components/chat/tool-ui";
import { WidgetInstructions, widgets } from "@/components/genui/toolkit";
import { useActiveModel, useData } from "@/state/data";

const CODE_EXTENSIONS =
  ".txt,.md,.mdx,.csv,.tsv,.json,.jsonl,.yaml,.yml,.toml,.xml,.html,.css,.scss,.js,.jsx,.ts,.tsx,.mjs,.cjs,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.hpp,.cs,.php,.sh,.bash,.zsh,.sql,.graphql,.proto,.ini,.env,.log,.r,.lua,.dart,.vue,.svelte,.tex";

/** PDFs and Word files are converted to text on the server, so every model can read them. */
class DocumentAttachmentAdapter implements AttachmentAdapter {
  accept = "application/pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  async add({ file }: { file: File }) {
    return {
      id: crypto.randomUUID(),
      type: "document" as const,
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action" as const, reason: "composer-send" as const },
    };
  }

  async send(attachment: Parameters<AttachmentAdapter["send"]>[0], options?: { signal?: AbortSignal }) {
    const form = new FormData();
    form.append("file", attachment.file);
    const { text, pages } = await api<{ text: string; pages?: number }>("/files/extract", {
      method: "POST",
      body: form,
      signal: options?.signal,
    });
    const meta = pages ? ` pages="${pages}"` : "";
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
}

const attachments = new CompositeAttachmentAdapter([
  new SimpleImageAttachmentAdapter(),
  new DocumentAttachmentAdapter(),
  new CodeAttachmentAdapter(),
]);

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
  async initialize() {
    const thread = await api<ThreadSummary>("/threads", { method: "POST", json: { projectId: useData.getState().activeProject } });
    return { remoteId: thread.id, externalId: undefined };
  },
  async rename(remoteId, title) {
    await api(`/threads/${remoteId}`, { method: "PATCH", json: { title } });
  },
  async archive(remoteId) {
    await api(`/threads/${remoteId}`, { method: "PATCH", json: { status: "archived" } });
  },
  async unarchive(remoteId) {
    await api(`/threads/${remoteId}`, { method: "PATCH", json: { status: "regular" } });
  },
  async delete(remoteId) {
    await api(`/threads/${remoteId}`, { method: "DELETE" });
  },
  async fetch(remoteId) {
    const t = await api<ThreadSummary>(`/threads/${remoteId}`);
    return { remoteId: t.id, status: t.status, title: t.title ?? undefined };
  },
  async generateTitle(remoteId, messages) {
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
            if (!remoteId) return { messages: [] };
            const rows = await api<Array<{ id: string; parent_id: string | null; format: string; content: unknown }>>(
              `/threads/${remoteId}/messages`,
            );
            return { messages: rows.map((row) => fmt.decode(row as Parameters<typeof fmt.decode>[0])) };
          },
          async append(item) {
            const { remoteId } = await aui.threadListItem.initialize();
            await api(`/threads/${remoteId}/messages`, {
              method: "POST",
              json: { id: fmt.getId(item.message), parent_id: item.parentId, format: fmt.format, content: fmt.encode(item) },
            });
          },
          async update(item, localMessageId) {
            const { remoteId } = await aui.threadListItem.initialize();
            await api(`/threads/${remoteId}/messages`, {
              method: "POST",
              json: { id: localMessageId, parent_id: item.parentId, format: fmt.format, content: fmt.encode(item) },
            });
          },
        }),
      }),
      [aui],
    );
    return useMemo(() => ({ history, attachments }), [history]);
  },
};

/** Sends the composer's model and reasoning effort with every request as model context `config`. */
function ModelContextBridge() {
  const aui = useAui();
  const model = useActiveModel();
  const effort = useData((s) => (model ? s.settings?.reasoningEffort[model.ref] : undefined));
  useEffect(
    () =>
      aui.modelContext.register({
        getModelContext: () => ({ config: { modelName: model?.ref, reasoningEffort: effort } }),
      }),
    [aui, model?.ref, effort],
  );
  return null;
}

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: () =>
      // eslint-disable-next-line react-hooks/rules-of-hooks
      useChatRuntime({
        transport: new AssistantChatTransport({
          api: "/api/chat",
          credentials: "same-origin",
          body: () => ({ planMode: useData.getState().planMode }),
        }),
        adapters: { attachments, ...voiceAdapters },
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
