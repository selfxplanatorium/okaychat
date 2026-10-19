import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import { frontendTools, type FrontendTools } from "assistant-stream/ai-sdk";
import { Hono } from "hono";
import { z } from "zod";
import type { AssistantMetadata, ModelInfo, ReasoningEffort, TokenUsage, UserSettings } from "../shared/types.js";
import type { AppEnv } from "./auth.js";
import { ARTIFACT_INSTRUCTIONS, artifactTools } from "./artifacts.js";
import { listModels, resolveModel } from "./catalog/providers.js";
import { isConnected as codexConnected } from "./codex.js";
import { applyCompaction, compact, currentContextTokens, summaryMessages } from "./compaction.js";
import { createModel } from "./llm.js";
import { toolsForUser } from "./mcp/manager.js";
import { imageTools } from "./tools/image.js";
import { subagentTools } from "./tools/subagent.js";
import { webTools } from "./tools/web.js";
import { getSettings } from "./settings.js";
import { ensureThread, getThread, setCompaction, updateThread } from "./threads.js";
import { addUsage, costOf, normalizeUsage, recordUsage, ZERO_USAGE } from "./usage.js";

const BASE_SYSTEM = `You are okaychat, a helpful assistant. Use Markdown. Use fenced code blocks with a language tag.
Use LaTeX with $...$ inline and $$...$$ for display math. When tools are available, use them when they help, and say what you found.
When you use web results, cite sources inline as Markdown links.`;

// AssistantChatTransport sends the thread's remote id as `id` and model context as `config`, `system`, and `tools`.
const chatBody = z.object({
  messages: z.array(z.any()),
  id: z.string().min(1),
  config: z.object({ modelName: z.string().min(3), reasoningEffort: z.string().optional() }).loose(),
  // Browser-executed tools (generative UI) and the instructions that go with them.
  system: z.string().optional(),
  tools: z.record(z.string(), z.any()).optional(),
  planMode: z.boolean().optional(),
});

const PLAN_INSTRUCTIONS = `# Plan mode
The user wants a plan before anything changes. Investigate with the read-only tools you have, ask about anything that blocks a good plan, then reply with a numbered plan: the steps, what each changes, and open questions. Do not carry out the plan. The user switches to act mode to run it.`;

function systemPrompt(userPrompt: string, mcpInstructions: string[], artifacts: boolean, clientSystem?: string, planMode?: boolean): string {
  // Order matters for caching: static text first, nothing that changes per request.
  const parts = [BASE_SYSTEM, `Today's date: ${new Date().toISOString().slice(0, 10)}.`];
  if (artifacts) parts.push(ARTIFACT_INSTRUCTIONS);
  if (userPrompt.trim()) parts.push(`# User instructions\n${userPrompt.trim()}`);
  if (mcpInstructions.length) parts.push(`# Tool server instructions\n${mcpInstructions.join("\n\n")}`);
  // Last: these change per turn (UI interactions, mode toggle) and should not invalidate the rest.
  if (clientSystem?.trim()) parts.push(clientSystem.trim());
  if (planMode) parts.push(PLAN_INSTRUCTIONS);
  return parts.join("\n\n");
}

export interface TurnOptions {
  userId: string;
  threadId: string;
  modelRef: string;
  effort?: ReasoningEffort;
  /** The branch being continued, oldest first, ending with the new user message. */
  uiMessages: UIMessage[];
  planMode?: boolean;
  /** Browser-executed tools and their instructions. Absent for server-side runs. */
  clientTools?: FrontendTools;
  clientSystem?: string;
  signal?: AbortSignal;
}

/** One assistant turn as a UI message stream. Used by /api/chat and by scheduled runs. */
export async function turnStream(opts: TurnOptions) {
  const { userId, threadId, modelRef, uiMessages, signal, planMode = false } = opts;
  const user = { id: userId };
  const settings = getSettings(userId);
  const effort = (opts.effort ?? settings.reasoningEffort[modelRef]) as ReasoningEffort | undefined;
  const { model, conn } = await resolveModel(userId, modelRef);
  ensureThread(user.id, threadId);
  updateThread(user.id, threadId, { modelRef });
  const thread = getThread(user.id, threadId)!;

  const stream = createUIMessageStream({
    originalMessages: uiMessages,
    onError: (error) => describeProviderError(error),
    execute: async ({ writer }) => {
      let compaction = thread.compaction;

      // Auto-compact before the turn when the conversation no longer fits comfortably.
      const threshold = settings.autoCompactAt;
      const history = uiMessages.slice(0, -1);
      if (threshold > 0 && history.length > 2 && currentContextTokens(applyCompaction(uiMessages, compaction).messages) > model.context * threshold) {
        writer.write({ type: "data-compaction", data: { status: "running" }, transient: true });
        compaction = await compact({ userId: user.id, threadId, messages: history, previous: compaction, model, conn });
        setCompaction(user.id, threadId, compaction);
        writer.write({ type: "data-compaction", data: { status: "done", boundaryMessageId: compaction.boundaryMessageId, tokensBefore: compaction.tokensBefore }, transient: true });
      }

      const mcp = model.toolCall ? await toolsForUser(user.id) : { tools: {}, readOnly: new Set<string>(), instructions: [], servers: [] };
      // Built-in tools first, then MCP tools in sorted order, so the tool block is identical across turns.
      const readOnlyTools = {
        ...(model.toolCall && settings.webTools ? webTools() : {}),
        // Sub-agents run unattended, so they get no tool that waits for approval.
        ...Object.fromEntries(Object.entries(mcp.tools).filter(([, t]) => !t.needsApproval)),
      };
      const subagentModels = model.toolCall && settings.subagents ? await allowedSubagentModels(user.id, settings, model.ref) : [];
      const useArtifacts = model.toolCall && settings.artifacts && !planMode;
      const useGenerativeUI = model.toolCall && settings.generativeUI && !!opts.clientTools && !planMode;
      const subagents = subagentModels.length
        ? subagentTools({ userId: user.id, threadId, allowed: subagentModels, subTools: readOnlyTools, signal: signal })
        : {};
      // Plan mode keeps only tools that cannot change anything: web, sub-agents, and MCP tools marked read-only.
      const tools = planMode
        ? {
            ...(model.toolCall && settings.webTools ? webTools() : {}),
            ...subagents,
            ...Object.fromEntries(Object.entries(mcp.tools).filter(([name]) => mcp.readOnly.has(name))),
          }
        : {
            ...(model.toolCall && settings.webTools ? webTools() : {}),
            ...subagents,
            ...(useArtifacts ? artifactTools(threadId) : {}),
            ...(model.toolCall && codexConnected(user.id) ? imageTools(user.id, threadId, signal) : {}),
            ...(useGenerativeUI ? frontendTools(opts.clientTools!) : {}),
            ...mcp.tools,
          };
      const { messages: live, summary } = applyCompaction(uiMessages, compaction);
      const handle = createModel(model, conn, { affinity: threadId, effort });
      const converted = await convertToModelMessages(live, { tools, ignoreIncompleteToolCalls: true });
      const { system, messages } = handle.markCache(systemPrompt(settings.systemPrompt, mcp.instructions, useArtifacts, useGenerativeUI ? opts.clientSystem : undefined, planMode), [
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
        stopWhen: stepCountIs(settings.maxSteps),
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
          recordUsage({ userId: user.id, threadId, providerId: model.providerId, modelId: model.id, kind: "chat", usage: total, cost });
        },
      });

      writer.merge(
        result.toUIMessageStream({
          sendReasoning: true,
          sendSources: true,
          onError: describeProviderError,
          messageMetadata: ({ part }): AssistantMetadata | undefined => {
            if (part.type === "start") return { modelRef, contextWindow: model.context, ...(planMode ? { mode: "plan" as const } : {}) };
            if (part.type === "finish") {
              return {
                modelRef,
                usage: total,
                cost,
                contextTokens: (lastStep?.inputTokens ?? 0) + (lastStep?.outputTokens ?? 0),
                contextWindow: model.context,
                durationMs: Date.now() - startedAt,
                compacted: compaction !== thread.compaction,
                ...(planMode ? { mode: "plan" as const } : {}),
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

export const chatRoutes = new Hono<AppEnv>()
  .post("/chat", async (c) => {
    const user = c.get("user");
    const parsed = chatBody.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Pick a model before sending." }, 400);
    try {
      const stream = await turnStream({
        userId: user.id,
        threadId: parsed.data.id,
        modelRef: parsed.data.config.modelName,
        effort: parsed.data.config.reasoningEffort as ReasoningEffort | undefined,
        uiMessages: parsed.data.messages as UIMessage[],
        planMode: parsed.data.planMode === true,
        clientTools: parsed.data.tools as FrontendTools | undefined,
        clientSystem: parsed.data.system,
        signal: c.req.raw.signal,
      });
      return createUIMessageStreamResponse({ stream });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  })
  .post("/threads/:id/compact", async (c) => {
    const user = c.get("user");
    const threadId = c.req.param("id");
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
    setCompaction(c.get("user").id, c.req.param("id"), null);
    return c.json({ ok: true });
  })
  .post("/threads/:id/title", async (c) => {
    const user = c.get("user");
    const threadId = c.req.param("id");
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

function describeProviderError(error: unknown): string {
  console.error("[chat]", error);
  const e = error as { statusCode?: number; message?: string; responseBody?: string };
  if (e?.statusCode === 401 || e?.statusCode === 403) return `The provider rejected the API key: ${e.message ?? "unauthorized"} Update it in Settings → Providers.`;
  if (e?.statusCode === 429) return "Rate or usage limit reached. Wait, or switch models.";
  const detail = e?.responseBody ? `${e.message} — ${e.responseBody.slice(0, 300)}` : e?.message;
  return detail ?? "The request failed.";
}
