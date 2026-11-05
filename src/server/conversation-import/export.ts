import { randomUUID } from 'node:crypto';
import { db, tx } from '../db.js';
import { assertStorage } from '../quota.js';
import { getThread, preferredHead } from '../threads.js';
import { threadBusy } from '../thread-runs.js';
import { IMPORT_LIMITS as L, type PortableConversation, type PortableMessage, type PortablePart, type PortableFile } from '../../shared/chat-import.js';
import { payloadHash } from './commit.js';
import { fail } from './json.js';
import { normalizeFile } from './formats.js';
import { serializeInWorker } from './worker-pool.js';

interface ExportThread {id:string;selectedLeaf?:string}
interface Row {id:string;parent_id:string|null;created_at:number;role:string;marker:string|null}
interface Part {type:string;text:string|null;mime:string|null;name:string|null;data:string|null;tool_name:string|null;output:string|null;input:string|null}
function projectMessage(threadId:string,row:Row):PortableMessage {
  const marker=row.marker ? JSON.parse(row.marker) as {kind:string;sourceMessageId:string;originalRole:string|null} : null;
  const parts:PortablePart[]=[];
  // Select only file descriptors: the URL/inline bytes and all asset stores remain unread.
  const rows=db.prepare(`SELECT json_extract(value,'$.type') AS type,
    CASE WHEN json_extract(value,'$.type')='text' THEN json_extract(value,'$.text') END AS text,
    json_extract(value,'$.mediaType') AS mime,json_extract(value,'$.filename') AS name,
    CASE WHEN json_extract(value,'$.type') IN ('data-imported-quarantine','data-imported-missing-attachment','data-imported-tool') THEN json_extract(value,'$.data') END AS data,
    json_extract(value,'$.toolName') AS tool_name,
    CASE WHEN json_extract(value,'$.type') LIKE 'tool-%' OR json_extract(value,'$.type')='dynamic-tool' THEN json_extract(value,'$.output') END AS output,
    CASE WHEN json_extract(value,'$.type') LIKE 'tool-%' OR json_extract(value,'$.type')='dynamic-tool' THEN json_extract(value,'$.input') END AS input
    FROM messages,json_each(messages.content,'$.parts') WHERE messages.thread_id=? AND messages.id=? LIMIT 101`).all(threadId,row.id) as unknown as Part[];
  if(rows.length>L.parts) fail('export_too_large');
  for(const p of rows) {
    if(p.type==='text') parts.push({type:'text',text:p.text??''});
    else if(p.type==='file') parts.push({type:'missing-attachment',kind:p.mime?.startsWith('image/') ? 'image' : 'file',name:p.name});
    else if(p.type==='data-imported-quarantine' && p.data) {
      const data=JSON.parse(p.data) as {text:string;missingAttachment?:{kind:'image'|'file'|'audio'|'video'|'unknown';name:string|null}};
      parts.push(data.missingAttachment ? {type:'missing-attachment',...data.missingAttachment} : {type:'text',text:data.text});
    } else if(p.type==='data-imported-missing-attachment' && p.data) {
      const data=JSON.parse(p.data) as {kind:'image'|'file'|'audio'|'video'|'unknown';name:string|null};parts.push({type:'missing-attachment',kind:data.kind,name:data.name});
    } else if(p.type==='data-imported-tool' && p.data) {
      const data=JSON.parse(p.data) as {name:string;output:unknown};parts.push({type:'historical-tool',name:data.name,text:typeof data.output==='string' ? data.output : JSON.stringify(data.output??null)});
    } else if(p.type.startsWith('tool-') || p.type==='dynamic-tool') {
      parts.push({type:'historical-tool',name:p.tool_name??p.type.slice(5),text:JSON.stringify({input:p.input,output:p.output,state:'interrupted'})});
    }
  }
  return {id:marker?.sourceMessageId??row.id,createdAt:row.created_at,role:marker?.kind==='quarantine' ? 'quarantine' : marker?.kind==='tool' ? 'tool' : row.role==='user' ? 'user' : 'assistant',originalRole:marker?.originalRole??null,parts};
}
/** Text-only snapshot; identity writes and the whole owned snapshot share a short synchronous transaction. */
export function snapshotConversations(userId:string,requested:string[]|ExportThread[],now=Date.now(),jobId?:string):PortableFile {
  const threads=requested.map((v)=>typeof v==='string' ? {id:v} : v);
  if(!threads.length || threads.length>100 || new Set(threads.map((t)=>t.id)).size!==threads.length) fail('invalid_selection');
  return tx(()=> {
    // Validate the entire set before any identity is allocated or snapshot content read.
    for(const item of threads) {const thread=getThread(userId,item.id);if(!thread) fail('not_found');if(threadBusy(item.id)||thread.sharedKnowledgeRestricted) fail('export_unavailable');}
    let bytes=0,totalMessages=0;
    const conversations=threads.map(({id,selectedLeaf}):PortableConversation=> {
      const thread=getThread(userId,id)!;
      const existing=db.prepare('SELECT namespace,source_id,origin FROM conversation_source_ids WHERE thread_id=? AND user_id=?').get(id,userId) as {namespace:'mapping-v1'|'portable-v1';source_id:string;origin:string}|undefined;
      const source=existing ? {namespace:existing.namespace,id:existing.source_id} : {namespace:'portable-v1' as const,id:randomUUID()};
      const read=db.prepare("SELECT id,parent_id,created_at,json_extract(content,'$.role') AS role,CASE WHEN imported=1 THEN json_extract(content,'$.metadata.custom.importedTranscript') END AS marker FROM messages WHERE thread_id=? AND id=?");
      const latest=db.prepare('SELECT id FROM messages WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id) as {id:string}|undefined;
      let head=selectedLeaf??preferredHead(userId,id)??latest?.id;
      const chain:PortableMessage[]=[],seen=new Set<string>();let size=0;
      while(head) {
        if(seen.has(head)||seen.size>=L.nodesPerConversation) fail('export_too_large');seen.add(head);
        const row=read.get(id,head) as Row|undefined;if(!row) fail('invalid_selection');
        const message=projectMessage(id,row);size+=Buffer.byteLength(JSON.stringify(message));if(size>L.conversationBytes) fail('export_too_large');
        if(message.parts.length) chain.push(message);head=row.parent_id??undefined;
      }
      chain.reverse();totalMessages+=chain.length;if(totalMessages>L.totalNodes) fail('export_too_large');
      const conversation:PortableConversation={source,title:thread.title,createdAt:thread.createdAt,updatedAt:thread.updatedAt,status:thread.status,messages:chain};
      const normalized=normalizeFile({format:'okaychat.conversations',version:1,exportedAt:now,conversations:[conversation]},now).items[0]?.conversation;
      if(!normalized) fail('export_too_large');
      bytes+=Buffer.byteLength(JSON.stringify(normalized));if(bytes>L.inputBytes-1024) fail('export_too_large');
      const hash=payloadHash(normalized);
      if(!existing) {
        const titleBytes=Buffer.byteLength(thread.title??'');const charge=L.identityBytes+titleBytes;
        if(jobId) db.prepare('UPDATE conversation_import_jobs SET reservation_bytes=max(0,reservation_bytes-?) WHERE id=? AND user_id=?').run(charge,jobId,userId);
        assertStorage(userId,charge);
        db.prepare("INSERT INTO conversation_source_ids (user_id,namespace,source_id,thread_id,payload_sha256,title_bytes,created_at,origin) VALUES (?,?,?,?,?,?,?,'export')").run(userId,source.namespace,source.id,id,hash,titleBytes,now);
      } else if(existing.origin==='export') db.prepare('UPDATE conversation_source_ids SET payload_sha256=? WHERE thread_id=? AND user_id=?').run(hash,id,userId);
      return normalized;
    });
    return {format:'okaychat.conversations',version:1,exportedAt:now,conversations};
  });
}
export async function exportConversations(userId:string,ids:string[],now=Date.now(),signal?:AbortSignal):Promise<Uint8Array> {
  const snapshot=snapshotConversations(userId,ids,now);return serializeInWorker(new TextEncoder().encode(JSON.stringify(snapshot)),now,signal);
}
