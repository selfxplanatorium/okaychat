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

/** AI SDK emits one step-start part per model invocation; tool approvals alone add no model step. */
export function agentStepsInCurrentTurn(messages: Array<{ role: string; parts: unknown[] }>): number {
  let steps = 0;
  for (const message of messages) {
    if (message.role === "user") steps = 0;
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "step-start") steps++;
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
    }
  }
  return searches;
}
