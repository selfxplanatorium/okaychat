import type { UIMessage } from 'ai';
import type { AssistantMetadata } from '../../shared/types.js';
import { wrapUntrusted } from '../prompt-injection.js';

export function agentMetadata(message: UIMessage): AssistantMetadata | undefined {
  const raw = message.metadata as (AssistantMetadata & { custom?: AssistantMetadata }) | undefined;
  return raw?.custom ?? raw;
}
export function envelopeAgentHistory(messages: UIMessage[]): UIMessage[] {
  return messages.map(message => {
    const meta = agentMetadata(message);
    if (message.role !== 'assistant' || !(meta?.provenance?.kind === 'n8n_agent' || meta?.modelRef?.startsWith('n8n/'))) return message;
    return { ...message, parts: message.parts.map(part => part.type === 'text' ? { ...part, text: wrapUntrusted(part.text, { kind: 'n8n_agent', name: meta.agent?.name ?? 'Agent', server: meta.provenance?.agentId ?? meta.modelRef }).text } : part) };
  });
}
