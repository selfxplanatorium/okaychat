import { z } from 'zod';
import { IMPORT_LIMITS as L, type PortableConversation } from '../../shared/chat-import.js';
import { storedContent } from './stored-content.js';
import { fail } from './json.js';
const identifier=z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const time=z.number().int().safe().nonnegative();
const label=(limit:number)=>z.string().refine((value)=>Array.from(value).length<=limit);
const text=z.string().refine((value)=>Buffer.byteLength(value)<=L.messageBytes);
const part=z.discriminatedUnion('type',[
  z.object({type:z.literal('text'),text}).strict(),
  z.object({type:z.literal('missing-attachment'),kind:z.enum(['image','file','audio','video','unknown']),name:label(240).nullable()}).strict(),
  z.object({type:z.literal('historical-tool'),name:label(100),text}).strict(),
]);
const schema=z.object({source:z.object({namespace:z.enum(['mapping-v1','portable-v1']),id:identifier}).strict(),title:label(200).nullable(),createdAt:time,updatedAt:time,status:z.enum(['regular','archived']),messages:z.array(z.object({id:identifier,createdAt:time,role:z.enum(['user','assistant','tool','quarantine']),originalRole:label(100).nullable(),parts:z.array(part).min(1).max(L.parts)}).strict()).min(1).max(L.nodesPerConversation)}).strict();
/** Main-process staging check: fixed-depth DTO validation, never re-run untrusted text transforms. */
export function validateNormalized(value:unknown,admissionTime:number):PortableConversation {
  const result=schema.safeParse(value);if(!result.success) fail('staging_unavailable');
  const c=result.data;const max=admissionTime+86400000;
  if(c.createdAt>c.updatedAt || c.updatedAt>max || new Set(c.messages.map((m)=>m.id)).size!==c.messages.length) fail('staging_unavailable');
  let stored=Buffer.byteLength(c.title??'');
  for(const m of c.messages) {
    if(m.createdAt>max || ((m.role==='user'||m.role==='assistant') ? m.originalRole!==null : !m.originalRole)) fail('staging_unavailable');
    let bytes=0;
    for(const p of m.parts) {
      if('text' in p) bytes+=Buffer.byteLength(p.text);
      if((m.role==='tool' && p.type!=='historical-tool') || (p.type==='historical-tool' && m.role!=='tool' && m.role!=='assistant')) fail('staging_unavailable');
    }
    if(bytes>L.messageBytes) fail('too_large');stored+=Buffer.byteLength(JSON.stringify(storedContent(m)));
  }
  if(stored>L.conversationBytes || Buffer.byteLength(JSON.stringify(c))>L.conversationBytes) fail('too_large');
  return c;
}
