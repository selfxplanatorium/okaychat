import type { ModelMessage } from "ai";
import type { Json, RunErrorCode } from "../../shared/custom-tools.js";
import { approvalRiskReason } from "../prompt-injection.js";
import type { Actor } from "../permissions/guard.js";
import { assertFeature, featureAllowed } from "../permissions/guard.js";
import { getThread } from "../threads.js";
import { hasActiveVoiceCall } from "../voice/routes.js";
import {
  approvedInvocation,
  prepareExecution,
  prepareHttpReview,
  validateToolInput,
  type ApprovedInvocation,
  type AcceptedRuntime,
} from "./execute.js";
import {
  chatExecutionKey,
  configBundle,
  denyRun,
  preparedInput,
  reviewOf,
  runByExecutionKey,
  setApprovalId,
  toolRow,
} from "./store.js";

// Chat approvals for HTTP custom tools. The server prepares a run and an exact request review, the SDK
// asks the user, and a replayed approval is accepted only against that existing prepared row. A client
// cannot invent an approval for a run the server never prepared.

export interface CustomToolIdentity {
  id: string;
  revision: number;
  kind: "python" | "http";
  toolKey: string;
}

export interface CustomToolTurnOptions {
  actor: Actor;
  threadId: string;
  logicalReplyId: string;
  sessionHash: string;
  runtime: AcceptedRuntime;
  sandboxAvailable: boolean;
  identities: ReadonlyMap<string, CustomToolIdentity>;
}

export type CustomApprovalOutcome =
  | { type: "approved" }
  | { type: "denied"; reason: string }
  | { type: "user-approval"; reason?: string }
  | undefined;

function fixedReason(code: RunErrorCode): string {
  switch (code) {
    case "approval_expired": return "This review expired. Prepare a new request.";
    case "approval_denied": return "The request was denied.";
    case "definition_changed": return "The tool changed. Review its current revision before running it.";
    case "disabled": return "This tool is not enabled in chats.";
    case "permission_denied": return "This account is not allowed to run this tool.";
    default: return "This request cannot run.";
  }
}

function formatReview(review: NonNullable<ReturnType<typeof reviewOf>>): string {
  const lines = [
    "Review request",
    `${review.method} ${review.url}`,
    ...review.headers.map((header) => `${header.name}: ${header.secretName ? `stored secret ${header.secretName}` : header.value ?? ""}`),
  ];
  if (review.body !== null) lines.push("", "Body:", review.body);
  lines.push("", review.warning === "outbound_destructive"
    ? "This sends data outside this app and may change or delete remote data."
    : "This sends the shown data outside this app.");
  return lines.join("\n");
}

function approvalResponses(stepMessages: ModelMessage[], toolCallId: string): Array<{ id: string; approved: boolean }> {
  const ids = new Set<string>();
  for (const message of stepMessages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-approval-request" && part.toolCallId === toolCallId) ids.add(part.approvalId);
    }
  }
  const out: Array<{ id: string; approved: boolean }> = [];
  for (const message of stepMessages) {
    if (message.role !== "tool" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-approval-response" && ids.has(part.approvalId)) out.push({ id: part.approvalId, approved: part.approved });
    }
  }
  return out;
}

export class CustomToolTurn {
  private readonly capabilities = new Map<string, ApprovedInvocation>();

  constructor(private readonly opts: CustomToolTurnOptions) {}

  takeCapability(toolCallId: string): ApprovedInvocation | undefined {
    return this.capabilities.get(toolCallId);
  }

  private assertLive(identity: CustomToolIdentity, requireEnabled: boolean): void {
    assertFeature(this.opts.actor, "customTools");
    const row = toolRow(this.opts.actor.userId, identity.id);
    if (!row || row.revision !== identity.revision) throw new Error("This tool changed.");
    if (requireEnabled && row.enabled !== 1) throw new Error("This tool is not enabled.");
    if (identity.kind === "python") assertFeature(this.opts.actor, "code");
    if (this.opts.runtime !== "interactiveChat" || hasActiveVoiceCall(this.opts.actor.userId, this.opts.threadId)) {
      throw new Error("Custom tools are not available in this runtime.");
    }
    if (!getThread(this.opts.actor.userId, this.opts.threadId)) throw new Error("Chat not found.");
  }

  /**
   * The custom branch of `toolApproval`, called before the generic replay handling. Returns undefined
   * for a tool this class does not own, so the generic approval policy keeps its behavior.
   */
  async resolveApproval(
    toolCall: { toolCallId: string; toolName: string; input: unknown },
    stepMessages: ModelMessage[],
    context: { unattended: boolean; tainted: boolean },
  ): Promise<CustomApprovalOutcome> {
    const identity = this.opts.identities.get(toolCall.toolName);
    if (!identity) return undefined;
    // Python has no external effect and no baseline approval; its output still taints later actions.
    if (identity.kind === "python") return undefined;
    const executionKey = chatExecutionKey(this.opts.logicalReplyId, toolCall.toolCallId);
    const current = toolRow(this.opts.actor.userId, identity.id);
    if (!current || current.revision !== identity.revision) return { type: "denied", reason: fixedReason("definition_changed") };
    if (!featureAllowed(this.opts.actor, "customTools")) return { type: "denied", reason: fixedReason("permission_denied") };
    if (current.enabled !== 1) return { type: "denied", reason: fixedReason("disabled") };
    const existing = runByExecutionKey(this.opts.actor.userId, executionKey);
    const responses = approvalResponses(stepMessages, toolCall.toolCallId);
    if (!responses.length) {
      if (context.unattended) {
        if (existing?.state === "prepared") denyRun(this.opts.actor.userId, existing.id);
        return { type: "denied", reason: "Nobody can approve this request in this run." };
      }
      if (existing && existing.state !== "prepared") return { type: "denied", reason: fixedReason("definition_changed") };
      let reviewText = "";
      try {
        const review = existing
          ? reviewOf(this.opts.actor.userId, existing.id)
          : prepareExecution({
              userId: this.opts.actor.userId,
              row: current,
              input: toolCall.input,
              source: "chat",
              executionKey,
              sessionHash: this.opts.sessionHash,
              threadId: this.opts.threadId,
            }).review;
        if (review) reviewText = formatReview(review);
      } catch {
        return { type: "denied", reason: "The input does not match this tool's schema." };
      }
      const bundle = configBundle(current);
      const risk = bundle?.config.kind === "http" && bundle.config.method !== "GET" && bundle.config.method !== "HEAD" ? "destructive" : "outbound";
      const reason = [context.tainted ? approvalRiskReason(risk, `"${current.name}"`) : "", reviewText].filter(Boolean).join("\n\n");
      return reason ? { type: "user-approval", reason } : { type: "user-approval" };
    }
    // A replayed decision must match a run the server prepared earlier in this reply.
    if (!existing || existing.state !== "prepared") {
      return { type: "denied", reason: fixedReason(existing?.state === "expired" ? "approval_expired" : "definition_changed") };
    }
    if (existing.session_hash !== this.opts.sessionHash || existing.thread_id !== this.opts.threadId) {
      denyRun(this.opts.actor.userId, existing.id);
      return { type: "denied", reason: "This approval belongs to another session." };
    }
    if (responses.every((response) => !response.approved)) {
      denyRun(this.opts.actor.userId, existing.id);
      return { type: "denied", reason: fixedReason("approval_denied") };
    }
    try {
      this.assertLive(identity, true);
      const input = validateToolInput(current, toolCall.input);
      const stored = preparedInput(this.opts.actor.userId, existing.id);
      if (!stored || prepareHttpReview(current, input).requestHash !== existing.request_hash) {
        denyRun(this.opts.actor.userId, existing.id);
        return { type: "denied", reason: fixedReason("definition_changed") };
      }
      if (existing.expires_at <= Date.now()) {
        denyRun(this.opts.actor.userId, existing.id, "expired");
        return { type: "denied", reason: fixedReason("approval_expired") };
      }
      const approvalId = responses.find((response) => response.approved)!.id;
      setApprovalId(this.opts.actor.userId, existing.id, approvalId);
      this.capabilities.set(toolCall.toolCallId, approvedInvocation(existing.id, existing.request_hash, existing.revision));
      return { type: "approved" };
    } catch {
      denyRun(this.opts.actor.userId, existing.id);
      return { type: "denied", reason: fixedReason("permission_denied") };
    }
  }

  /** The review a chat card may show. Only the owner and session that prepared it can read it. */
  reviewFor(toolCallId: string): ReturnType<typeof reviewOf> {
    const executionKey = chatExecutionKey(this.opts.logicalReplyId, toolCallId);
    const run = runByExecutionKey(this.opts.actor.userId, executionKey);
    if (!run || run.session_hash !== this.opts.sessionHash || run.thread_id !== this.opts.threadId) return null;
    return reviewOf(this.opts.actor.userId, run.id);
  }

  executionContext(toolCallId: string): { runId: string; requestHash: string; input: Json } | null {
    const executionKey = chatExecutionKey(this.opts.logicalReplyId, toolCallId);
    const run = runByExecutionKey(this.opts.actor.userId, executionKey);
    if (!run) return null;
    return { runId: run.id, requestHash: run.request_hash, input: preparedInput(this.opts.actor.userId, run.id) ?? ({} as Json) };
  }
}
