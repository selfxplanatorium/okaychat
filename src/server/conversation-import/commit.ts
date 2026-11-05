import { storedContent } from "./stored-content.js";
import { createHash } from 'node:crypto';
import { db, tx } from '../db.js';
import { newId } from '../crypto.js';
import { assertStorage, messageBytes } from '../quota.js';
import { IMPORT_LIMITS as L, type PortableConversation } from '../../shared/chat-import.js';
import { normalizeFile } from './formats.js';
import { fail } from './json.js';

export const payloadHash = (conversation: PortableConversation): string => createHash('sha256').update(JSON.stringify(conversation)).digest('hex');
export interface CommitResult { threadId: string; duplicate: boolean; changed: boolean }
/** One synchronous transaction: no filesystem, tools, providers, or ordinary append hooks. */
export function commitConversation(userId: string, jobId: string, ordinal: number, conversation: PortableConversation, now = Date.now()): CommitResult {
  return tx(() => {
    const job = db.prepare('SELECT * FROM conversation_import_jobs WHERE id=? AND user_id=?').get(jobId,userId) as {kind:string;state:string;cancel_requested:number;expires_at:number;project_id:string|null;model_ref:string|null;reservation_bytes:number;admission_at:number}|undefined;
    if (!job || job.kind !== 'import' || job.state !== 'importing' || job.cancel_requested || job.expires_at <= now) fail('wrong_state');
    const item = db.prepare('SELECT state,selected,payload_sha256 FROM conversation_import_items WHERE job_id=? AND ordinal=?').get(jobId,ordinal) as {state:string;selected:number;payload_sha256:string}|undefined;
    if (!item || item.state !== 'pending' || !item.selected) fail('wrong_state');
    if (job.project_id && !db.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').get(job.project_id,userId)) fail('target_missing');
    const normalized = normalizeFile({format:'okaychat.conversations',version:1,exportedAt:job.admission_at,conversations:[conversation]},job.admission_at).items[0]?.conversation;
    if (!normalized || JSON.stringify(normalized) !== JSON.stringify(conversation)) fail('staging_unavailable');
    const hash = payloadHash(normalized); if (hash !== item.payload_sha256) fail('staging_unavailable');
    const existing = db.prepare('SELECT thread_id,payload_sha256 FROM conversation_source_ids WHERE user_id=? AND namespace=? AND source_id=?').get(userId,conversation.source.namespace,conversation.source.id) as {thread_id:string;payload_sha256:string}|undefined;
    if (existing) {
      db.prepare("UPDATE conversation_import_items SET state='duplicate',thread_id=?,error_code=? WHERE job_id=? AND ordinal=?").run(existing.thread_id,existing.payload_sha256 !== hash ? 'source_changed' : null,jobId,ordinal);
      return {threadId:existing.thread_id,duplicate:true,changed:existing.payload_sha256 !== hash};
    }
    const threadId = newId('thr'); let parentId: string|null = null;
    const rows = conversation.messages.map((message) => {
      const id = newId('msg');
      const json = JSON.stringify(storedContent(message));
      const row = {id,parentId,json,createdAt:message.createdAt}; parentId = id; return row;
    });
    const titleBytes = Buffer.byteLength(conversation.title ?? '');
    const charge = rows.reduce((n,row)=>n+messageBytes(row.json),0)+L.identityBytes+titleBytes;
    db.prepare('UPDATE conversation_import_jobs SET reservation_bytes=reservation_bytes-? WHERE id=? AND user_id=?').run(Math.min(job.reservation_bytes,charge),jobId,userId);
    assertStorage(userId,charge);
    db.prepare(`INSERT INTO threads (id,user_id,title,status,model_ref,project_id,memory_disabled,preferred_head,memory_cursor,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?,?)`).run(threadId,userId,conversation.title,conversation.status,job.model_ref,job.project_id,parentId,parentId,conversation.createdAt,conversation.updatedAt);
    const insert = db.prepare("INSERT INTO messages (id,thread_id,parent_id,format,content,bytes,created_at,imported) VALUES (?,?,?,'ai-sdk/v6',?,?,?,1)");
    for (const row of rows) insert.run(row.id,threadId,row.parentId,row.json,messageBytes(row.json),row.createdAt);
    db.prepare('INSERT INTO conversation_source_ids (user_id,namespace,source_id,thread_id,payload_sha256,title_bytes,created_at) VALUES (?,?,?,?,?,?,?)').run(userId,conversation.source.namespace,conversation.source.id,threadId,hash,titleBytes,now);
    db.prepare("UPDATE conversation_import_items SET state='imported',thread_id=? WHERE job_id=? AND ordinal=?").run(threadId,jobId,ordinal);
    return {threadId,duplicate:false,changed:false};
  });
}
