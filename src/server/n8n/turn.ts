import { createUIMessageStream, generateId, type UIMessage } from 'ai';
import type { AssistantMetadata } from '../../shared/types.js';
import { randomToken, sha256 } from '../crypto.js';
import { AppError } from '../errors.js';
import { wireErrorText } from '../provider-errors.js';
import { scanForInjection } from '../prompt-injection.js';
import { isTemporaryThread } from '../threads.js';
import type { TurnOptions } from '../chat.js';
import { envelopeAgentHistory } from './provenance.js';
import { parseAgentResponse } from './parser.js';
import { agentRequest } from './transport.js';
import { agentAccessible, deleteSession, getSession, recordRun, registerAgentRun, resolveAgent, saveSession } from './store.js';
import { noteAgentOutcome } from './status.js';

const locks = new Set<string>();
export function agentProjection(messages: UIMessage[]) {
  return messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ id: m.id, role: m.role, content: m.parts.filter(p => p.type === 'text').map(p => p.text).join('\n') }));
}
export function agentBody(messages: UIMessage[], config: NonNullable<ReturnType<typeof resolveAgent>>['config'], session: string, temporary: boolean) {
  const last = messages.at(-1);
  if (!last || last.role !== 'user' || last.parts.some(p => p.type !== 'text')) throw new AppError({ code: 'validation', message: 'Agents accept new text messages only.' });
  const text = last.parts.map(p => p.type === 'text' ? p.text : '').join('\n');
  if (!text.trim() || Buffer.byteLength(text) > 200000) throw new AppError({ code: 'validation' });
  const mode = temporary ? 'none' : config.memoryMode;
  const body: Record<string, string> = { [config.inputKey]: text };
  if (config.protocol === 'chat-trigger') body.action = 'sendMessage';
  if (config.protocol === 'chat-trigger' || mode === 'remote') body[config.sessionKey] = session;
  const history = agentProjection(envelopeAgentHistory(messages.slice(0, -1))).map(({ role, content }) => ({ role, content }));
  let truncated = false;
  while (history.length > 100 || Buffer.byteLength(JSON.stringify(history)) > 256 * 1024) { history.shift(); truncated = true; }
  if (mode === 'history') body[config.historyKey] = JSON.stringify(history);
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > 512 * 1024) throw new AppError({ code: 'validation' });
  return { body: serialized, historyTruncated: mode === 'history' && truncated };
}

export function agentTurnStream(opts: TurnOptions, agentId: string, requestAgent: typeof agentRequest = agentRequest) {
  const agent = resolveAgent(opts.userId, agentId);
  if (!agent) throw new AppError({ code: 'not_found' });
  if (!agent.enabled) throw new AppError({ code: 'validation' });
  const temporary = isTemporaryThread(opts.threadId);
  if (locks.has(opts.threadId)) throw new AppError({ code: 'conflict', message: 'This chat already has an agent request running.' });
  const previous = !temporary && agent.config.memoryMode === 'remote' ? getSession(opts.userId, opts.threadId, agentId) : null;
  const hash = sha256(JSON.stringify(agentProjection(opts.uiMessages.slice(0, -1))));
  const reuse = previous && previous.revision === agent.revision && previous.historyHash === hash;
  const session = reuse ? previous.sessionId : `okc_${randomToken()}`;
  const request = agentBody(opts.uiMessages, agent.config, session, temporary);
  const messageId = generateId();
  const runId = generateId();
  const controller = new AbortController();
  const abort = () => controller.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  if (opts.signal?.aborted) abort();
  locks.add(opts.threadId);
  const unregister = registerAgentRun({ viewerId: opts.userId, threadId: temporary ? null : opts.threadId, agentId, revision: agent.revision, controller });
  const metadata: AssistantMetadata = { modelRef: `n8n/${agentId}`, usageMode: 'agent', provenance: { kind: 'n8n_agent', agentId, name: agent.name }, agent: { id: agentId, name: agent.name, memoryMode: temporary ? 'none' : agent.config.memoryMode, historyTruncated: request.historyTruncated, memoryReset: !reuse && !temporary && agent.config.memoryMode === 'remote' && opts.uiMessages.length > 1 } };
  return createUIMessageStream({
    originalMessages: opts.uiMessages,
    onError: error => wireErrorText(error instanceof AppError ? error : new AppError({ code: 'agent_failed' })),
    execute: async ({ writer }) => {
      const started = Date.now();
      let attempted = false;
      let outcome: 'ok' | 'error' | 'aborted' = 'error';
      let text = '';
      const open = new Set<string>();
      const segments = new Map<string, string>();
      writer.write({ type: 'start', messageId, messageMetadata: metadata });
      writer.write({ type: 'start-step' });
      try {
        const response = await requestAgent(agent.config, request.body, { signal: controller.signal, beforePost: () => {
          if (!agentAccessible(opts.userId, agentId, agent.revision)) throw new AppError({ code: 'forbidden' });
          attempted = true;
        } });
        for await (const event of parseAgentResponse(response, { mode: agent.config.responseMode, responsePointer: agent.config.responsePointer, signal: controller.signal })) {
          controller.signal.throwIfAborted();
          if (event.type === 'mode') metadata.agent!.responseMode = event.mode;
          if (event.type === 'segment-start') { open.add(event.segmentId); writer.write({ type: 'text-start', id: event.segmentId }); }
          if (event.type === 'text') { text += event.text; segments.set(event.segmentId, (segments.get(event.segmentId) ?? '') + event.text); writer.write({ type: 'text-delta', id: event.segmentId, delta: event.text }); }
          if (event.type === 'segment-end') { open.delete(event.segmentId); writer.write({ type: 'text-end', id: event.segmentId }); }
        }
        controller.signal.throwIfAborted();
        if (!temporary && agent.config.memoryMode === 'remote') {
          const assistant: UIMessage = { id: messageId, role: 'assistant', parts: [...segments.values()].map(value => ({ type: 'text' as const, text: value })) };
          saveSession(opts.userId, opts.threadId, agentId, agent.revision, session, sha256(JSON.stringify(agentProjection([...opts.uiMessages, assistant]))));
        }
        outcome = 'ok';
        metadata.injection = scanForInjection(text);
        metadata.durationMs = Date.now() - started;
        metadata.agent!.outcome = outcome;
        writer.write({ type: 'message-metadata', messageMetadata: metadata });
        writer.write({ type: 'finish-step' });
        writer.write({ type: 'finish', finishReason: 'stop', messageMetadata: metadata });
      } catch (error) {
        outcome = controller.signal.aborted ? 'aborted' : 'error';
        if (!temporary) deleteSession(opts.userId, opts.threadId, agentId);
        for (const id of open) writer.write({ type: 'text-end', id });
        metadata.agent!.outcome = outcome;
        metadata.durationMs = Date.now() - started;
        writer.write({ type: 'message-metadata', messageMetadata: metadata });
        if (outcome === 'aborted') writer.write({ type: 'abort' });
        else throw error;
      } finally {
        unregister(); locks.delete(opts.threadId); opts.signal?.removeEventListener('abort', abort);
        if (attempted && !temporary) {
          recordRun({ id: runId, userId: opts.userId, threadId: opts.threadId, agentId, status: outcome, durationMs: Date.now() - started, inputBytes: Buffer.byteLength(request.body), outputBytes: Buffer.byteLength(text) });
          if (outcome !== 'aborted' && agentAccessible(opts.userId, agentId, agent.revision)) noteAgentOutcome({ viewerId: opts.userId, agentId, revision: agent.revision, ok: outcome === 'ok', checkedAt: Date.now(), latencyMs: Date.now() - started });
        }
      }
    },
  });
}
