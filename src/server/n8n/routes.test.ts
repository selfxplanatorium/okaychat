import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Hono } from 'hono';
import type { AppEnv } from '../auth.js';
import { N8N_DEFAULTS, protocolPreset } from '../../shared/n8n-agents.js';
const dir = mkdtempSync(path.join(os.tmpdir(), 'okaychat-n8n-routes-'));
process.env.OKAYCHAT_DATA_DIR = dir;
process.env.OKAYCHAT_SECRET = 'routes-test-secret-that-is-at-least-32-characters';
const [{ db }, { n8nRoutes }, { sha256 }] = await Promise.all([import('../db.js'), import('./routes.js'), import('../crypto.js')]);
for (const [id, role] of [['owner', 'user'], ['other', 'user'], ['admin', 'admin']]) {
  db.prepare('INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)').run(id!, `${id}@test`, id!, 'x', role!, 1);
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha256(id!), id!, Date.now() + 600000);
}
const app = new Hono<AppEnv>().route('/agents', n8nRoutes()).route('/admin/agents', n8nRoutes(true));
const call = (url: string, method = 'GET', body?: unknown, user = 'owner') => app.request(url, { method, headers: { 'content-type': 'application/json', cookie: `okaychat_session=${user}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const config = { ...N8N_DEFAULTS, ...protocolPreset('webhook'), protocol: 'webhook', webhookUrl: 'https://example.test/hook?secret=hidden-url' };
const input = { name: 'Workflow', description: '', avatar: 'bot', enabled: true, config, authHeader: { name: 'X-API-Key', value: 'hidden-auth' } };
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

test('management authenticates, validates strictly and never exposes credentials to recipients', async () => {
  assert.equal((await app.request('/agents')).status, 401);
  assert.equal((await call('/admin/agents', 'GET')).status, 403);
  assert.equal((await call('/agents', 'POST', { ...input, unexpected: true })).status, 400);
  assert.equal((await call('/agents', 'POST', { ...input, authHeader: { name: 'Host', value: 'evil' } })).status, 400);
  assert.equal((await call('/agents', 'POST', { ...input, authHeader: { name: 'X-Key', value: 'secret\r\ninjected' } })).status, 400);
  const response = await call('/agents', 'POST', input);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const agent = await response.json() as { id: string; revision: number };
  assert.equal((await call(`/agents/${agent.id}`, 'GET', undefined, 'other')).status, 404);
  assert.equal((await call(`/agents/${agent.id}`, 'PUT', { ...input, revision: 99 })).status, 409);
  assert.equal((await call(`/agents/${agent.id}`, 'DELETE', { revision: 99 })).status, 409);
  const statuses = await call('/agents/status');
  assert.deepEqual(await statuses.json(), { statuses: [{ agentId: agent.id, revision: 1, state: 'unknown', checkedAt: null }] });
  assert.doesNotMatch(await (await call('/agents')).text(), /hidden-auth|hidden-url|webhookUrl/);
  assert.equal((await call('/agents/test', 'POST', { agentId: agent.id, revision: 1 }, 'other')).status, 404);
  assert.equal((await call('/agents/test', 'POST', { input: { ...input, config: { ...config, webhookUrl: 'http://127.0.0.1/hook' } } })).status, 400);
  assert.equal((await call('/agents/test', 'POST', { agentId: agent.id, revision: 99 })).status, 409);
  assert.equal((await call(`/agents/${agent.id}`, 'DELETE', { revision: 1 })).status, 200);
});

test('shared audience recipients cannot read configuration or test hidden credentials', async () => {
  const response = await call('/admin/agents', 'POST', { ...input, audience: { mode: 'selected', userIds: ['other'], groupIds: [] } }, 'admin');
  assert.equal(response.status, 201);
  const agent = await response.json() as { id: string };
  assert.deepEqual(await (await call('/agents')).json(), { agents: [] });
  const visible = await (await call('/agents', 'GET', undefined, 'other')).json() as { agents: Array<{ canManage: boolean }> };
  assert.equal(visible.agents[0]?.canManage, false);
  assert.equal((await call(`/agents/${agent.id}`, 'GET', undefined, 'other')).status, 404);
  assert.equal((await call('/agents/test', 'POST', { agentId: agent.id, revision: 1 }, 'other')).status, 404);
});
