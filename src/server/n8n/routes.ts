import { Hono } from 'hono';
import type { z } from 'zod';
import { requireAdmin, requireUser, type AppEnv } from '../auth.js';
import { randomToken } from '../crypto.js';
import { AppError, handleAppError } from '../errors.js';
import { readCapped } from '../public-fetch.js';
import { threadBusy } from '../thread-runs.js';
import { getThread } from '../threads.js';
import { agentInputSchema, sharedAgentInputSchema, agentUpdateSchema, sharedAgentUpdateSchema, deleteSchema, testSchema, validateAgentInput, fullConfig, nextAuthHeader } from './schemas.js';
import { createAgent, deleteAgent, deleteSession, getAgentDetail, listVisibleAgents, listSharedAgentsForAdmin, managedConfig, registerAgentRun, resolveAgent, updateAgent, type AgentScope } from './store.js';
import { agentStatus, noteAgentOutcome } from './status.js';
import { agentRequest } from './transport.js';
import { parseAgentResponse } from './parser.js';

const tests = new Set<string>();
const lastTest = new Map<string, number>();
export function n8nRoutes(shared = false) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => c.get('user') ? next() : requireUser(c, next));
  if (shared) app.use('*', requireAdmin);
  app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.onError(handleAppError);
  const scope = (userId: string): AgentScope => shared ? { kind: 'shared', adminId: userId } : { kind: 'own', userId };
  app.get('/', c => c.json({ agents: shared ? listSharedAgentsForAdmin() : listVisibleAgents(c.get('user').id) }));
  app.get('/status', c => {
    const userId = c.get('user').id;
    return c.json({ statuses: (shared ? listSharedAgentsForAdmin() : listVisibleAgents(userId)).map(a => agentStatus(userId, a.id, a.revision)) });
  });
  app.post('/test', async c => {
    const userId = c.get('user').id;
    const body = await parseBody(c.req.raw, testSchema);
    if (!shared && body.input?.audience) throw new AppError({ code: 'validation' });
    if (body.agentId && body.revision === undefined) throw new AppError({ code: 'validation' });
    const stored = body.agentId ? managedConfig(scope(userId), body.agentId, body.revision!) : null;
    if (!body.input && !stored) throw new AppError({ code: 'validation' });
    if (body.input) validateAgentInput(body.input);
    const config = body.input ? fullConfig(body.input.config, nextAuthHeader(stored?.config ?? null, body.input.config.webhookUrl, body.input.authHeader)) : stored!.config;
    if (tests.has(userId) || Date.now() - (lastTest.get(userId) ?? 0) < 5000) throw new AppError({ code: 'rate_limited', retryable: false });
    tests.add(userId); lastTest.set(userId, Date.now());
    // Bound cooldown bookkeeping even when accounts are created and deleted repeatedly.
    if (lastTest.size > 1000) for (const [id, time] of lastTest) if (Date.now() - time > 5000) lastTest.delete(id);
    const started = Date.now();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, c.req.raw.signal]);
    const unregister = body.agentId ? registerAgentRun({ viewerId: userId, agentId: body.agentId, revision: body.revision!, threadId: null, controller }) : () => {};
    try {
      const message = body.message ?? 'Reply with a short connection confirmation.';
      if (!message.trim()) throw new AppError({ code: 'validation' });
      const payload: Record<string, string> = { [config.inputKey]: message };
      if (config.protocol === 'chat-trigger') payload.action = 'sendMessage';
      if (config.protocol === 'chat-trigger' || config.memoryMode === 'remote') payload[config.sessionKey] = `okc_${randomToken()}`;
      if (config.memoryMode === 'history') payload[config.historyKey] = '';
      const response = await agentRequest({ ...config, timeoutMs: Math.min(config.timeoutMs, 30000), idleTimeoutMs: Math.min(config.idleTimeoutMs, 15000) }, JSON.stringify(payload), { signal, beforePost: () => { if (body.agentId) managedConfig(scope(userId), body.agentId, body.revision!); } });
      let text = ''; let mode = 'text';
      for await (const event of parseAgentResponse(response, { mode: config.responseMode, responsePointer: config.responsePointer, signal })) {
        if (event.type === 'text') text += event.text;
        if (event.type === 'mode') mode = event.mode;
      }
      if (body.agentId && !body.input) noteAgentOutcome({ viewerId: userId, agentId: body.agentId, revision: body.revision!, ok: true, checkedAt: Date.now(), latencyMs: Date.now() - started });
      return c.json({ ok: true, mode, preview: text.slice(0, 2000), truncated: text.length > 2000, durationMs: Date.now() - started });
    } catch (error) {
      if (body.agentId && !body.input && error instanceof AppError && !['aborted', 'validation', 'forbidden', 'storage_quota', 'conflict'].includes(error.code)) {
        noteAgentOutcome({ viewerId: userId, agentId: body.agentId, revision: body.revision!, ok: false, checkedAt: Date.now(), code: error.code });
      }
      throw error;
    } finally { unregister(); tests.delete(userId); }
  });
  app.post('/', async c => c.json(createAgent(scope(c.get('user').id), await parseBody(c.req.raw, shared ? sharedAgentInputSchema : agentInputSchema)), 201));
  app.get('/:id', c => c.json(getAgentDetail(scope(c.get('user').id), c.req.param('id'))));
  app.put('/:id', async c => {
    const body = await parseBody(c.req.raw, shared ? sharedAgentUpdateSchema : agentUpdateSchema);
    return c.json(updateAgent(scope(c.get('user').id), c.req.param('id'), body.revision, body));
  });
  app.delete('/:id', async c => { const body = await parseBody(c.req.raw, deleteSchema); deleteAgent(scope(c.get('user').id), c.req.param('id'), body.revision); return c.json({ ok: true }); });
  return app;
}
async function parseBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new AppError({ code: 'validation' });
  try {
    const bytes = await readCapped(new Response(request.body), 32 * 1024, 'Request too large');
    const result = schema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (!result.success) throw new AppError({ code: 'validation' });
    return result.data;
  } catch { throw new AppError({ code: 'validation', message: 'Check the agent settings and request size.' }); }
}
export const agentSessionRoutes = new Hono<AppEnv>().delete('/threads/:id/agents/n8n/:agentId/session', c => {
  const userId = c.get('user').id;
  const threadId = c.req.param('id');
  if (!getThread(userId, threadId) || !resolveAgent(userId, c.req.param('agentId'))) throw new AppError({ code: 'not_found' });
  if (threadBusy(threadId)) throw new AppError({ code: 'conflict' });
  deleteSession(userId, threadId, c.req.param('agentId'));
  return c.json({ ok: true });
});
