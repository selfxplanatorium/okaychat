import type { ChatTargetInfo } from '../../shared/n8n-agents.js';
import { AppError } from '../errors.js';
import { agentIdOfRef, listAgentTargets, resolveAgent } from '../n8n/store.js';
import { listModels, resolveModel } from './providers.js';

export async function listChatTargets(userId: string): Promise<ChatTargetInfo[]> {
  return [...await listModels(userId), ...listAgentTargets(userId)];
}
export async function resolveChatTarget(userId: string, ref: string) {
  if (ref.startsWith('n8n/')) {
    const agentId = agentIdOfRef(ref);
    const agent = agentId && resolveAgent(userId, agentId);
    if (!agent) throw new AppError({ code: 'not_found' });
    if (!agent.enabled) throw new AppError({ code: 'validation', message: 'This agent is disabled.' });
    return { kind: 'agent' as const, agentId: agent.id };
  }
  return { kind: 'llm' as const, ...await resolveModel(userId, ref) };
}
