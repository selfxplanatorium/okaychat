import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type UIMessage,
  type ToolSet,
} from "ai";
import { frontendTools, type FrontendTools } from "assistant-stream/ai-sdk";
import { createInMemoryResumableStreamStore, createResumableStreamContext, RESUMABLE_STREAM_ID_HEADER } from "assistant-stream/resumable";
import { Hono } from "hono";
import { z } from "zod";
import type { AssistantMetadata, ModelInfo, ReasoningEffort, TokenUsage, UserSettings } from "../shared/types.js";
import type { AppEnv } from "./auth.js";
import { ARTIFACT_INSTRUCTIONS, artifactTools } from "./artifacts.js";
import { listModels, resolveModel } from "./catalog/providers.js";
import { isConnected as codexConnected } from "./codex.js";
import { newId } from "./crypto.js";
import { applyCompaction, compact, currentContextTokens, summaryMessages } from "./compaction.js";
import { createModel } from "./llm.js";
import { toolsForUser } from "./mcp/manager.js";
import { imageTools } from "./tools/image.js";
import { sandboxConfigured, sandboxTools } from "./tools/sandbox.js";
import { subagentTools } from "./tools/subagent.js";
import { injectScreenshots } from "./tools/screenshots.js";
import type { VisualShot } from "./documents/visual.js";
import { webTools } from "./tools/web.js";
import { SearchBudget, searchesInCurrentTurn, agentStepsInCurrentTurn } from "./tools/search-budget.js";
import { conversationMemory, temporaryMemory } from "./memory.js";
import { adaptPdfParts } from "./pdf-parts.js";
import { projectContext } from "./projects.js";
import { getSettings } from "./settings.js";
import { ensureThread, getThread, isTemporaryThread, setCompaction, updateThread } from "./threads.js";
import { addUsage, costOf, normalizeUsage, recordUsage, ZERO_USAGE } from "./usage.js";

const BASE_SYSTEM = `You are okaychat, a helpful assistant. Use Markdown. Use fenced code blocks with a language tag.
Use LaTeX with $...$ inline and $$...$$ for display math. When tools are available, use them when they help, and say what you found.
When you use web results, cite sources inline as Markdown links.`;

// AssistantChatTransport sends the thread's remote id as `id` and model context as `config`, `system`, and `tools`.
const chatBody = z.object({
  messages: z.array(z.any()),
  id: z.string().min(1),
  config: z.object({ modelName: z.string().min(3), reasoningEffort: z.string().optional(), temporaryPersonalization: z.boolean().optional() }).loose(),
  // Browser-executed tools (generative UI) and the instructions that go with them.
  system: z.string().optional(),
  tools: z.record(z.string(), z.any()).optional(),
});

function systemPrompt(userPrompt: string, project: string, mcpInstructions: string[], artifacts: boolean, clientSystem?: string, memory?: string): string {
  // Order matters for caching: static text first, nothing that changes per request.
  const parts = [BASE_SYSTEM, `Today's date: ${new Date().toISOString().slice(0, 10)}.`];
  if (artifacts) parts.push(ARTIFACT_INSTRUCTIONS);
  if (userPrompt.trim()) parts.push(`# User instructions\n${userPrompt.trim()}`);
  if (project) parts.push(project);
  if (mcpInstructions.length) parts.push(`# Tool server instructions\n${mcpInstructions.join("\n\n")}`);
  if (memory) parts.push(memory);
  // Last: these change per turn (UI interactions) and should not invalidate the rest.
  if (clientSystem?.trim()) parts.push(clientSystem.trim());
  return parts.join("\n\n");
}

export interface TurnOptions {
  userId: string;
  threadId: string;
  modelRef: string;
  effort?: ReasoningEffort;
  /** The branch being continued, oldest first, ending with the new user message. */
  uiMessages: UIMessage[];
  /** Browser-executed tools and their instructions. Absent for server-side runs. */
  clientTools?: FrontendTools;
  clientSystem?: string;
  /** Only anonymous chats use this flag. Personalization is read-only and off by default. */
  temporaryPersonalization?: boolean;
  signal?: AbortSignal;
}

/** One assistant turn as a UI message stream. Used by /api/chat and by scheduled runs. */
export async function turnStream(opts: TurnOptions) {
  const { userId, threadId, modelRef, uiMessages, signal } = opts;
  const temporary = isTemporaryThread(threadId);
  const personalized = !temporary || opts.temporaryPersonalization === true;
  const describeError = (error: unknown) => describeProviderError(error, !temporary);
  const user = { id: userId };
  const settings = getSettings(userId);
  const effort = (opts.effort ?? settings.reasoningEffort[modelRef]) as ReasoningEffort | undefined;
  const { model, conn } = await resolveModel(userId, modelRef);
  if (!temporary) {
    ensureThread(user.id, threadId);
    updateThread(user.id, threadId, { modelRef });
  }
  const thread = temporary ? { projectId: null, compaction: null } : getThread(user.id, threadId)!;

  const stream = createUIMessageStream({
    originalMessages: uiMessages,
    onError: describeError,
    execute: async ({ writer }) => {
      let compaction = thread.compaction;

      // Auto-compact before the turn when the conversation no longer fits comfortably.
      const threshold = settings.autoCompactAt;
      const history = uiMessages.slice(0, -1);
      if (!temporary && threshold > 0 && history.length > 2 && currentContextTokens(applyCompaction(uiMessages, compaction).messages) > model.context * threshold) {
        writer.write({ type: "data-compaction", data: { status: "running" }, transient: true });
        compaction = await compact({ userId: user.id, threadId, messages: history, previous: compaction, model, conn });
        setCompaction(user.id, threadId, compaction);
        writer.write({ type: "data-compaction", data: { status: "done", boundaryMessageId: compaction.boundaryMessageId, tokensBefore: compaction.tokensBefore }, transient: true });
      }

      const mcp = model.toolCall && !temporary ? await toolsForUser(user.id) : { tools: {}, instructions: [], servers: [] };
      const searchBudget = new SearchBudget(settings.maxSearches, searchesInCurrentTurn(uiMessages));
      const remainingSteps = Math.max(0, settings.maxSteps - agentStepsInCurrentTurn(uiMessages));
      const builtInWeb = model.toolCall && settings.webTools ? webTools({ searchBudget }) : {};
      const lastUser = uiMessages.findLast((message) => message.role === "user");
      const query = lastUser?.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") ?? "";
      const memory = temporary
        ? personalized ? temporaryMemory(userId, query) : { context: "", instructions: undefined, tools: {} }
        : conversationMemory(userId, threadId, query);
      // Built-in tools first, then MCP tools in sorted order, so the tool block is identical across turns.
      const readOnlyTools = {
        ...builtInWeb,
        // Sub-agents run unattended, so they get no tool that waits for approval.
        ...Object.fromEntries(Object.entries(mcp.tools).filter(([, t]) => !t.needsApproval)),
      };
      const subagentModels = model.toolCall && settings.subagents && !temporary ? await allowedSubagentModels(user.id, settings, model.ref) : [];
      const useArtifacts = model.toolCall && settings.artifacts && !temporary;
      const useGenerativeUI = model.toolCall && settings.generativeUI && !!opts.clientTools && !temporary;
      const subagents = subagentModels.length
        ? subagentTools({ userId: user.id, threadId, allowed: subagentModels, subTools: readOnlyTools, maxSteps: settings.maxSteps, searchBudget, signal: signal })
        : {};
      // view_artifact stores its PNG here; prepareStep attaches it once as a user image message.
      const shots = new Map<string, VisualShot>();
      const injectedShots = new Set<string>();
      const tools: ToolSet = {
        ...builtInWeb,
        ...(model.toolCall ? memory.tools : {}),
        ...subagents,
        ...(useArtifacts ? artifactTools(threadId, user.id, { shots, canViewImages: model.inputModalities.includes("image") }) : {}),
        ...(model.toolCall && !temporary && codexConnected(user.id) ? imageTools(user.id, threadId, signal) : {}),
        ...(model.toolCall && !temporary && settings.codeExecution && sandboxConfigured() ? sandboxTools(user.id, threadId, signal) : {}),
        ...(useGenerativeUI ? frontendTools(opts.clientTools!) : {}),
        ...mcp.tools,
      };
      const { messages: live, summary } = applyCompaction(uiMessages, compaction);
      const handle = createModel(model, conn, { affinity: threadId, effort });
      const converted = await convertToModelMessages(await adaptPdfParts(live, model), { tools, ignoreIncompleteToolCalls: true });
      // Retrieved facts change with the query. Keep them near the current request so a
      // different subset does not invalidate the stable system and conversation prefix.
      if (memory.context) {
        const lastUserIndex = converted.findLastIndex((message) => message.role === "user");
        converted.splice(lastUserIndex < 0 ? converted.length : lastUserIndex, 0, { role: "user", content: memory.context });
      }
      const memoryInstructions = [temporary ? "This is an anonymous chat. It is not saved in okaychat history and must never create or change saved memories. Do not claim that this hides the conversation from the selected model provider." : "", memory.instructions].filter(Boolean).join("\n\n");
      const { system, messages } = handle.markCache(systemPrompt(personalized ? settings.systemPrompt : "", temporary ? "" : projectContext(userId, thread.projectId), mcp.instructions, useArtifacts, useGenerativeUI ? opts.clientSystem : undefined, memoryInstructions), [
        ...(summary ? summaryMessages(summary) : []),
        ...converted,
      ]);

      const startedAt = Date.now();
      let total: TokenUsage = ZERO_USAGE;
      let cost = 0;
      let lastStep: LanguageModelUsage | undefined;

      const result = streamText({
        model: handle.model,
        messages: system ? [system, ...messages] : messages,
        allowSystemInMessages: true,
        tools,
        // Reserve one final response without tools, so hitting the limit cannot restart the
        // allowance through the client's automatic tool-result continuation.
        stopWhen: stepCountIs(remainingSteps + 1),
        prepareStep: ({ stepNumber, messages: stepMessages }) => {
          const withShots = injectScreenshots(stepMessages, shots, injectedShots);
          return {
            ...(withShots !== stepMessages ? { messages: withShots } : {}),
            activeTools: stepNumber >= remainingSteps ? [] : Object.keys(tools).filter((name) => name !== "web_search" || searchBudget.remaining > 0),
            ...(stepNumber >= remainingSteps ? { toolChoice: "none" as const } : {}),
          };
        },
        providerOptions: handle.providerOptions,
        maxOutputTokens: model.maxOutput,
        abortSignal: signal,
        onStepEnd: (step) => {
          // Each step is its own request, so tier pricing applies per step.
          const usage = normalizeUsage(step.usage);
          total = addUsage(total, usage);
          cost += costOf(model.cost, usage);
          lastStep = step.usage;
        },
        onEnd: () => {
          if (!temporary) recordUsage({ userId: user.id, threadId, providerId: model.providerId, modelId: model.id, kind: "chat", usage: total, cost });
        },
      });

      writer.merge(
        result.toUIMessageStream({
          sendReasoning: true,
          sendSources: true,
          onError: describeError,
          messageMetadata: ({ part }): AssistantMetadata | undefined => {
            if (part.type === "start") return { modelRef, contextWindow: model.context };
            if (part.type === "finish") {
              return {
                modelRef,
                usage: total,
                cost,
                contextTokens: (lastStep?.inputTokens ?? 0) + (lastStep?.outputTokens ?? 0),
                contextWindow: model.context,
                durationMs: Date.now() - startedAt,
                compacted: compaction !== thread.compaction,
              };
            }
            return undefined;
          },
        }),
      );
    },
  });
  return stream;
}

// Streams live in memory for 15 minutes after their last update. A restart drops them; the client then shows what was saved.
const RESUME_TTL_MS = 15 * 60_000;
const resumable = createResumableStreamContext({
  store: createInMemoryResumableStreamStore(),
  ttlMs: RESUME_TTL_MS,
  onFinalize: (streamId) => setTimeout(() => runs.delete(streamId), RESUME_TTL_MS).unref(),
});
const runs = new Map<string, { userId: string; controller: AbortController }>();

export const chatRoutes = new Hono<AppEnv>()
  .post("/chat", async (c) => {
    const user = c.get("user");
    const parsed = chatBody.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Pick a model before sending." }, 400);
    if (isTemporaryThread(parsed.data.id)) {
      try {
        const stream = await turnStream({
          userId: user.id,
          threadId: parsed.data.id,
          modelRef: parsed.data.config.modelName,
          effort: parsed.data.config.reasoningEffort as ReasoningEffort | undefined,
          temporaryPersonalization: parsed.data.config.temporaryPersonalization ?? false,
          uiMessages: parsed.data.messages as UIMessage[],
          // Anonymous turns have no resumable copy and end when the request disconnects.
          signal: c.req.raw.signal,
        });
        return createUIMessageStreamResponse({ stream, headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
      }
    }
    // Generation is decoupled from this request so a reload can reattach. Stop sends an explicit cancel.
    const streamId = newId("str");
    const controller = new AbortController();
    try {
      const stream = await turnStream({
        userId: user.id,
        threadId: parsed.data.id,
        modelRef: parsed.data.config.modelName,
        effort: parsed.data.config.reasoningEffort as ReasoningEffort | undefined,
        uiMessages: parsed.data.messages as UIMessage[],
        clientTools: parsed.data.tools as FrontendTools | undefined,
        clientSystem: parsed.data.system,
        signal: controller.signal,
      });
      runs.set(streamId, { userId: user.id, controller });
      const response = createUIMessageStreamResponse({ stream });
      const body = await resumable.run(streamId, () => response.body!);
      const headers = new Headers(response.headers);
      headers.set(RESUMABLE_STREAM_ID_HEADER, streamId);
      return new Response(body, { headers });
    } catch (error) {
      controller.abort();
      runs.delete(streamId);
      return c.json({ error: (error as Error).message }, 400);
    }
  })
  .get("/chat/resume/:streamId", async (c) => {
    const run = runs.get(c.req.param("streamId"));
    // 204 is the AI SDK's "no active stream" answer.
    if (!run || run.userId !== c.get("user").id) return c.body(null, 204);
    const body = await resumable.resume(c.req.param("streamId"));
    if (!body) return c.body(null, 204);
    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "x-vercel-ai-ui-message-stream": "v1" } });
  })
  .post("/chat/:streamId/cancel", (c) => {
    const run = runs.get(c.req.param("streamId"));
    if (run?.userId === c.get("user").id) run.controller.abort();
    return c.json({ ok: true });
  })
  .post("/threads/:id/compact", async (c) => {
    const user = c.get("user");
    const threadId = c.req.param("id");
    if (isTemporaryThread(threadId)) return c.json({ error: "Anonymous chats cannot save compaction" }, 400);
    const body = (await c.req.json()) as { messages: UIMessage[]; modelRef: string };
    const thread = getThread(user.id, threadId);
    if (!thread) return c.json({ error: "Thread not found" }, 404);
    if (body.messages.length < 2) return c.json({ error: "Not enough conversation to compact" }, 400);
    const { model, conn } = await resolveModel(user.id, getSettings(user.id).utilityModel ?? body.modelRef).catch(() =>
      resolveModel(user.id, body.modelRef),
    );
    const state = await compact({ userId: user.id, threadId, messages: body.messages, previous: thread.compaction, model, conn });
    setCompaction(user.id, threadId, state);
    return c.json(state);
  })
  .delete("/threads/:id/compact", (c) => {
    if (isTemporaryThread(c.req.param("id"))) return c.json({ error: "Anonymous chats cannot save compaction" }, 400);
    setCompaction(c.get("user").id, c.req.param("id"), null);
    return c.json({ ok: true });
  })
  .post("/threads/:id/title", async (c) => {
    const user = c.get("user");
    const threadId = c.req.param("id");
    if (isTemporaryThread(threadId)) return c.json({ title: "Anonymous chat" });
    const body = (await c.req.json()) as { text: string; modelRef?: string };
    const fallback = body.text.trim().split("\n")[0]!.slice(0, 60) || "New chat";
    const ref = getSettings(user.id).utilityModel ?? body.modelRef;
    let title = fallback;
    if (ref) {
      try {
        const { model, conn } = await resolveModel(user.id, ref);
        const handle = createModel(model, conn, { affinity: `${threadId}-title` });
        const result = await generateText({
          model: handle.model,
          providerOptions: handle.providerOptions,
          maxOutputTokens: 400,
          prompt: `Write a short title (max 6 words) for a chat that starts with the message below. Reply with the title only, no quotes or punctuation at the end.\n\n<message>\n${body.text.slice(0, 4000)}\n</message>`,
        });
        const usage = normalizeUsage(result.totalUsage);
        recordUsage({ userId: user.id, threadId, providerId: model.providerId, modelId: model.id, kind: "title", usage, cost: costOf(model.cost, usage) });
        title = result.text.trim().replace(/^["'#\s]+|["'.\s]+$/g, "").slice(0, 80) || fallback;
      } catch {
        // A failed title is cosmetic. Keep the fallback.
      }
    }
    updateThread(user.id, threadId, { title });
    return c.json({ title });
  });

/** The default sub-agent model first, then the utility and chat models. Only models that can call tools. */
async function allowedSubagentModels(userId: string, settings: UserSettings, chatModel: string): Promise<ModelInfo[]> {
  const models = await listModels(userId);
  const refs = [...new Set([settings.subagentModel, settings.utilityModel, chatModel].filter((r): r is string => !!r))];
  return refs.map((ref) => models.find((m) => m.ref === ref)).filter((m): m is ModelInfo => !!m?.toolCall);
}

function describeProviderError(error: unknown, log = true): string {
  if (log) console.error("[chat]", error);
  const e = error as { statusCode?: number; message?: string; responseBody?: string };
  if (e?.statusCode === 401 || e?.statusCode === 403) return `The provider rejected the API key: ${e.message ?? "unauthorized"} Update it in Settings → Providers.`;
  if (e?.statusCode === 429) return "Rate or usage limit reached. Wait, or switch models.";
  const detail = e?.responseBody ? `${e.message} — ${e.responseBody.slice(0, 300)}` : e?.message;
  return detail ?? "The request failed.";
}
