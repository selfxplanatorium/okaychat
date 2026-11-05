import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { readUIMessageStream, type UIMessage } from 'ai';
import { N8N_DEFAULTS, protocolPreset } from '../shared/n8n-agents.js';
const directory = mkdtempSync(path.join(os.tmpdir(), 'okaychat-n8n-turn-'));
process.env.OKAYCHAT_DATA_DIR = directory;
process.env.OKAYCHAT_SECRET = 'n8n-test-only-secret-longer-than-32-characters';
const { db } = await import('./db.js');
const { agentBody } = await import('./n8n/turn.js');
const { createAgent } = await import('./n8n/store.js');
const { turnStream } = await import('./chat.js');
after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
const config = { ...N8N_DEFAULTS, ...protocolPreset('webhook'), protocol: 'webhook' as const, webhookUrl: 'https://example.test/webhook/chat', authHeader: null };

test('only conversation text enters webhook history and temporary mode sends latest text only', () => {
  const messages: UIMessage[] = [
    { id: 's', role: 'system', parts: [{ type: 'text', text: 'SYSTEM_SECRET' }] },
    { id: 'u', role: 'user', parts: [{ type: 'text', text: 'Remember nonce' }, { type: 'reasoning', text: 'HIDDEN' }] },
    { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Recorded' }], metadata: { modelRef: 'n8n/agt_old' } },
    { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Recall it' }] },
  ];
  const body = JSON.parse(agentBody(messages, config, 'opaque', false).body);
  assert.equal(body.message, 'Recall it');
  assert.equal(JSON.parse(body.history).length, 2);
  assert.match(body.history, /n8n_agent/);
  assert.doesNotMatch(JSON.stringify(body), /SYSTEM_SECRET|HIDDEN|opaque/);
  assert.deepEqual(JSON.parse(agentBody(messages, config, 'opaque', true).body), { message: 'Recall it' });
  const trigger = { ...config, protocol: 'chat-trigger' as const, ...protocolPreset('chat-trigger') };
  assert.deepEqual(JSON.parse(agentBody(messages, trigger, 'opaque', false).body), { action: 'sendMessage', chatInput: 'Recall it', sessionId: 'opaque' });
  assert.throws(() => agentBody([{ id: 'x', role: 'assistant', parts: [] }], config, 'opaque', false));
  assert.throws(() => agentBody([{ id: 'x', role: 'user', parts: [{ type: 'text', text: 'x' }, { type: 'file', mediaType: 'image/png', url: 'https://example.test/x' }] }], config, 'opaque', false));
});

test('real turnStream rejects attachments and inaccessible targets before network or model calls', async () => {
  db.prepare('INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)').run('u', 'u@example.test', 'U', 'unused', 'user', 1);
  const agent = createAgent({ kind: 'own', userId: 'u' }, { name: 'Workflow', description: '', avatar: 'bot', enabled: true, config });
  await assert.rejects(turnStream({ userId: 'u', threadId: 'tmp_t', modelRef: 'n8n/agt_missing', uiMessages: [] }), { code: 'not_found' });
  await assert.rejects(turnStream({ userId: 'u', threadId: 'tmp_t', modelRef: agent.ref, uiMessages: [{ id: 'u', role: 'user', parts: [{ type: 'file', mediaType: 'text/plain', url: 'data:text/plain,hello' }] }], deepResearch: true }), { code: 'validation' });
});

test('agent stream emits honest metadata, reuses remote session only on exact history, and records one request', async () => {
  const { agentTurnStream } = await import('./n8n/turn.js');
  const { agentUsage, getSession } = await import('./n8n/store.js');
  const { ensureThread } = await import('./threads.js');
  ensureThread('u', 'thread');
  const agent = createAgent({ kind: 'own', userId: 'u' }, { name: 'Remote', description: '', avatar: 'bot', enabled: true, config: { ...config, memoryMode: 'remote' } });
  const user: UIMessage = { id: 'user', role: 'user', parts: [{ type: 'text', text: 'Hello' }] };
  let calls = 0;
  const request = async (_config: typeof config, body: string, options?: { beforePost?: () => void }) => {
    options?.beforePost?.(); calls++;
    assert.equal(JSON.parse(body).message, 'Hello');
    return new Response('{"type":"begin"}\n{"type":"item","content":"Answer"}\n{"type":"end"}\n', { headers: { 'content-type': 'application/json' } });
  };
  let assistant: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream: agentTurnStream({ userId: 'u', threadId: 'thread', modelRef: agent.ref, uiMessages: [user] }, agent.id, request) })) assistant = message;
  assert.equal(calls, 1);
  assert.equal(assistant?.parts.filter(part => part.type === 'text').map(part => part.text).join(''), 'Answer');
  const meta = assistant?.metadata as Record<string, unknown>;
  assert.equal(meta.usageMode, 'agent');
  assert.equal(meta.usage, undefined);
  assert.equal(meta.cost, undefined);
  assert.ok(getSession('u', 'thread', agent.id));
  assert.equal(agentUsage('u').runs, 1);
  assert.doesNotMatch(JSON.stringify(assistant), /https:|sessionId|okc_/);
});
