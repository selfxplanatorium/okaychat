import assert from 'node:assert/strict';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { Hono } from 'hono';
import { db } from '../db.js';
import { AppError, handleAppError } from '../errors.js';
import { requireUser, type AppEnv } from '../auth.js';
import { storageUsed } from '../quota.js';
import { IMPORT_LIMITS, type ImportItemsPage, type JobView, type PortableConversation, type PortableMessage } from '../../shared/chat-import.js';
import { conversationImportRoutes } from './routes.js';
import { cancelImport, confirmImport, createExport, maintainImports, receiveImport, recoverImports, resumeImport, startImports, stopImports } from './jobs.js';
import { admitJob, allItems, atomicFile, getJob, hashBytes, jobDir, jobView, readBounded, requireJob, stagingRoot } from './store.js';
import { buildArchive } from '../archive-export.js';
import { ARCHIVE_FORMAT, ARCHIVE_VERSION } from '../../shared/chat-archive.js';

const BASE = Date.UTC(2025, 0, 1);
const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function makeUser(id: string, options: { defaultModel?: string | null; limit?: number | null } = {}): void {
  db.prepare("INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,'unused','user',?)").run(id, `${id}@example.test`, id, Date.now());
  if (options.defaultModel !== undefined) {
    db.prepare('INSERT INTO user_settings (user_id,json) VALUES (?,?)').run(id, JSON.stringify({ defaultModel: options.defaultModel }));
  }
  if (options.limit !== undefined) db.prepare('UPDATE users SET storage_limit=? WHERE id=?').run(options.limit, id);
}
function makeProject(id: string, userId: string, name = 'Synthetic project'): void {
  db.prepare('INSERT INTO projects (id,user_id,name,created_at) VALUES (?,?,?,?)').run(id, userId, name, Date.now());
}
function nativeThread(userId: string, id: string, title: string | null, createdAt = BASE, updatedAt = BASE + 5000): void {
  db.prepare('INSERT INTO threads (id,user_id,title,status,model_ref,created_at,updated_at) VALUES (?,?,?,?,NULL,?,?)').run(id, userId, title, 'regular', createdAt, updatedAt);
}
function nativeMessage(threadId: string, id: string, parentId: string | null, role: 'user' | 'assistant', parts: unknown[], createdAt: number): void {
  db.prepare('INSERT INTO messages (id,thread_id,parent_id,format,content,created_at) VALUES (?,?,?,?,?,?)').run(id, threadId, parentId, 'ai-sdk/v6', JSON.stringify({ role, parts }), createdAt);
}
function message(id: string, role: PortableMessage['role'], text: string, createdAt: number, originalRole: string | null = null): PortableMessage {
  return { id, createdAt, role, originalRole, parts: [{ type: 'text', text }] };
}
function conversation(id: string, title: string | null, messages: PortableMessage[], over: Partial<PortableConversation> = {}): PortableConversation {
  const createdAt = over.createdAt ?? messages[0]?.createdAt ?? BASE;
  const updatedAt = over.updatedAt ?? messages.at(-1)?.createdAt ?? createdAt;
  return { source: { namespace: 'portable-v1', id }, title, createdAt, updatedAt, status: 'regular', messages, ...over };
}
function portableFile(conversations: PortableConversation[]) {
  return { format: 'okaychat.conversations' as const, version: 1 as const, exportedAt: Date.now(), conversations };
}
function mappingFile(sourceId: string, title: string | null = 'Synthetic <b>Title</b>') {
  return [{
    id: sourceId,
    title,
    create_time: 1699999999,
    update_time: 1700000003,
    current_node: 'n3',
    mapping: {
      root: { parent: null, children: ['n1'], message: null },
      n1: {
        parent: 'root', children: ['n2'],
        message: { id: `${sourceId}-m1`, author: { role: 'user' }, content: { content_type: 'multimodal_text', parts: ['Hello ', { content_type: 'image_asset_pointer', asset_pointer: 'pointer' }] }, create_time: 1700000000.4 },
      },
      n2: {
        parent: 'n1', children: ['n3'],
        message: { id: `${sourceId}-m2`, author: { role: 'system' }, content: { content_type: 'text', parts: ['<script>alert(1)</script>Private <b>system</b> note'] }, create_time: 1700000001 },
      },
      n3: {
        parent: 'n2', children: ['n4', 'n5'],
        message: { id: `${sourceId}-m3`, author: { role: 'assistant', channel: 'final' }, content: { content_type: 'text', parts: ['Selected reply'] }, create_time: 1700000002 },
      },
      n4: {
        parent: 'n3', children: [],
        message: { id: `${sourceId}-m4`, author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Discarded sibling'] }, create_time: 1700000002 },
      },
      n5: {
        parent: 'n3', children: [],
        message: { id: `${sourceId}-m5`, author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Discarded descendant'] }, create_time: 1700000002 },
      },
    },
  }];
}
const invalidTree = () => [{ id: 'bad-tree', current_node: 'a', mapping: { a: { parent: null, children: [], message: null }, b: { parent: null, children: [], message: null } } }];
const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

async function upload(userId: string, value: unknown) {
  const request = new Request('http://app/api/conversation-imports', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  return receiveImport(userId, request);
}
async function waitJob(userId: string, id: string, states: string[], timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = getJob(userId, id);
    if (row && states.includes(row.state)) return row;
    if (row && ['done', 'cancelled', 'failed', 'expired'].includes(row.state)) {
      throw new Error(`job ${id} ended in ${row.state} (${row.error_code}) while waiting for ${states.join('|')}`);
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for job ${id} in ${row?.state ?? 'missing'}`);
    await sleep();
  }
}
function thrown(fn: () => unknown): AppError {
  try { fn(); } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected an AppError');
}
async function rejected(fn: () => Promise<unknown>): Promise<AppError> {
  try { await fn(); } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected an AppError');
}
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

// The route module prefixes /conversation-imports itself, so the test app mounts it under /api.
const app = new Hono<AppEnv>()
  .use('*', async (c, next) => {
    const id = c.req.header('x-test-user') ?? 'lifecycle-default';
    c.set('user', { id, email: `${id}@example.test`, name: id, role: 'user' });
    c.set('session', 'lifecycle-test-session');
    await next();
  })
  .route('/api', conversationImportRoutes)
  .onError(handleAppError);
const anonymous = new Hono<AppEnv>().use('*', requireUser).route('/api', conversationImportRoutes).onError(handleAppError);

function api(method: string, route: string, options: { user?: string; body?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(options.user ? { 'x-test-user': options.user } : {}), ...options.headers };
  if (options.body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  const base = 'http://app/api/conversation-imports';
  return app.request(route === '/' ? base : `${base}${route}`, { method, headers, ...(options.body !== undefined ? { body: options.body } : {}) });
}
async function uploadRoute(userId: string, value: unknown) {
  const response = await api('POST', '/', { user: userId, body: JSON.stringify(value) });
  assert.equal(response.status, 202);
  return (await response.json()) as { jobId: string; expiresAt: number };
}
async function rawUploadRoute(userId: string, body: string) {
  const response = await app.request('http://app/api/conversation-imports', {
    method: 'POST',
    headers: { 'x-test-user': userId, 'content-type': 'application/json' },
    body,
  });
  assert.equal(response.status, 202);
  return (await response.json()) as { jobId: string; expiresAt: number };
}
async function json<T>(response: Response): Promise<T> { return (await response.json()) as T; }

after(async () => {
  await stopImports();
  db.close();
});

test('upload returns 202, parses off the request, and exposes owner-only preview counts, dates, warnings and cursors', async () => {
  makeUser('life-route');
  makeUser('life-other');
  const uploaded = await uploadRoute('life-route', [...mappingFile('map-a'), ...mappingFile('map-b'), ...mappingFile('map-c'), ...invalidTree()]);
  assert.ok(uploaded.jobId.startsWith('cij_'));
  assert.ok(uploaded.expiresAt > Date.now());

  const initial = await api('GET', `/${uploaded.jobId}`, { user: 'life-route' });
  assert.equal(initial.status, 200);
  const initialView = await json<JobView>(initial);
  assert.ok(['validating', 'ready'].includes(initialView.state));
  assert.equal(initialView.canCancel, true);

  await waitJob('life-route', uploaded.jobId, ['ready']);
  const ready = await json<JobView>(await api('GET', `/${uploaded.jobId}`, { user: 'life-route' }));
  assert.equal(ready.state, 'ready');
  assert.equal(ready.adapter, 'mapping-v1');
  assert.equal(ready.adapterVersion, 1);
  assert.equal(ready.projectId, null);
  assert.equal(ready.modelRef, null);
  assert.deepEqual(ready.dateRange, { from: 1699999999000, to: 1700000003000 });
  assert.equal(ready.counts.total, 4);
  assert.equal(ready.counts.valid, 3);
  assert.equal(ready.counts.invalid, 1);
  assert.equal(ready.counts.selected, 0);
  assert.equal(ready.counts.processed, 0);
  assert.ok(ready.warnings.some((warning) => warning.code === 'model_unset'));
  assert.ok(ready.normalizedBytes > 0);

  const first = await json<ImportItemsPage>(await api('GET', `/${uploaded.jobId}/items?limit=2`, { user: 'life-route' }));
  assert.equal(first.items.length, 2);
  assert.deepEqual(first.items.map((item) => item.ordinal), [0, 1]);
  assert.ok(first.nextCursor);
  const selected = first.items[0]!;
  assert.equal(selected.title, 'Synthetic Title');
  assert.equal(selected.state, 'valid');
  assert.equal(selected.selectable, true);
  assert.equal(selected.messageCount, 3);
  assert.equal(selected.quarantineCount, 1);
  assert.equal(selected.omittedAttachmentCount, 1);
  assert.equal(selected.discardedBranchMessages, 2);
  assert.equal(selected.createdAt, 1699999999000);
  assert.equal(selected.updatedAt, 1700000003000);
  assert.equal(selected.errorCode, null);
  assert.equal(selected.duplicate, null);
  assert.deepEqual(selected.warnings.filter((warning) => ['branches_omitted', 'roles_quarantined', 'attachments_missing', 'html_removed'].includes(warning.code)).map((warning) => warning.code).sort(), ['attachments_missing', 'branches_omitted', 'html_removed', 'roles_quarantined']);
  assert.equal(selected.warnings.find((warning) => warning.code === 'branches_omitted')?.count, 2);

  const second = await json<ImportItemsPage>(await api('GET', `/${uploaded.jobId}/items?after=${encodeURIComponent(first.nextCursor!)}&limit=2`, { user: 'life-route' }));
  assert.deepEqual(second.items.map((item) => item.ordinal), [2, 3]);
  assert.equal(second.nextCursor, null);
  const rejectedItem = second.items[1]!;
  assert.equal(rejectedItem.state, 'invalid');
  assert.equal(rejectedItem.selectable, false);
  assert.equal(rejectedItem.errorCode, 'invalid_tree');

  const invalidCursor = await api('GET', `/${uploaded.jobId}/items?after=not-a-cursor`, { user: 'life-route' });
  assert.equal(invalidCursor.status, 422);

  const foreign = await uploadRoute('life-other', portableFile([
    conversation('other-only', 'Other', [message('other-m', 'user', 'Other text', BASE)]),
    conversation('other-second', 'Other second', [message('other-second-m', 'user', 'Other second text', BASE + 1000)]),
  ]));
  await waitJob('life-other', foreign.jobId, ['ready']);
  const foreignPage = await json<ImportItemsPage>(await api('GET', `/${foreign.jobId}/items?limit=1`, { user: 'life-other' }));
  assert.ok(foreignPage.nextCursor);
  const crossCursor = await api('GET', `/${uploaded.jobId}/items?after=${encodeURIComponent(foreignPage.nextCursor!)}`, { user: 'life-route' });
  assert.equal(crossCursor.status, 422);

  for (const route of [`/${uploaded.jobId}`, `/${uploaded.jobId}/items`]) {
    assert.equal((await api('GET', route, { user: 'life-other' })).status, 404);
  }
  assert.equal((await api('POST', `/${uploaded.jobId}/confirm`, { user: 'life-other', body: JSON.stringify({ itemKeys: [selected.itemKey], projectId: null }) })).status, 404);
  assert.equal((await api('DELETE', `/${uploaded.jobId}`, { user: 'life-other' })).status, 404);
  assert.equal((await api('GET', `/${uploaded.jobId}/download`, { user: 'life-route' })).status, 409);

  const cancelled = await api('DELETE', `/${uploaded.jobId}`, { user: 'life-route' });
  assert.equal(cancelled.status, 200);
  assert.equal((await json<JobView>(cancelled)).state, 'cancelled');
  await api('DELETE', `/${foreign.jobId}`, { user: 'life-other' });
});

test('upload rejects auth, compression, media, compression magic and parser failures with safe wire errors', async () => {
  assert.equal((await anonymous.request('http://app/api/conversation-imports', { method: 'GET' })).status, 401);
  makeUser('life-reject');
  assert.equal((await api('POST', '/', { user: 'life-reject', body: '[]', headers: { 'content-encoding': 'gzip' } })).status, 415);
  assert.equal(count('SELECT count(*) AS n FROM conversation_import_jobs WHERE user_id=?', 'life-reject'), 0);

  const zip = await app.request('http://app/api/conversation-imports', {
    method: 'POST',
    headers: { 'x-test-user': 'life-reject', 'content-type': 'application/octet-stream' },
    body: new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00]),
  });
  assert.equal(zip.status, 415);
  assert.ok(!existsSync(path.join(stagingRoot, 'life-reject')) || readdirSync(path.join(stagingRoot, 'life-reject')).every((entry) => getJob('life-reject', entry)?.state === 'failed'));

  const invalidJson = await rawUploadRoute('life-reject', '{');
  await waitJob('life-reject', invalidJson.jobId, ['failed']);
  const invalidView = await json<JobView>(await api('GET', `/${invalidJson.jobId}`, { user: 'life-reject' }));
  assert.equal(invalidView.errorCode, 'invalid_json');
  assert.equal(invalidView.counts.total, 0);
  assert.ok(!existsSync(jobDir(requireJob('life-reject', invalidJson.jobId))));

  const empty = await uploadRoute('life-reject', []);
  await waitJob('life-reject', empty.jobId, ['failed']);
  assert.equal((await json<JobView>(await api('GET', `/${empty.jobId}`, { user: 'life-reject' }))).errorCode, 'empty_conversation');

  const unsupported = await uploadRoute('life-reject', { hello: 1 });
  await waitJob('life-reject', unsupported.jobId, ['failed']);
  assert.equal((await json<JobView>(await api('GET', `/${unsupported.jobId}`, { user: 'life-reject' }))).errorCode, 'unsupported_format');

  const duplicate = await uploadRoute('life-reject', [...mappingFile('same-source'), ...mappingFile('same-source')]);
  await waitJob('life-reject', duplicate.jobId, ['failed']);
  const duplicateView = await json<JobView>(await api('GET', `/${duplicate.jobId}`, { user: 'life-reject' }));
  assert.equal(duplicateView.errorCode, 'invalid_conversation');
  const duplicateItems = await json<ImportItemsPage>(await api('GET', `/${duplicate.jobId}/items`, { user: 'life-reject' }));
  assert.deepEqual(duplicateItems.items.map((item) => item.errorCode), ['duplicate_source', 'duplicate_source']);
  assert.deepEqual(duplicateItems.items.map((item) => item.state), ['invalid', 'invalid']);
});

test('confirm imports selected conversations into the project with source times, model snapshot and no side effects', async () => {
  makeUser('life-import', { defaultModel: 'test/model-a' });
  makeProject('life-project', 'life-import');
  const alpha = conversation('life-p-alpha', 'Alpha', [
    message('alpha-user', 'user', 'Alpha retained', BASE + 2000),
    message('alpha-reply', 'assistant', 'Alpha reply', BASE + 1000),
  ], { createdAt: BASE + 1000, updatedAt: BASE + 3000 });
  const beta = conversation('life-p-beta', null, [
    message('beta-quarantine', 'quarantine', 'Hidden developer instruction', BASE + 5000, 'developer'),
    message('beta-reply', 'assistant', 'Beta reply', BASE + 6000),
  ], { createdAt: BASE + 5000, updatedAt: BASE + 6000, status: 'archived' });
  const uploaded = await uploadRoute('life-import', portableFile([alpha, beta]));
  await waitJob('life-import', uploaded.jobId, ['ready']);

  const ready = await json<JobView>(await api('GET', `/${uploaded.jobId}`, { user: 'life-import' }));
  assert.equal(ready.modelRef, 'test/model-a');
  const preview = await json<ImportItemsPage>(await api('GET', `/${uploaded.jobId}/items`, { user: 'life-import' }));
  assert.equal(preview.items.length, 2);
  assert.ok(preview.items.every((item) => item.state === 'valid' && item.selectable));

  const confirmed = await api('POST', `/${uploaded.jobId}/confirm`, {
    user: 'life-import',
    body: JSON.stringify({ itemKeys: preview.items.map((item) => item.itemKey), projectId: 'life-project' }),
  });
  assert.equal(confirmed.status, 202);
  await waitJob('life-import', uploaded.jobId, ['done']);

  const done = await json<JobView>(await api('GET', `/${uploaded.jobId}`, { user: 'life-import' }));
  assert.equal(done.state, 'done');
  assert.deepEqual({ imported: done.counts.imported, failed: done.counts.failed, pending: done.counts.pending, processed: done.counts.processed }, { imported: 2, failed: 0, pending: 0, processed: 2 });
  assert.equal(done.canCancel, false);

  const threads = db.prepare('SELECT id,title,status,model_ref,project_id,created_at,updated_at,memory_disabled,preferred_head,memory_cursor FROM threads WHERE user_id=? ORDER BY created_at').all('life-import') as Array<Record<string, unknown>>;
  assert.equal(threads.length, 2);
  const alphaThread = threads.find((thread) => thread.title === 'Alpha')!;
  const betaThread = threads.find((thread) => thread.title === null)!;
  assert.equal(alphaThread.project_id, 'life-project');
  assert.equal(alphaThread.model_ref, 'test/model-a');
  assert.equal(alphaThread.status, 'regular');
  assert.equal(alphaThread.created_at, alpha.createdAt);
  assert.equal(alphaThread.updated_at, alpha.updatedAt);
  assert.equal(alphaThread.memory_disabled, 1);
  assert.equal(betaThread.status, 'archived');

  const rows = db.prepare('SELECT id,parent_id,created_at,content,bytes,imported FROM messages WHERE thread_id=? ORDER BY rowid').all(String(alphaThread.id)) as Array<{ id: string; parent_id: string | null; created_at: number; content: string; bytes: number; imported: number }>;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.created_at), [BASE + 2000, BASE + 1000]);
  assert.equal(rows[1]!.parent_id, rows[0]!.id);
  assert.ok(rows.every((row) => row.imported === 1));
  assert.ok(rows.every((row) => JSON.parse(row.content).metadata.custom.importedTranscript.version === 1));
  assert.equal(alphaThread.preferred_head, rows.at(-1)!.id);
  assert.equal(alphaThread.memory_cursor, rows.at(-1)!.id);

  const quarantineRows = db.prepare('SELECT content FROM messages WHERE thread_id=? ORDER BY rowid').all(String(betaThread.id)) as Array<{ content: string }>;
  assert.ok(quarantineRows[0]!.content.includes('data-imported-quarantine'));
  assert.equal(count("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'retained'"), 1);
  assert.equal(count("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'Hidden'"), 0);
  assert.equal(count("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'Discarded'"), 0);

  assert.equal(count('SELECT count(*) AS n FROM usage WHERE user_id=?', 'life-import'), 0);
  assert.equal(count('SELECT count(*) AS n FROM generation_runs r JOIN threads t ON t.id=r.thread_id WHERE t.user_id=?', 'life-import'), 0);
  assert.equal(count('SELECT count(*) AS n FROM memories WHERE user_id=?', 'life-import'), 0);
  assert.equal(count('SELECT count(*) AS n FROM artifacts a JOIN threads t ON t.id=a.thread_id WHERE t.user_id=?', 'life-import'), 0);
  assert.equal(count('SELECT count(*) AS n FROM uploads WHERE user_id=?', 'life-import'), 0);
  assert.equal(count('SELECT count(*) AS n FROM images WHERE user_id=?', 'life-import'), 0);
  assert.equal(count('SELECT count(*) AS n FROM turn_context WHERE user_id=?', 'life-import'), 0);
  assert.equal(count('SELECT count(*) AS n FROM shares WHERE user_id=?', 'life-import'), 0);
  assert.equal(count('SELECT count(*) AS n FROM schedules WHERE user_id=?', 'life-import'), 0);

  const stored = count('SELECT COALESCE(SUM(m.bytes),0) AS n FROM messages m JOIN threads t ON t.id=m.thread_id WHERE t.user_id=?', 'life-import');
  const identities = count('SELECT COALESCE(SUM(2048+title_bytes),0) AS n FROM conversation_source_ids WHERE user_id=?', 'life-import');
  assert.equal(storageUsed('life-import'), stored + identities);
  assert.equal(count('SELECT reservation_bytes AS n FROM conversation_import_jobs WHERE id=?', uploaded.jobId), 0);
  assert.ok(!existsSync(jobDir(requireJob('life-import', uploaded.jobId))));

  const idempotent = await api('POST', `/${uploaded.jobId}/confirm`, {
    user: 'life-import',
    body: JSON.stringify({ itemKeys: preview.items.map((item) => item.itemKey), projectId: 'life-project' }),
  });
  assert.equal(idempotent.status, 200);
  assert.equal((await json<JobView>(idempotent)).state, 'done');
  assert.equal(count('SELECT count(*) AS n FROM threads WHERE user_id=?', 'life-import'), 2);

  const different = await api('POST', `/${uploaded.jobId}/confirm`, { user: 'life-import', body: JSON.stringify({ itemKeys: [preview.items[0]!.itemKey], projectId: null }) });
  assert.equal(different.status, 409);
  assert.equal((await json<{ code: string }>(different)).code, 'validation');
});

test('unchanged duplicates link the owned chat, changed sources warn without overwriting, and deleting a chat permits re-import', async () => {
  makeUser('life-dedupe');
  makeUser('life-dedupe-other');
  const source = conversation('dedupe-source', 'Dedupe', [message('dedupe-m', 'user', 'Duplicate text', BASE)]);
  const file = portableFile([source]);

  const firstUpload = await uploadRoute('life-dedupe', file);
  await waitJob('life-dedupe', firstUpload.jobId, ['ready']);
  const firstItems = await json<ImportItemsPage>(await api('GET', `/${firstUpload.jobId}/items`, { user: 'life-dedupe' }));
  await api('POST', `/${firstUpload.jobId}/confirm`, { user: 'life-dedupe', body: JSON.stringify({ itemKeys: [firstItems.items[0]!.itemKey], projectId: null }) });
  await waitJob('life-dedupe', firstUpload.jobId, ['done']);
  const firstResult = await json<ImportItemsPage>(await api('GET', `/${firstUpload.jobId}/items`, { user: 'life-dedupe' }));
  const threadId = firstResult.items[0]!.result!.threadId;

  const sameUpload = await uploadRoute('life-dedupe', file);
  await waitJob('life-dedupe', sameUpload.jobId, ['ready']);
  const sameItems = await json<ImportItemsPage>(await api('GET', `/${sameUpload.jobId}/items`, { user: 'life-dedupe' }));
  assert.equal(sameItems.items[0]!.state, 'duplicate');
  assert.deepEqual(sameItems.items[0]!.duplicate, { threadId, changed: false });
  const rejectedDuplicate = await api('POST', `/${sameUpload.jobId}/confirm`, { user: 'life-dedupe', body: JSON.stringify({ itemKeys: [sameItems.items[0]!.itemKey], projectId: null }) });
  assert.equal(rejectedDuplicate.status, 422);
  await api('DELETE', `/${sameUpload.jobId}`, { user: 'life-dedupe' });

  const changed = { ...source, title: 'Changed title' };
  const changedUpload = await uploadRoute('life-dedupe', portableFile([changed]));
  await waitJob('life-dedupe', changedUpload.jobId, ['ready']);
  const changedItems = await json<ImportItemsPage>(await api('GET', `/${changedUpload.jobId}/items`, { user: 'life-dedupe' }));
  assert.equal(changedItems.items[0]!.state, 'duplicate');
  assert.deepEqual(changedItems.items[0]!.duplicate, { threadId, changed: true });
  assert.equal(changedItems.items[0]!.errorCode, 'source_changed');
  assert.ok(changedItems.items[0]!.warnings.some((warning) => warning.code === 'source_changed'));
  assert.equal(count('SELECT count(*) AS n FROM threads WHERE user_id=?', 'life-dedupe'), 1);
  await api('DELETE', `/${changedUpload.jobId}`, { user: 'life-dedupe' });

  const otherUpload = await uploadRoute('life-dedupe-other', file);
  await waitJob('life-dedupe-other', otherUpload.jobId, ['ready']);
  const otherItems = await json<ImportItemsPage>(await api('GET', `/${otherUpload.jobId}/items`, { user: 'life-dedupe-other' }));
  assert.equal(otherItems.items[0]!.state, 'valid');
  await api('POST', `/${otherUpload.jobId}/confirm`, { user: 'life-dedupe-other', body: JSON.stringify({ itemKeys: [otherItems.items[0]!.itemKey], projectId: null }) });
  await waitJob('life-dedupe-other', otherUpload.jobId, ['done']);
  const otherResult = await json<ImportItemsPage>(await api('GET', `/${otherUpload.jobId}/items`, { user: 'life-dedupe-other' }));
  assert.notEqual(otherResult.items[0]!.result!.threadId, threadId);

  db.prepare('DELETE FROM threads WHERE id=?').run(threadId);
  const reimport = await uploadRoute('life-dedupe', file);
  await waitJob('life-dedupe', reimport.jobId, ['ready']);
  const reimportItems = await json<ImportItemsPage>(await api('GET', `/${reimport.jobId}/items`, { user: 'life-dedupe' }));
  assert.equal(reimportItems.items[0]!.state, 'valid');
  await api('POST', `/${reimport.jobId}/confirm`, { user: 'life-dedupe', body: JSON.stringify({ itemKeys: [reimportItems.items[0]!.itemKey], projectId: null }) });
  await waitJob('life-dedupe', reimport.jobId, ['done']);
  assert.equal(count('SELECT count(*) AS n FROM threads WHERE user_id=?', 'life-dedupe'), 1);
});

test('cancel between conversation commits keeps finished chats and cancels the rest', async () => {
  makeUser('life-cancel');
  const file = portableFile([
    conversation('cancel-a', 'Cancel A', [message('cancel-a-m', 'user', 'First conversation', BASE)]),
    conversation('cancel-b', 'Cancel B', [message('cancel-b-m', 'user', 'Second conversation', BASE + 1000)]),
    conversation('cancel-c', 'Cancel C', [message('cancel-c-m', 'user', 'Third conversation', BASE + 2000)]),
  ]);
  const uploaded = await uploadRoute('life-cancel', file);
  await waitJob('life-cancel', uploaded.jobId, ['ready']);
  const items = await json<ImportItemsPage>(await api('GET', `/${uploaded.jobId}/items`, { user: 'life-cancel' }));

  await api('POST', `/${uploaded.jobId}/confirm`, { user: 'life-cancel', body: JSON.stringify({ itemKeys: items.items.map((item) => item.itemKey), projectId: null }) });
  // The worker commits the first conversation before its first yield; cancel before it resumes.
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = cancelImport('life-cancel', uploaded.jobId);
  assert.ok(['cancelling', 'cancelled'].includes(cancelled.state));
  await waitJob('life-cancel', uploaded.jobId, ['cancelled']);

  const view = jobView(requireJob('life-cancel', uploaded.jobId));
  assert.equal(view.state, 'cancelled');
  assert.equal(view.counts.imported, 1);
  assert.equal(view.counts.cancelled, 2);
  assert.equal(view.counts.pending, 0);
  assert.equal(view.counts.processed, 3);
  const itemRows = allItems(uploaded.jobId);
  assert.deepEqual(itemRows.map((item) => item.state), ['imported', 'cancelled', 'cancelled']);
  assert.equal(count('SELECT count(*) AS n FROM threads WHERE user_id=?', 'life-cancel'), 1);
  const importedThread = itemRows[0]!.thread_id!;
  assert.equal(count('SELECT count(*) AS n FROM messages WHERE thread_id=?', importedThread), 1);
  assert.equal((await api('DELETE', `/${uploaded.jobId}`, { user: 'life-cancel' })).status, 200);
});

test('quota exhaustion pauses without rolling back committed chats, resume imports the rest once, and admission refuses a full account', async () => {
  makeUser('life-quota');
  const file = portableFile([
    conversation('quota-a', 'Quota A', [message('quota-a-m', 'user', 'Quota first', BASE)]),
    conversation('quota-b', 'Quota B', [message('quota-b-m', 'user', 'Quota second', BASE + 1000)]),
  ]);
  const uploaded = await uploadRoute('life-quota', file);
  await waitJob('life-quota', uploaded.jobId, ['ready']);
  const items = await json<ImportItemsPage>(await api('GET', `/${uploaded.jobId}/items`, { user: 'life-quota' }));

  const confirmed = confirmImport('life-quota', uploaded.jobId, items.items.map((item) => item.itemKey), null);
  assert.equal(confirmed.state, 'queued');
  // Shrink the account below the already-reserved admission before the worker commits anything.
  db.prepare('UPDATE users SET storage_limit=? WHERE id=?').run(storageUsed('life-quota') - 1, 'life-quota');
  const paused = await waitJob('life-quota', uploaded.jobId, ['paused']);
  assert.equal(paused.error_code, 'storage_quota');
  assert.equal(paused.reservation_bytes, IMPORT_LIMITS.reservationBytes);
  assert.deepEqual(allItems(uploaded.jobId).map((item) => item.state), ['pending', 'pending']);
  assert.equal(count('SELECT count(*) AS n FROM threads WHERE user_id=?', 'life-quota'), 0);
  assert.equal(count('SELECT count(*) AS n FROM conversation_source_ids WHERE user_id=?', 'life-quota'), 0);
  assert.equal(jobView(paused).canResume, true);
  assert.equal(jobView(paused).counts.pending, 2);

  db.prepare('UPDATE users SET storage_limit=NULL WHERE id=?').run('life-quota');
  const resumed = await api('POST', `/${uploaded.jobId}/resume`, { user: 'life-quota', body: '{}' });
  assert.equal(resumed.status, 202);
  await waitJob('life-quota', uploaded.jobId, ['done']);
  assert.deepEqual(allItems(uploaded.jobId).map((item) => item.state), ['imported', 'imported']);
  assert.equal(count('SELECT count(*) AS n FROM threads WHERE user_id=?', 'life-quota'), 2);
  assert.equal(count('SELECT reservation_bytes AS n FROM conversation_import_jobs WHERE id=?', uploaded.jobId), 0);
  const stored = count('SELECT COALESCE(SUM(m.bytes),0) AS n FROM messages m JOIN threads t ON t.id=m.thread_id WHERE t.user_id=?', 'life-quota');
  const identities = count('SELECT COALESCE(SUM(2048+title_bytes),0) AS n FROM conversation_source_ids WHERE user_id=?', 'life-quota');
  assert.equal(storageUsed('life-quota'), stored + identities);

  makeUser('life-quota-tiny', { limit: 1024 });
  const refused = await api('POST', '/', { user: 'life-quota-tiny', body: JSON.stringify(file) });
  assert.equal(refused.status, 413);
  assert.equal((await json<{ code: string }>(refused)).code, 'storage_quota');
  assert.equal(count('SELECT count(*) AS n FROM conversation_import_jobs WHERE user_id=?', 'life-quota-tiny'), 0);
  assert.ok(!existsSync(path.join(stagingRoot, 'life-quota-tiny')));
});

test('restart recovery keeps ready previews, revalidates, requeues confirmed work and fails missing or tampered staging', async () => {
  makeUser('life-restart-a');
  const file = portableFile([
    conversation('restart-a-1', 'Restart A1', [message('restart-a-1-m', 'user', 'Restart one', BASE)]),
    conversation('restart-a-2', 'Restart A2', [message('restart-a-2-m', 'user', 'Restart two', BASE + 1000)]),
  ]);
  const uploaded = await uploadRoute('life-restart-a', file);
  await waitJob('life-restart-a', uploaded.jobId, ['ready']);
  const before = allItems(uploaded.jobId).map((item) => `${item.item_key}:${item.state}`);
  recoverImports();
  assert.equal(getJob('life-restart-a', uploaded.jobId)!.state, 'ready');
  assert.deepEqual(allItems(uploaded.jobId).map((item) => `${item.item_key}:${item.state}`), before);

  const restartKeys = allItems(uploaded.jobId).map((item) => item.item_key).sort();
  db.prepare("UPDATE conversation_import_items SET state='pending',selected=1 WHERE job_id=?").run(uploaded.jobId);
  db.prepare("UPDATE conversation_import_jobs SET state='importing',confirmation_sha256=?,selection_json=?,project_id=NULL WHERE id=?")
    .run(hashBytes(JSON.stringify({ itemKeys: restartKeys, projectId: null })), JSON.stringify(restartKeys), uploaded.jobId);
  recoverImports();
  assert.equal(getJob('life-restart-a', uploaded.jobId)!.state, 'queued');
  assert.equal(count('SELECT count(*) AS n FROM threads WHERE user_id=?', 'life-restart-a'), 0);
  startImports();
  await waitJob('life-restart-a', uploaded.jobId, ['done']);
  assert.equal(count('SELECT count(*) AS n FROM threads WHERE user_id=?', 'life-restart-a'), 2);
  recoverImports();
  assert.equal(getJob('life-restart-a', uploaded.jobId)!.state, 'done');
  assert.equal(count('SELECT count(*) AS n FROM threads WHERE user_id=?', 'life-restart-a'), 2);

  makeUser('life-restart-b');
  const bytes = bytesOf(file);
  const manual = admitJob('life-restart-b', 'import', bytes.length);
  atomicFile(manual, 'input.json', bytes);
  db.prepare("UPDATE conversation_import_jobs SET state='validating',input_sha256=?,received_bytes=? WHERE id=?").run(hashBytes(bytes), bytes.length, manual.id);
  recoverImports();
  assert.equal(getJob('life-restart-b', manual.id)!.state, 'validating');
  startImports();
  await waitJob('life-restart-b', manual.id, ['ready']);
  assert.equal(allItems(manual.id).length, 2);

  makeUser('life-restart-c');
  const missing = await uploadRoute('life-restart-c', file);
  await waitJob('life-restart-c', missing.jobId, ['ready']);
  const missingRow = requireJob('life-restart-c', missing.jobId);
  unlinkSync(path.join(jobDir(missingRow), 'manifest.json'));
  assert.throws(() => confirmImport('life-restart-c', missing.jobId, [allItems(missing.jobId)[0]!.item_key], null));
  assert.equal(count('SELECT count(*) AS n FROM threads WHERE user_id=?', 'life-restart-c'), 0);
  recoverImports();
  const missingView = getJob('life-restart-c', missing.jobId)!;
  assert.equal(missingView.state, 'failed');
  assert.equal(missingView.error_code, 'staging_unavailable');
  assert.equal(count('SELECT count(*) AS n FROM threads WHERE user_id=?', 'life-restart-c'), 0);

  makeUser('life-restart-d');
  const tampered = await uploadRoute('life-restart-d', file);
  await waitJob('life-restart-d', tampered.jobId, ['ready']);
  const tamperedRow = requireJob('life-restart-d', tampered.jobId);
  atomicFile(tamperedRow, '0.json', '{"version":1,"conversation":null}');
  recoverImports();
  const tamperedView = getJob('life-restart-d', tampered.jobId)!;
  assert.equal(tamperedView.state, 'failed');
  assert.equal(tamperedView.error_code, 'staging_unavailable');

  makeUser('life-restart-paused');
  const paused = await uploadRoute('life-restart-paused', file);
  await waitJob('life-restart-paused', paused.jobId, ['ready']);
  const pausedKeys = allItems(paused.jobId).map((item) => item.item_key).sort();
  db.prepare("UPDATE conversation_import_items SET state='pending',selected=1 WHERE job_id=?").run(paused.jobId);
  db.prepare("UPDATE conversation_import_jobs SET state='paused',error_code='storage_quota',confirmation_sha256=?,selection_json=?,project_id=NULL WHERE id=?")
    .run(hashBytes(JSON.stringify({ itemKeys: pausedKeys, projectId: null })), JSON.stringify(pausedKeys), paused.jobId);
  recoverImports();
  assert.equal(getJob('life-restart-paused', paused.jobId)!.state, 'paused');

  makeUser('life-restart-cancel');
  const cancelling = await uploadRoute('life-restart-cancel', file);
  await waitJob('life-restart-cancel', cancelling.jobId, ['ready']);
  db.prepare("UPDATE conversation_import_jobs SET state='cancelling',cancel_requested=1 WHERE id=?").run(cancelling.jobId);
  recoverImports();
  assert.equal(getJob('life-restart-cancel', cancelling.jobId)!.state, 'cancelled');

  // A later failed job never rolls back an earlier committed conversation.
  makeUser('life-restart-committed');
  const committedFile = portableFile([conversation('restart-committed-1', 'Kept', [message('restart-committed-1-m', 'user', 'Kept text', BASE)])]);
  const committed = await uploadRoute('life-restart-committed', committedFile);
  await waitJob('life-restart-committed', committed.jobId, ['ready']);
  const committedItems = await json<ImportItemsPage>(await api('GET', `/${committed.jobId}/items`, { user: 'life-restart-committed' }));
  await api('POST', `/${committed.jobId}/confirm`, { user: 'life-restart-committed', body: JSON.stringify({ itemKeys: [committedItems.items[0]!.itemKey], projectId: null }) });
  await waitJob('life-restart-committed', committed.jobId, ['done']);
  const later = await uploadRoute('life-restart-committed', portableFile([conversation('restart-later-1', 'Later', [message('restart-later-1-m', 'user', 'Later text', BASE)])]));
  await waitJob('life-restart-committed', later.jobId, ['ready']);
  const laterRow = requireJob('life-restart-committed', later.jobId);
  unlinkSync(path.join(jobDir(laterRow), 'manifest.json'));
  recoverImports();
  assert.equal(getJob('life-restart-committed', later.jobId)!.state, 'failed');
  assert.equal(count('SELECT count(*) AS n FROM threads WHERE user_id=?', 'life-restart-committed'), 1);
});

test('review TTL expires imports, removes staging and releases reservations, then purges terminal metadata', async () => {
  makeUser('life-ttl');
  const uploaded = await uploadRoute('life-ttl', portableFile([conversation('ttl-1', 'TTL', [message('ttl-m', 'user', 'Expire me', BASE)])]));
  await waitJob('life-ttl', uploaded.jobId, ['ready']);
  const row = requireJob('life-ttl', uploaded.jobId);
  assert.ok(existsSync(jobDir(row)));

  const exited = thrown(() => {
    db.prepare('UPDATE conversation_import_jobs SET expires_at=? WHERE id=?').run(Date.now() - 1000, uploaded.jobId);
    maintainImports();
    requireJob('life-ttl', uploaded.jobId);
  });
  assert.equal(exited.status, 410);
  const expired = getJob('life-ttl', uploaded.jobId)!;
  assert.equal(expired.state, 'expired');
  assert.equal(expired.reservation_bytes, 0);
  assert.equal(expired.staging_present, 0);
  assert.ok(!existsSync(jobDir(row)));
  assert.equal(((await api('GET', `/${uploaded.jobId}`, { user: 'life-ttl' })).status), 410);

  db.prepare('UPDATE conversation_import_jobs SET terminal_at=? WHERE id=?').run(Date.now() - 8 * 86_400_000, uploaded.jobId);
  maintainImports();
  assert.equal(getJob('life-ttl', uploaded.jobId), undefined);
  assert.equal(count('SELECT count(*) AS n FROM conversation_import_items WHERE job_id=?', uploaded.jobId), 0);
});

test('portable export is owner-only, refuses busy, restricted and foreign chats, keeps stable sources and round-trips on another account', async () => {
  makeUser('life-export');
  makeUser('life-export-other');
  const threadId = 'life-export-thread';
  nativeThread('life-export', threadId, 'Exported synthetic chat');
  nativeMessage(threadId, 'export-m1', null, 'user', [
    { type: 'text', text: 'Exported alpha' },
    { type: 'file', mediaType: 'application/pdf', filename: 'private.pdf', url: 'app-asset:missing' },
  ], BASE);
  nativeMessage(threadId, 'export-m2', 'export-m1', 'assistant', [{ type: 'text', text: 'Exported beta' }], BASE + 1000);
  db.prepare('UPDATE threads SET preferred_head=? WHERE id=?').run('export-m2', threadId);

  const active = await uploadRoute('life-export', portableFile([conversation('export-active', 'Active', [message('export-active-m', 'user', 'Active text', BASE)])]));
  await waitJob('life-export', active.jobId, ['ready']);
  const busy = await api('POST', '/exports', { user: 'life-export', body: JSON.stringify({ threads: [{ id: threadId }] }) });
  assert.equal(busy.status, 409);
  assert.equal((await api('GET', `/${active.jobId}/download`, { user: 'life-export' })).status, 409);
  await api('DELETE', `/${active.jobId}`, { user: 'life-export' });

  const exported = await api('POST', '/exports', { user: 'life-export', body: JSON.stringify({ threads: [{ id: threadId }] }) });
  assert.equal(exported.status, 202);
  const exportJob = (await exported.json()) as { jobId: string };
  await waitJob('life-export', exportJob.jobId, ['ready']);
  const download = await api('GET', `/${exportJob.jobId}/download`, { user: 'life-export' });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type') ?? '', /application\/json/);
  assert.match(download.headers.get('content-disposition') ?? '', /okaychat-conversations\.json/);
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  const portable = (await download.json()) as { format: string; version: number; conversations: PortableConversation[] };
  assert.equal(portable.format, 'okaychat.conversations');
  assert.equal(portable.version, 1);
  assert.equal(portable.conversations.length, 1);
  const first = portable.conversations[0]!;
  assert.equal(first.source.namespace, 'portable-v1');
  assert.equal(first.title, 'Exported synthetic chat');
  assert.deepEqual(first.messages.map((entry) => entry.role), ['user', 'assistant']);
  assert.equal(first.messages[0]!.createdAt, BASE);
  assert.equal(first.messages[1]!.createdAt, BASE + 1000);
  assert.ok(first.messages[0]!.parts.some((part) => part.type === 'missing-attachment' && part.name === 'private.pdf'));
  assert.ok(!JSON.stringify(portable).includes('app-asset:missing'));
  assert.equal(count('SELECT count(*) AS n FROM conversation_source_ids WHERE user_id=? AND thread_id=?', 'life-export', threadId), 1);

  await api('DELETE', `/${exportJob.jobId}`, { user: 'life-export' });
  const exportedAgain = await api('POST', '/exports', { user: 'life-export', body: JSON.stringify({ threads: [{ id: threadId }] }) });
  const secondJob = (await exportedAgain.json()) as { jobId: string };
  await waitJob('life-export', secondJob.jobId, ['ready']);
  const second = (await (await api('GET', `/${secondJob.jobId}/download`, { user: 'life-export' })).json()) as { conversations: PortableConversation[] };
  assert.equal(second.conversations[0]!.source.id, first.source.id);
  await api('DELETE', `/${secondJob.jobId}`, { user: 'life-export' });

  const reimport = await api('POST', '/', { user: 'life-export-other', body: JSON.stringify(portable) });
  assert.equal(reimport.status, 202);
  const reimportJob = (await reimport.json()) as { jobId: string };
  await waitJob('life-export-other', reimportJob.jobId, ['ready']);
  const reimportItems = await json<ImportItemsPage>(await api('GET', `/${reimportJob.jobId}/items`, { user: 'life-export-other' }));
  assert.equal(reimportItems.items[0]!.state, 'valid');
  const confirmed = await api('POST', `/${reimportJob.jobId}/confirm`, { user: 'life-export-other', body: JSON.stringify({ itemKeys: [reimportItems.items[0]!.itemKey], projectId: null }) });
  assert.equal(confirmed.status, 202);
  await waitJob('life-export-other', reimportJob.jobId, ['done']);
  const result = await json<ImportItemsPage>(await api('GET', `/${reimportJob.jobId}/items`, { user: 'life-export-other' }));
  const roundTripThread = result.items[0]!.result!.threadId;
  assert.notEqual(roundTripThread, threadId);
  const identity = db.prepare('SELECT namespace,source_id FROM conversation_source_ids WHERE user_id=? AND thread_id=?').get('life-export-other', roundTripThread) as { namespace: string; source_id: string };
  assert.equal(identity.namespace, 'portable-v1');
  assert.equal(identity.source_id, first.source.id);
  const roundTripRows = db.prepare('SELECT created_at,content FROM messages WHERE thread_id=? ORDER BY rowid').all(roundTripThread) as Array<{ created_at: number; content: string }>;
  assert.deepEqual(roundTripRows.map((row) => row.created_at), [BASE, BASE + 1000]);
  assert.ok(roundTripRows[0]!.content.includes('Exported alpha'));
  assert.ok(roundTripRows[1]!.content.includes('Exported beta'));
  assert.equal(count('SELECT count(*) AS n FROM threads WHERE user_id=?', 'life-export-other'), 1);
});

test('portable export refuses shared-knowledge-restricted and foreign chats like native export', async () => {
  makeUser('life-refuse');
  makeUser('life-refuse-other');
  const threadId = 'life-refuse-thread';
  nativeThread('life-refuse', threadId, 'Refused synthetic chat');
  nativeMessage(threadId, 'refuse-m', null, 'user', [{ type: 'text', text: 'Refused text' }], BASE);
  db.prepare('UPDATE threads SET preferred_head=? WHERE id=?').run('refuse-m', threadId);

  db.prepare('INSERT INTO knowledge_thread_dependencies (thread_id,collection_id,created_at) VALUES (?,?,?)').run(threadId, 'shared-collection', Date.now());
  const restricted = await api('POST', '/exports', { user: 'life-refuse', body: JSON.stringify({ threads: [{ id: threadId }] }) });
  assert.equal(restricted.status, 409);
  assert.equal(((await json<{ details: { reason: string } }>(restricted)).details.reason), 'export_unavailable');
  db.prepare('DELETE FROM knowledge_thread_dependencies WHERE thread_id=?').run(threadId);
  assert.equal(count('SELECT count(*) AS n FROM threads WHERE user_id=?', 'life-refuse'), 1);

  const foreign = await api('POST', '/exports', { user: 'life-refuse-other', body: JSON.stringify({ threads: [{ id: threadId }] }) });
  assert.equal(foreign.status, 404);
  assert.equal(((await json<{ details: { reason: string } }>(foreign)).details.reason), 'not_found');
  assert.equal(count("SELECT count(*) AS n FROM conversation_import_jobs WHERE user_id=? AND state<>'failed'", 'life-refuse-other'), 0);
});

test('the existing native ZIP exporter still builds its unchanged manifest beside the new import tables', () => {
  makeUser('life-zip');
  nativeThread('life-zip', 'life-zip-thread', 'ZIP synthetic');
  nativeMessage('life-zip-thread', 'zip-m1', null, 'user', [{ type: 'text', text: 'ZIP text' }], BASE);
  db.prepare('UPDATE threads SET preferred_head=? WHERE id=?').run('zip-m1', 'life-zip-thread');
  const built = buildArchive({ userId: 'life-zip', threads: [{ id: 'life-zip-thread' }] });
  assert.equal(built.manifest.format, ARCHIVE_FORMAT);
  assert.equal(built.manifest.version, ARCHIVE_VERSION);
  assert.equal(built.manifest.chats.length, 1);
  assert.equal(built.manifest.chats[0]!.messages.length, 1);
  assert.equal(count('SELECT count(*) AS n FROM conversation_import_jobs WHERE user_id=?', 'life-zip'), 0);
  assert.equal(count('SELECT count(*) AS n FROM conversation_source_ids WHERE user_id=?', 'life-zip'), 0);
});

test('staging paths and stored previews never expose raw uploads or normalized transcript bodies', async () => {
  makeUser('life-private');
  const source = mappingFile('private-source')[0] as Record<string, unknown>;
  const uploaded = await uploadRoute('life-private', [source]);
  await waitJob('life-private', uploaded.jobId, ['ready']);
  const row = requireJob('life-private', uploaded.jobId);
  assert.ok(readBounded(row, 'manifest.json', 1024 * 1024).length > 0);
  assert.throws(() => readBounded(row, 'input.json', 1024));
  const view = await json<JobView>(await api('GET', `/${uploaded.jobId}`, { user: 'life-private' }));
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('Selected reply'));
  assert.ok(!serialized.includes('Private system note'));
  assert.ok(!serialized.includes('manifest.json'));
  assert.ok(!serialized.includes('input.json'));
  const page = await json<ImportItemsPage>(await api('GET', `/${uploaded.jobId}/items`, { user: 'life-private' }));
  assert.ok(!JSON.stringify(page).includes('Selected reply'));
  await api('DELETE', `/${uploaded.jobId}`, { user: 'life-private' });
});
