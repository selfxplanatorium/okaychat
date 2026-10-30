/** One shared budget for a reply and every delegated task it starts. */
export class SearchBudget {
  private used: number;

  constructor(readonly limit: number, alreadyUsed = 0) {
    if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(alreadyUsed) || alreadyUsed < 0) {
      throw new RangeError("Search budget counts must be non-negative integers");
    }
    this.used = alreadyUsed;
  }

  get remaining(): number { return Math.max(0, this.limit - this.used); }

  /** Reserve before any await so concurrent tool calls cannot overspend. Failed searches count. */
  reserve(): boolean {
    if (this.remaining === 0) return false;
    this.used++;
    return true;
  }
}

/**
 * At most `share` queries out of a parent budget, so one research worker cannot spend what the others need.
 * It reports the parent's limit, which keeps the web_search description (and the cached tool block) the same
 * for every worker.
 */
export class SearchShare extends SearchBudget {
  private taken = 0;

  constructor(private readonly parent: SearchBudget, private readonly share: number) {
    super(parent.limit);
  }

  override get remaining(): number { return Math.max(0, Math.min(this.share - this.taken, this.parent.remaining)); }

  override reserve(): boolean {
    if (this.taken >= this.share || !this.parent.reserve()) return false;
    this.taken++;
    return true;
  }
}

/** The account's agent-step allowance for one reply, shared by the reply and its deep research workers. */
export class StepBudget {
  private used: number;

  constructor(readonly limit: number, alreadyUsed = 0) {
    if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(alreadyUsed) || alreadyUsed < 0) {
      throw new RangeError("Step budget counts must be non-negative integers");
    }
    this.used = alreadyUsed;
  }

  get remaining(): number { return Math.max(0, this.limit - this.used); }

  /** One tool-capable model invocation. A final invocation with `toolChoice: "none"` needs no reservation. */
  reserve(): boolean {
    if (this.remaining === 0) return false;
    this.used++;
    return true;
  }
}

/** Counts a finished or stopped deep research part records about itself (`steps`, `searches`). */
function researchCount(part: { type?: string; toolName?: string; output?: unknown }, key: "steps" | "searches"): number {
  const name = part.type === "dynamic-tool" ? part.toolName : part.type?.startsWith("tool-") ? part.type.slice(5) : undefined;
  if (name !== "deep_research" || !part.output || typeof part.output !== "object") return 0;
  const value = (part.output as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

/** AI SDK emits one step-start part per model invocation; tool approvals alone add no model step. */
export function agentStepsInCurrentTurn(messages: Array<{ role: string; parts: unknown[] }>): number {
  let steps = 0;
  for (const message of messages) {
    if (message.role === "user") steps = 0;
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!part || typeof part !== "object") continue;
      if ((part as { type?: unknown }).type === "step-start") steps++;
      // Deep research runs its workers' steps inside the reply's allowance.
      steps += researchCount(part as { type?: string }, "steps");
    }
  }
  return steps;
}

/** Browser tools can continue one reply across requests. Recover its searches from the tool history. */
export function searchesInCurrentTurn(messages: Array<{ role: string; parts: unknown[] }>): number {
  let searches = 0;
  for (const message of messages) {
    if (message.role === "user") searches = 0;
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as { type?: string; toolName?: string; output?: unknown };
      const name = p.type === "dynamic-tool" ? p.toolName : p.type?.startsWith("tool-") ? p.type.slice(5) : undefined;
      if (name === "web_search") searches++;
      if (name === "delegate_task" && p.output && typeof p.output === "object") {
        const tools = (p.output as { tools?: unknown }).tools;
        if (Array.isArray(tools)) searches += tools.filter((tool) => tool === "web_search").length;
      }
      searches += researchCount(p, "searches");
    }
  }
  return searches;
}
