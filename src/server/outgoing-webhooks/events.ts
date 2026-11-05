import type { FailureCode, OutgoingEvent } from "../../shared/outgoing-webhooks.js";
import type { FinishReason } from "../../shared/generation.js";
import { admitEvent } from "./store.js";

/**
 * Curated source projections. Only ids, sequences, revisions, counts, finish states, and an optional
 * bounded visible-answer text cross this boundary. No prompt, tool, usage, title, provider, model,
 * attachment, artifact, or error prose is ever included.
 *
 * Every helper is called inside the source's own transaction; admission is synchronous and does no
 * network work. The worker only wakes after commit.
 */

export type TurnFinish = "stop" | "length" | "content-filter" | "other" | "unknown";

const turnFinish = (reason: FinishReason | null): TurnFinish => {
  switch (reason) {
    case "stop":
    case "length":
    case "content-filter":
      return reason;
    default:
      return reason === "unknown" ? "unknown" : "other";
  }
};

export function emitChatTurnCompleted(input: {
  userId: string;
  threadId: string;
  runId: string;
  assistantMessageId: string;
  finishReason: FinishReason | null;
  text?: string;
}): void {
  admitEvent({
    userId: input.userId,
    type: "chat.turn.completed",
    sourceKey: `turn:${input.runId}`,
    threadId: input.threadId,
    text: input.text,
    data: (text) => ({
      threadId: input.threadId,
      runId: input.runId,
      assistantMessageId: input.assistantMessageId,
      finishReason: turnFinish(input.finishReason),
      ...(text ? { text } : {}),
    }),
  });
}

export function emitChatTurnFailed(input: {
  userId: string;
  threadId: string;
  runId: string;
  assistantMessageId: string;
  failureCode: FailureCode;
}): void {
  admitEvent({
    userId: input.userId,
    type: "chat.turn.failed",
    sourceKey: `turn:${input.runId}`,
    threadId: input.threadId,
    data: () => ({
      threadId: input.threadId,
      runId: input.runId,
      assistantMessageId: input.assistantMessageId,
      failureCode: input.failureCode,
    }),
  });
}

export function emitScheduleCompleted(input: {
  userId: string;
  scheduleId: string;
  invocationId: string;
  startedAt: number;
  threadId: string | null;
  assistantMessageId: string | null;
  text?: string;
}): void {
  admitEvent({
    userId: input.userId,
    type: "schedule.run.completed",
    sourceKey: `schedule:${input.invocationId}`,
    threadId: input.threadId,
    occurredAt: input.startedAt,
    text: input.text,
    data: (text) => ({
      scheduleId: input.scheduleId,
      invocationId: input.invocationId,
      startedAt: input.startedAt,
      threadId: input.threadId,
      assistantMessageId: input.assistantMessageId,
      ...(text ? { text } : {}),
    }),
  });
}

export function emitScheduleFailed(input: {
  userId: string;
  scheduleId: string;
  invocationId: string;
  startedAt: number;
  threadId: string | null;
  assistantMessageId: string | null;
  failureCode: FailureCode;
}): void {
  admitEvent({
    userId: input.userId,
    type: "schedule.run.failed",
    sourceKey: `schedule:${input.invocationId}`,
    threadId: input.threadId,
    occurredAt: input.startedAt,
    data: () => ({
      scheduleId: input.scheduleId,
      invocationId: input.invocationId,
      startedAt: input.startedAt,
      threadId: input.threadId,
      assistantMessageId: input.assistantMessageId,
      failureCode: input.failureCode,
    }),
  });
}

interface ChannelBase {
  userId: string;
  channelId: string;
  messageId: string;
  messageSequence: number;
  revision: number;
  rootId: string | null;
  kind: "human" | "assistant";
}

export function emitChannelCreated(input: ChannelBase & { text?: string }): void {
  channelEvent(input, "channel.message.created", `channel:${input.messageId}:${input.revision}:created`, true);
}

export function emitChannelEdited(input: ChannelBase & { text?: string }): void {
  channelEvent(input, "channel.message.edited", `channel:${input.messageId}:${input.revision}:edited`, true);
}

/** Metadata-only tombstone. Never includes text, editor identity, or an old body. */
export function emitChannelDeleted(input: ChannelBase): void {
  channelEvent(input, "channel.message.deleted", `channel:${input.messageId}:${input.revision}:deleted`, false);
}

export function emitChannelMention(input: ChannelBase & { text?: string }): void {
  channelEvent(input, "channel.mention", `mention:${input.messageId}:${input.revision}`, true);
}

function channelEvent(
  input: ChannelBase & { text?: string },
  type: "channel.message.created" | "channel.message.edited" | "channel.message.deleted" | "channel.mention",
  sourceKey: string,
  withText: boolean,
): void {
  admitEvent({
    userId: input.userId,
    type,
    sourceKey,
    channelId: input.channelId,
    messageId: input.messageId,
    rootId: input.rootId,
    text: withText ? input.text : undefined,
    data: (text) => {
      const data = {
        channelId: input.channelId,
        messageId: input.messageId,
        messageSequence: input.messageSequence,
        revision: input.revision,
        rootId: input.rootId,
        kind: input.kind,
        ...(text && withText ? { text } : {}),
      };
      return data as OutgoingEvent<typeof type>["data"];
    },
  });
}

export function emitArchiveFinished(input: {
  userId: string;
  kind: "export" | "import";
  jobId: string;
  outcome: "completed" | "failed";
  chatCount: number;
  failureCode: FailureCode | null;
}): void {
  const type = input.kind === "export" ? "archive.export.finished" : "archive.import.finished";
  admitEvent({
    userId: input.userId,
    type,
    sourceKey: `archive:${input.kind}:${input.jobId}`,
    data: () => ({
      jobId: input.jobId,
      chatCount: input.chatCount,
      outcome: input.outcome,
      failureCode: input.failureCode,
    }),
  });
}
