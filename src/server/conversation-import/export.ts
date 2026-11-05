import { randomUUID } from 'node:crypto';
import { db, tx } from '../db.js';
import { assertStorage } from '../quota.js';
import { currentBranch, getThread } from '../threads.js';
import { threadBusy } from '../thread-runs.js';
import { IMPORT_LIMITS as L, type PortableConversation, type PortableMessage, type PortablePart, type PortableFile } from '../../shared/chat-import.js';
import { payloadHash } from './commit.js';
import { transcriptKind } from './provenance.js';
import { fail } from './json.js';
import { normalizeFile } from './formats.js';
import { serializeInWorker } from './worker-pool.js';

/** Text-only snapshot: never calls the archive builder or reads attachment bodies. */
export function snapshotConversations(userId: string, ids: string[], now = Date.now()): PortableFile {
  if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length) fail('invalid_selection');
  return tx(()=> {
    const conversations = ids.map((id): PortableConversation => {
      const thread = getThread(userId,id);
      if (!thread) fail('not_found');
      if (threadBusy(id) || thread.sharedKnowledgeRestricted) fail('export_unavailable');
      const existing = db.prepare('SELECT namespace,source_id FROM conversation_source_ids WHERE thread_id=? AND user_id=?').get(id,userId) as {namespace:'mapping-v1'|'portable-v1';source_id:string}|undefined;
      const source = existing ? {namespace:existing.namespace,id:existing.source_id} : {namespace:'portable-v1' as const,id:randomUUID()};
      const messages = currentBranch(userId,id).map((message): PortableMessage => {
        const row = db.prepare('SELECT created_at FROM messages WHERE thread_id=? AND id=?').get(id,message.id) as {created_at:number};
        const meta = message.metadata as {custom?:{importedTranscript?:{sourceMessageId:string;originalRole:string|null}}}|undefined;
        const marker = meta?.custom?.importedTranscript;
        const kind = transcriptKind(message);
        const parts: PortablePart[] = [];
        for (const part of message.parts) {
          if (part.type === 'text') parts.push({type:'text',text:part.text});
          else if (part.type === 'data-imported-quarantine') {
            const data = (part as {data:{text:string;missingAttachment?:{kind:'image'|'file'|'audio'|'video'|'unknown';name:string|null}}}).data;
            parts.push(data.missingAttachment ? {type:'missing-attachment',kind:data.missingAttachment.kind,name:data.missingAttachment.name} : {type:'text',text:data.text});
          } else if (part.type === 'data-imported-missing-attachment') {
            const data = (part as {data:{kind:'image'|'file'|'audio'|'video'|'unknown';name:string|null}}).data; parts.push({type:'missing-attachment',kind:data.kind,name:data.name});
          } else if (part.type === 'data-imported-tool') {
            const data = (part as {data:{name:string;output:unknown}}).data; parts.push({type:'historical-tool',name:data.name,text:typeof data.output === 'string' ? data.output : JSON.stringify(data.output)});
          } else if (part.type === 'file') parts.push({type:'missing-attachment',kind:part.mediaType.startsWith('image/') ? 'image' : 'file',name:part.filename ?? null});
          // Reasoning, actionable tools, sources and opaque data are intentionally not transferred.
        }
        return {id:marker?.sourceMessageId ?? message.id,createdAt:row.created_at,role:kind === 'quarantine' ? 'quarantine' : kind === 'tool' ? 'tool' : message.role === 'user' ? 'user' : 'assistant',originalRole:marker?.originalRole ?? null,parts};
      }).filter((message)=>message.parts.length);
      const conversation: PortableConversation = {source,title:thread.title,createdAt:thread.createdAt,updatedAt:thread.updatedAt,status:thread.status,messages};
      const normalized = normalizeFile({format:'okaychat.conversations',version:1,exportedAt:now,conversations:[conversation]},now).items[0]?.conversation;
      if (!normalized) fail('export_too_large');
      if (!existing) {
        const titleBytes = Buffer.byteLength(thread.title ?? ''); assertStorage(userId,L.identityBytes+titleBytes);
        db.prepare('INSERT INTO conversation_source_ids (user_id,namespace,source_id,thread_id,payload_sha256,title_bytes,created_at) VALUES (?,?,?,?,?,?,?)').run(userId,source.namespace,source.id,id,payloadHash(normalized),titleBytes,now);
      }
      return normalized;
    });
    return {format:'okaychat.conversations',version:1,exportedAt:now,conversations};
  });
}
export async function exportConversations(userId: string, ids: string[], now = Date.now(), signal?: AbortSignal): Promise<Uint8Array> {
  const snapshot = snapshotConversations(userId,ids,now);
  return serializeInWorker(new TextEncoder().encode(JSON.stringify(snapshot)),now,signal);
}
