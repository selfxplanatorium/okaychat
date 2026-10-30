import { generateText, stepCountIs, streamText, tool, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import type { ModelInfo, PromptKey, ReasoningEffort, TokenUsage } from "../shared/types.js";
import type { Connection } from "./catalog/providers.js";
import { createModel } from "./llm.js";
import { promptText } from "./prompts.js";
import { SearchShare, type SearchBudget, type StepBudget } from "./tools/search-budget.js";
import { webTools } from "./tools/web.js";
import { addUsage, costOf, normalizeUsage, recordUsage, ZERO_USAGE } from "./usage.js";

// Deep research: a bounded plan → collect → review loop that runs before the chat model answers. The chat
// model then writes the cited report as its normal reply, from the findings this returns as a tool result.
// Workers get only web_search and web_fetch, built here, so research cannot write anything.
// See docs/implementation/deep-research.md.

export const RESEARCH_TOOL = "deep_research";

const MAX_QUESTIONS = 4;
const MAX_FOLLOW_UPS = 3;
const MAX_ROUNDS = 2;
const WORKER_STEPS = 6;
/** Concurrent workers when the account allows sub-agents; one at a time otherwise. */
export const RESEARCH_PARALLEL = 3;
const REQUEST_CHARS = 8_000;
const CONTEXT_CHARS = 12_000;
const NOTES_CHARS = 8_000;
const MAX_SOURCES = 60;
const PROGRESS_INTERVAL_MS = 250;

export interface ResearchQuestion {
  question: string;
  round: number;
  status: "queued" | "running" | "done" | "failed" | "skipped";
  searches: number;
  reads: number;
  error?: string;
}

export interface ResearchProgress {
  phase: "planning" | "researching" | "reviewing" | "done";
  objective: string;
  round: number;
  questions: ResearchQuestion[];
  /** Pages the workers actually read. */
  sources: Array<{ url: string; title: string }>;
  conflicts: string[];
  /** Follow-up questions the last review still had open. */
  gaps: string[];
  /** Agent steps and search queries research consumed from the reply's allowances. */
  steps: number;
  searches: number;
  /** Set when an allowance ended research before its rounds were done. */
  limited?: "searches" | "steps";
  /** Research model calls only. The chat model's report is metered as the reply. */
  usage: TokenUsage;
  cost: number;
  /** Final output only: what the chat model writes the report from. */
  findings?: string;
}

interface Stage {
  model: ModelInfo;
  conn: Connection;
}

export interface ResearchOptions {
  userId: string;
  threadId: string;
  /** False for temporary chats, which leave no usage records. */
  record: boolean;
  /** Plans and reviews: the chat's model and reasoning effort. */
  lead: Stage & { effort?: ReasoningEffort };
  /** Investigates questions: the account's default sub-agent model, or the lead. */
  worker: Stage;
  parallel: number;
  request: string;
  context: string;
  searchBudget: SearchBudget;
  stepBudget: StepBudget;
  signal?: AbortSignal;
  onProgress?: (progress: ResearchProgress) => void;
}

const planSchema = z.object({ objective: z.string(), questions: z.array(z.string()) });
const reviewSchema = z.object({ gaps: z.array(z.string()).default([]), conflicts: z.array(z.string()).default([]) });

/** The first JSON object in a model reply, tolerating code fences and prose around it. */
function parseJson<T>(text: string, schema: z.ZodType<T>): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const clean = (items: string[], max: number, known: string[] = []) => {
  const seen = new Set(known.map((item) => item.trim().toLowerCase()));
  const out: string[] = [];
  for (const item of items) {
    const text = item.trim().slice(0, 500);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
};

const textOf = (message: UIMessage) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();

/** The latest user request and a bounded excerpt of the conversation before it, newest kept. */
export function researchInput(messages: UIMessage[]): { request: string; context: string } {
  const last = messages.findLastIndex((message) => message.role === "user");
  const request = last >= 0 ? textOf(messages[last]!).slice(0, REQUEST_CHARS) : "";
  const lines: string[] = [];
  let size = 0;
  for (const message of messages.slice(0, Math.max(0, last)).reverse()) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = textOf(message);
    if (!text) continue;
    const line = `${message.role === "user" ? "User" : "Assistant"}: ${text}`;
    if (size + line.length > CONTEXT_CHARS) {
      if (!lines.length) lines.push(line.slice(-CONTEXT_CHARS));
      break;
    }
    lines.unshift(line);
    size += line.length;
  }
  return { request, context: lines.join("\n\n") };
}

/** The deep research part of a reply, as `searchesInCurrentTurn` names tool parts. */
export const isResearchPart = (part: { type?: string; toolName?: string }) =>
  part.type === `tool-${RESEARCH_TOOL}` || (part.type === "dynamic-tool" && part.toolName === RESEARCH_TOOL);

/** True when the reply after the latest user message already ran (or tried) deep research. */
export function researchedThisTurn(messages: UIMessage[]): boolean {
  const last = messages.findLastIndex((message) => message.role === "user");
  return messages.slice(last + 1).some((message) => message.role === "assistant" && message.parts.some(isResearchPart));
}

export const hasResearch = (messages: UIMessage[]) => messages.some((message) => message.role === "assistant" && message.parts.some(isResearchPart));

/** What the chat model sees for a research part: the report instructions and the findings. */
export function researchModelOutput(output: unknown): string {
  const findings = output && typeof output === "object" ? (output as { findings?: unknown }).findings : undefined;
  if (typeof findings !== "string" || !findings) return "Deep research was stopped before it finished. Tell the user it did not complete.";
  return `${promptText("researchReport")}\n\n<findings>\n${findings}\n</findings>`;
}

/**
 * Listed only in chats that use deep research, so other chats keep their tool block. okaychat runs research
 * itself when the user turns it on; the definition exists so earlier research results convert with their
 * report instructions and the tool block stays the same from the first research turn on.
 */
export function researchTool(): ToolSet {
  return {
    [RESEARCH_TOOL]: tool({
      description: "Results of okaychat's deep research. okaychat starts it when the user turns on Deep research in the composer. Do not call it yourself.",
      inputSchema: z.object({ request: z.string() }),
      execute: async (): Promise<ResearchProgress> => {
        throw new Error("Deep research starts only when the user turns it on in the composer. Answer with your other tools.");
      },
      toModelOutput: ({ output }) => ({ type: "text", value: researchModelOutput(output) }),
    }),
  };
}

const isAbort = (error: unknown, signal?: AbortSignal) => signal?.aborted || (error instanceof Error && error.name === "AbortError");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Runs the research loop and returns its final progress, with `findings` for the chat model. */
export async function runResearch(o: ResearchOptions): Promise<ResearchProgress> {
  const date = promptText("date", { date: new Date().toISOString().slice(0, 10) });
  const startSearches = o.searchBudget.remaining;
  const startSteps = o.stepBudget.remaining;
  const progress: ResearchProgress = {
    phase: "planning",
    objective: "",
    round: 0,
    questions: [],
    sources: [],
    conflicts: [],
    gaps: [],
    steps: 0,
    searches: 0,
    usage: ZERO_USAGE,
    cost: 0,
  };
  const notes = new Map<ResearchQuestion, string>();
  // Usage per model, written once at the end, also when research stops or fails part way.
  const metered = new Map<string, { model: ModelInfo; usage: TokenUsage; cost: number }>();
  const meter = (model: ModelInfo, raw: Parameters<typeof normalizeUsage>[0]) => {
    const usage = normalizeUsage(raw);
    const cost = costOf(model.cost, usage);
    const entry = metered.get(model.ref) ?? { model, usage: ZERO_USAGE, cost: 0 };
    entry.usage = addUsage(entry.usage, usage);
    entry.cost += cost;
    metered.set(model.ref, entry);
    progress.usage = addUsage(progress.usage, usage);
    progress.cost += cost;
  };

  let lastEmit = 0;
  const emit = (force = false) => {
    progress.searches = startSearches - o.searchBudget.remaining;
    progress.steps = startSteps - o.stepBudget.remaining;
    if (!o.onProgress || (!force && Date.now() - lastEmit < PROGRESS_INTERVAL_MS)) return;
    lastEmit = Date.now();
    o.onProgress(structuredClone(progress));
  };

  const lead = createModel(o.lead.model, o.lead.conn, { userId: o.userId, effort: o.lead.effort });
  /** One tool-free model call on the lead model. Its system prompt is constant, so it stays cached. */
  const stage = async (key: PromptKey, values: Record<string, number>, content: string) => {
    const result = await generateText({
      model: lead.model,
      providerOptions: lead.providerOptions,
      messages: lead.markCache([promptText(key, values)], [{ role: "user", content: `${date}\n\n${content}` }]),
      allowSystemInMessages: true,
      maxOutputTokens: o.lead.model.maxOutput,
      abortSignal: o.signal,
    });
    meter(o.lead.model, result.totalUsage);
    return result.text;
  };

  const worker = createModel(o.worker.model, o.worker.conn, { userId: o.userId });
  const investigate = async (question: ResearchQuestion, pending: number) => {
    // Shares are fixed when a worker starts, so earlier workers cannot starve later ones.
    const stepShare = Math.max(1, Math.min(WORKER_STEPS, Math.floor(o.stepBudget.remaining / pending)));
    const searchShare = Math.max(1, Math.floor(o.searchBudget.remaining / pending));
    question.status = "running";
    emit(true);
    let steps = 0;
    const result = streamText({
      model: worker.model,
      providerOptions: worker.providerOptions,
      messages: worker.markCache([promptText("researchWorker")], [{
        role: "user",
        content: [
          date,
          `<objective>\n${progress.objective}\n</objective>`,
          `<question>\n${question.question}\n</question>`,
          `You may run up to ${searchShare} web searches for this question.`,
        ].join("\n\n"),
      }]),
      allowSystemInMessages: true,
      tools: webTools({ searchBudget: new SearchShare(o.searchBudget, searchShare), search: true }),
      stopWhen: stepCountIs(stepShare + 1),
      // Every tool-capable step comes out of the reply's allowance. The last one forbids calls instead of
      // removing tools, like the chat loop, so the cached tool block stays the same.
      prepareStep: () => {
        if (steps < stepShare && o.stepBudget.reserve()) {
          steps++;
          return {};
        }
        return { toolChoice: "none" as const };
      },
      maxOutputTokens: o.worker.model.maxOutput,
      abortSignal: o.signal,
      onStepEnd: (step) => meter(o.worker.model, step.usage),
    });
    for await (const part of result.fullStream) {
      if (part.type === "tool-call" && part.toolName === "web_search") question.searches++;
      else if (part.type === "tool-result" && part.toolName === "web_fetch") {
        question.reads++;
        const page = part.output as { url?: string; title?: string };
        if (page?.url && progress.sources.length < MAX_SOURCES && !progress.sources.some((source) => source.url === page.url)) {
          progress.sources.push({ url: page.url, title: (page.title || page.url).slice(0, 200) });
        }
      } else if (part.type === "error") throw part.error;
      else continue;
      emit();
    }
    o.signal?.throwIfAborted();
    const text = (await result.text).trim();
    if (!text) throw new Error("The worker returned no notes.");
    notes.set(question, text.slice(0, NOTES_CHARS));
    question.status = "done";
  };

  const collect = async (batch: ResearchQuestion[]) => {
    let next = 0;
    const run = async () => {
      while (next < batch.length) {
        const question = batch[next++]!;
        if (o.searchBudget.remaining === 0 || o.stepBudget.remaining === 0) {
          question.status = "skipped";
          progress.limited = o.searchBudget.remaining === 0 ? "searches" : "steps";
          continue;
        }
        try {
          await investigate(question, batch.filter((item) => item.status === "queued" || item.status === "running").length);
        } catch (error) {
          if (isAbort(error, o.signal)) throw error;
          question.status = "failed";
          question.error = message(error);
        }
        emit(true);
      }
    };
    await Promise.all(Array.from({ length: Math.min(o.parallel, batch.length) }, run));
  };

  const notesText = () =>
    progress.questions
      .map((question) => `### ${question.question}\n${notes.get(question) ?? (question.error ? `No notes: ${question.error}` : "No notes: not researched.")}`)
      .join("\n\n");

  try {
    emit(true);
    const fit = (cap: number) => Math.max(1, Math.min(cap, o.searchBudget.remaining, o.stepBudget.remaining));
    const planned = parseJson(
      await stage(
        "researchPlan",
        { maxQuestions: fit(MAX_QUESTIONS) },
        `<conversation>\n${o.context || "(none)"}\n</conversation>\n\n<request>\n${o.request}\n</request>`,
      ),
      planSchema,
    );
    progress.objective = planned?.objective.trim().slice(0, 1000) || o.request.slice(0, 1000);
    let batch = clean(planned?.questions ?? [], fit(MAX_QUESTIONS));
    if (!batch.length) batch = [progress.objective.slice(0, 500)];

    for (let round = 1; ; round++) {
      progress.round = round;
      progress.phase = "researching";
      const questions = batch.map((question): ResearchQuestion => ({ question, round, status: "queued", searches: 0, reads: 0 }));
      progress.questions.push(...questions);
      emit(true);
      await collect(questions);
      if (!notes.size) {
        const failure = progress.questions.find((question) => question.error)?.error;
        throw new Error(failure ? `Deep research could not collect evidence: ${failure}` : "Deep research could not collect evidence within the search and step limits.");
      }

      progress.phase = "reviewing";
      emit(true);
      let review: z.infer<typeof reviewSchema> | null = null;
      try {
        review = parseJson(
          await stage(
            "researchReview",
            { maxQuestions: MAX_FOLLOW_UPS },
            `<objective>\n${progress.objective}\n</objective>\n\n<notes>\n${notesText()}\n</notes>`,
          ),
          reviewSchema,
        );
      } catch (error) {
        // The notes are already paid for. A failed review only loses the follow-up round.
        if (isAbort(error, o.signal)) throw error;
      }
      // A failed or malformed review must not erase previously identified uncertainties.
      if (!review) {
        progress.gaps = clean([...progress.gaps, "The evidence review did not complete; coverage and conflicts remain unverified."], 4);
        break;
      }
      progress.conflicts = clean(review.conflicts, 8);
      progress.gaps = clean(review.gaps, MAX_FOLLOW_UPS);
      if (round >= MAX_ROUNDS || !progress.gaps.length) break;
      if (o.searchBudget.remaining === 0 || o.stepBudget.remaining === 0) {
        progress.limited = o.searchBudget.remaining === 0 ? "searches" : "steps";
        break;
      }
      batch = progress.gaps.slice(0, fit(MAX_FOLLOW_UPS));
    }

    progress.phase = "done";
    progress.findings = [
      `Objective: ${progress.objective}`,
      `## Findings\n${notesText()}`,
      progress.conflicts.length ? `## Conflicts and weak evidence\n${progress.conflicts.map((item) => `- ${item}`).join("\n")}` : "",
      progress.gaps.length ? `## Open questions\n${progress.gaps.map((item) => `- ${item}`).join("\n")}` : "",
      progress.limited ? `Research stopped early: the ${progress.limited === "searches" ? "web search" : "agent step"} limit for this reply was reached.` : "",
      progress.sources.length ? `## Pages read\n${progress.sources.map((source) => `- [${source.title.replace(/[[\]]/g, "")}](${source.url})`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    emit(true);
    return progress;
  } finally {
    if (o.record) {
      for (const { model, usage, cost } of metered.values()) {
        recordUsage({ userId: o.userId, threadId: o.threadId, providerId: model.providerId, modelId: model.id, kind: "research", usage, cost });
      }
    }
  }
}
