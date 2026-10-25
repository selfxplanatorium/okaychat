import { stepCountIs, streamText, tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ModelInfo, TokenUsage } from "../../shared/types.js";
import { resolveModel } from "../catalog/providers.js";
import { createModel } from "../llm.js";
import { promptText } from "../prompts.js";
import { addUsage, costOf, normalizeUsage, recordUsage, ZERO_USAGE } from "../usage.js";
import type { SearchBudget } from "./search-budget.js";

// A sub-agent runs one self-contained task on a model the user allows, in its own context, with the
// read-only tools. Only its final report goes back to the main model, which keeps the main context small.

const MAX_STEPS = 15;
const PROGRESS_INTERVAL_MS = 250;

export interface SubagentProgress {
  model: string;
  status: "running" | "done";
  text: string;
  steps: number;
  tools: string[];
  usage?: TokenUsage;
  cost?: number;
}

/**
 * @param allowed Models the main model may pick, first is the default.
 * @param subTools Tools the sub-agent may use. Must not need approval: nobody is there to answer.
 */
export function subagentTools(opts: { userId: string; threadId: string; allowed: ModelInfo[]; subTools: ToolSet; maxSteps?: number; searchBudget?: SearchBudget; signal?: AbortSignal }): ToolSet {
  const refs = opts.allowed.map((m) => m.ref) as [string, ...string[]];
  const list = opts.allowed.map((m) => `\`${m.ref}\` (${m.name}${m.context ? `, ${Math.round(m.context / 1000)}k context` : ""})`).join(", ");
  return {
    delegate_task: tool({
      description: `Delegate a self-contained task to a sub-agent that runs on its own with web and read-only tools and returns a report. Use it for research or analysis that would flood this conversation, or to run independent parts in parallel (call it several times in one step). The sub-agent sees none of this conversation: put every detail it needs in \`task\`. Models: ${list}.`,
      inputSchema: z.object({
        task: z.string().min(1).describe("Complete instructions, context, and the expected shape of the report"),
        model: z.enum(refs).optional().describe(`Default \`${refs[0]}\``),
      }),
      execute: async function* ({ task, model: ref }, { toolCallId }): AsyncGenerator<SubagentProgress> {
        const { model, conn } = await resolveModel(opts.userId, ref ?? refs[0]);
        const handle = createModel(model, conn, { userId: opts.userId });
        let usage = ZERO_USAGE;
        let cost = 0;
        const progress: SubagentProgress = { model: model.ref, status: "running", text: "", steps: 0, tools: [] };
        const maxSteps = Math.min(opts.maxSteps ?? MAX_STEPS, MAX_STEPS);
        const result = streamText({
          model: handle.model,
          providerOptions: handle.providerOptions,
          // The remaining search budget changes per delegation, so it rides with the task, after the tools.
          messages: handle.markCache([promptText("subagent")], [{
            role: "user",
            content: [opts.searchBudget ? promptText("subagentSearchBudget", { remaining: opts.searchBudget.remaining }) : "", task].filter((part) => part.trim()).join("\n\n"),
          }]),
          allowSystemInMessages: true,
          tools: opts.subTools,
          stopWhen: stepCountIs(maxSteps + 1),
          // Same as the parent loop: a constant tool list keeps the prefix cached; the last step forbids calls.
          prepareStep: ({ stepNumber }) => (stepNumber >= maxSteps ? { toolChoice: "none" as const } : {}),
          maxOutputTokens: model.maxOutput,
          abortSignal: opts.signal,
          onStepEnd: (step) => {
            const u = normalizeUsage(step.usage);
            usage = addUsage(usage, u);
            cost += costOf(model.cost, u);
          },
        });
        let lastYield = 0;
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") progress.text += part.text;
          else if (part.type === "tool-call") progress.tools.push(part.toolName);
          else if (part.type === "finish-step") progress.steps++;
          else if (part.type === "error") throw part.error;
          if (Date.now() - lastYield > PROGRESS_INTERVAL_MS) {
            lastYield = Date.now();
            yield { ...progress, tools: [...progress.tools] };
          }
        }
        const finalText = (await result.text).trim();
        recordUsage({ userId: opts.userId, threadId: opts.threadId, providerId: model.providerId, modelId: model.id, kind: "subagent", usage, cost });
        yield { ...progress, status: "done", text: finalText || progress.text.trim(), usage, cost };
      },
      // The main model needs the report, not the bookkeeping.
      toModelOutput: ({ output }) => ({ type: "text", value: output.text || "The sub-agent returned no text." }),
    }),
  };
}
