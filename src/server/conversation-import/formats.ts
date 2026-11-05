import { storedContent } from "./stored-content.js";
import { IMPORT_LIMITS as L, type ImportCounts, type ImportWarning, type NormalizedFile, type NormalizedItem, type PortableConversation, type PortableMessage, type PortablePart, type SourceNamespace } from '../../shared/chat-import.js';
import { fail, ImportFailure } from './json.js';
import { label, sanitizeText, warning } from './text.js';

type Obj = Record<string, unknown>;
const own = (o: Obj, k: string) => Object.hasOwn(o, k);
function obj(v: unknown): Obj { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(); return v as Obj; }
function arr(v: unknown): unknown[] { if (!Array.isArray(v)) fail(); return v; }
function str(v: unknown): string { if (typeof v !== 'string') fail(); return v; }
function id(v: unknown): string { const s = str(v); if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(s)) fail(); return s; }
function keys(o: Obj, names: string[], strict: boolean, warnings: ImportWarning[]): void {
  if (Object.keys(o).some((k) => !names.includes(k))) { if (strict) fail(); warning(warnings, 'unknown_fields'); }
  if (strict && names.some((k) => !own(o, k))) fail();
}
function epoch(v: unknown, now: number): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > now + 86400000) fail(); return v; }
function seconds(v: unknown, now: number): number | null { if (v == null) return null; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail(); return epoch(Math.round(v * 1000), now); }
const counts = (): ImportCounts => ({ sourceNodes: 0, sourceMessages: 0, discardedBranchNodes: 0, discardedBranchMessages: 0, quarantine: 0, omittedAttachments: 0 });
function checkMessage(m: PortableMessage): void {
  if (!m.parts.length || m.parts.length > L.parts || Buffer.byteLength(m.parts.map((p) => 'text' in p ? p.text : '').join('')) > L.messageBytes) fail('too_large');
}
function portable(value: unknown, now: number, warnings: ImportWarning[], c: ImportCounts): PortableConversation {
  const o = obj(value); keys(o, ['source','title','createdAt','updatedAt','status','messages'], true, warnings);
  const source = obj(o.source); keys(source, ['namespace','id'], true, warnings);
  if (source.namespace !== 'mapping-v1' && source.namespace !== 'portable-v1') fail();
  const createdAt = epoch(o.createdAt, now), updatedAt = epoch(o.updatedAt, now);
  if (createdAt > updatedAt || (o.status !== 'regular' && o.status !== 'archived')) fail();
  const messages: PortableMessage[] = [], ids = new Set<string>();
  for (const entry of arr(o.messages)) {
    const m = obj(entry); keys(m, ['id','createdAt','role','originalRole','parts'], true, warnings);
    const key = id(m.id); if (ids.has(key)) fail(); ids.add(key);
    if (!['user','assistant','tool','quarantine'].includes(str(m.role))) fail();
    const role = m.role as PortableMessage['role'];
    const originalRole = m.originalRole === null ? null : str(m.originalRole);
    if ((role === 'user' || role === 'assistant') ? originalRole !== null : !originalRole || Array.from(originalRole).length > 100) fail();
    const parts: PortablePart[] = arr(m.parts).map((entry) => {
      const p = obj(entry);
      if (p.type === 'text') { keys(p,['type','text'],true,warnings); if (role === 'tool') fail(); return {type:'text',text:sanitizeText(str(p.text),warnings)}; }
      if (p.type === 'missing-attachment') {
        keys(p,['type','kind','name'],true,warnings); if (role === 'tool' || !['image','file','audio','video','unknown'].includes(str(p.kind))) fail();
        const name = p.name === null ? null : label(str(p.name),240,warnings); c.omittedAttachments++;
        return {type:'missing-attachment',kind:p.kind as 'image'|'file'|'audio'|'video'|'unknown',name};
      }
      if (p.type !== 'historical-tool' || (role !== 'assistant' && role !== 'tool')) fail();
      keys(p,['type','name','text'],true,warnings);
      return {type:'historical-tool',name:label(str(p.name),100,warnings),text:sanitizeText(str(p.text),warnings)};
    });
    const message = {id:key,createdAt:epoch(m.createdAt,now),role,originalRole,parts}; checkMessage(message); messages.push(message);
    if (role === 'quarantine') c.quarantine++;
  }
  c.sourceNodes = c.sourceMessages = messages.length;
  if (!messages.length) fail('empty_conversation');
  if (messages.length > L.nodesPerConversation) fail('too_large');
  return {source:{namespace:source.namespace,id:id(source.id)},title:o.title === null ? null : label(str(o.title),200,warnings,true) || null,createdAt,updatedAt,status:o.status,messages};
}

function mapping(value: unknown, now: number, warnings: ImportWarning[], c: ImportCounts): PortableConversation {
  const o = obj(value); keys(o,['id','conversation_id','mapping','current_node','title','create_time','update_time','is_archived'],false,warnings);
  const sourceId = id(o.id ?? o.conversation_id); if (o.id != null && o.conversation_id != null && o.id !== o.conversation_id) fail();
  if (o.is_archived !== undefined && typeof o.is_archived !== 'boolean') fail();
  const mapping = obj(o.mapping), nodes = new Map<string, {parent:string|null;children:string[];message: Obj|null}>(), messageIds = new Set<string>();
  const entries = Object.entries(mapping); c.sourceNodes = entries.length;
  if (!entries.length || entries.length > L.nodesPerConversation) fail('too_large');
  for (const [key, value] of entries) {
    id(key); const n = obj(value); keys(n,['id','parent','children','message'],false,warnings);
    if (n.id !== undefined && n.id !== key) fail('invalid_tree');
    const parent = n.parent === null ? null : id(n.parent);
    const children = arr(n.children).map(id); if (new Set(children).size !== children.length) fail('invalid_tree');
    const message = n.message === null ? null : obj(n.message);
    if (message) {
      c.sourceMessages++; const mid = id(message.id); if (messageIds.has(mid)) fail('invalid_tree'); messageIds.add(mid);
      str(obj(message.author).role); str(obj(message.content).content_type);
      // Validate off-path messages too. Their content is never retained.
      const parts = sourceParts(message, [], counts()); checkMessage({id:mid,role:'assistant',originalRole:null,createdAt:0,parts:parts.length ? parts : [{type:'text',text:''}]}); seconds(message.create_time,now);
    }
    nodes.set(key,{parent,children,message});
  }
  const roots = [...nodes].filter(([,n]) => n.parent === null); if (roots.length !== 1) fail('invalid_tree');
  for (const [key,n] of nodes) {
    if (n.parent !== null && (!nodes.has(n.parent) || !nodes.get(n.parent)!.children.includes(key))) fail('invalid_tree');
    for (const child of n.children) if (!nodes.has(child) || nodes.get(child)!.parent !== key || child === key) fail('invalid_tree');
  }
  const seen = new Set<string>(), stack = [roots[0]![0]];
  while (stack.length) { const key = stack.pop()!; if (seen.has(key)) fail('invalid_tree'); seen.add(key); stack.push(...nodes.get(key)!.children); }
  if (seen.size !== nodes.size) fail('invalid_tree');
  let current: string|null = id(o.current_node); if (!nodes.has(current)) fail('invalid_tree');
  const path: string[] = [];
  while (current !== null) { path.push(current); current = nodes.get(current)!.parent; } path.reverse();
  const selected = new Set(path);
  c.discardedBranchNodes = nodes.size - path.length;
  c.discardedBranchMessages = [...nodes].filter(([k,n])=>!selected.has(k) && n.message).length;
  warning(warnings,'branches_omitted',c.discardedBranchNodes);
  const pathTimes = path.flatMap((k)=> { const m = nodes.get(k)!.message; const t = m ? seconds(m.create_time,now) : null; return t === null ? [] : [t]; });
  let createdAt = seconds(o.create_time,now);
  if (createdAt === null) { createdAt = pathTimes.length ? Math.min(...pathTimes) : now; warning(warnings,'timestamps_inferred'); }
  const messages: PortableMessage[] = [];
  for (const k of path) {
    const m = nodes.get(k)!.message; if (!m) continue;
    const author = obj(m.author), sourceRole = str(author.role);
    if (sourceRole === 'assistant' && m.channel != null && m.channel !== 'final') { warning(warnings,'reasoning_omitted'); continue; }
    const tool = sourceRole === 'tool' || (sourceRole === 'assistant' && m.recipient != null && m.recipient !== 'all');
    const contentType = str(obj(m.content).content_type);
    const role = !['text','multimodal_text'].includes(contentType) ? 'quarantine' : tool ? 'tool' : sourceRole === 'user' || sourceRole === 'assistant' ? sourceRole : 'quarantine';
    let parts = sourceParts(m,warnings,c);
    if (role === 'tool') parts = [{type:'historical-tool',name:label(str(author.name ?? m.recipient ?? 'tool'),100,warnings),text:parts.map((p)=>'text' in p ? p.text : '').join('\n')}];
    if (!parts.length) continue;
    if (role === 'quarantine') { c.quarantine++; warning(warnings,'roles_quarantined'); }
    let time = seconds(m.create_time,now); if (time === null) { time = createdAt; warning(warnings,'timestamps_inferred'); }
    const message: PortableMessage = {id:id(m.id),createdAt:time,role,originalRole:role === 'tool' || role === 'quarantine' ? label(sourceRole,100,warnings) || 'unknown' : null,parts};
    checkMessage(message); messages.push(message);
  }
  if (!messages.some((m)=>m.parts.some((p)=>p.type !== 'text' || p.text.trim()))) fail('empty_conversation');
  let updatedAt = seconds(o.update_time,now);
  if (updatedAt === null) { updatedAt = Math.max(createdAt,...messages.map((m)=>m.createdAt)); warning(warnings,'timestamps_inferred'); }
  if (updatedAt < createdAt) fail();
  return {source:{namespace:'mapping-v1',id:sourceId},title:o.title == null ? null : label(str(o.title),200,warnings,true) || null,createdAt,updatedAt,status:o.is_archived ? 'archived' : 'regular',messages};
}
function sourceParts(m: Obj, warnings: ImportWarning[], c: ImportCounts): PortablePart[] {
  const author = obj(m.author); if (author.name != null) str(author.name);
  if (m.recipient != null) str(m.recipient); if (m.channel != null) str(m.channel);
  if (m.metadata != null) { const metadata = obj(m.metadata); if (metadata.attachments != null) arr(metadata.attachments); }
  const content = obj(m.content), type = str(content.content_type);
  if (type !== 'text' && type !== 'multimodal_text') {
    warning(warnings,'unsupported_content');
    return typeof content.text === 'string' ? [{type:'text',text:sanitizeText(content.text,warnings)}] : [{type:'missing-attachment',kind:'unknown',name:null}];
  }
  const parts = arr(content.parts); if (parts.length > L.parts) fail('too_large');
  return parts.map((p): PortablePart => {
    if (typeof p === 'string') return {type:'text',text:sanitizeText(p,warnings)};
    const descriptor = obj(p), kind = str(descriptor.content_type);
    const normalized = kind === 'image_asset_pointer' ? 'image' : /audio/.test(kind) ? 'audio' : /video/.test(kind) ? 'video' : /file/.test(kind) ? 'file' : 'unknown';
    c.omittedAttachments++; warning(warnings,'attachments_missing'); if (normalized === 'unknown') warning(warnings,'unsupported_content');
    return {type:'missing-attachment',kind:normalized,name:null};
  });
}
export function normalizeFile(value: unknown, admissionTime: number): NormalizedFile {
  let adapter: SourceNamespace, entries: unknown[];
  if (Array.isArray(value)) { adapter = 'mapping-v1'; entries = value; }
  else {
    if (!value || typeof value !== 'object') fail('unsupported_format');
    const root = obj(value);
    if (!own(root,'format') || root.format !== 'okaychat.conversations') fail('unsupported_format');
    if (root.version !== 1) fail('unsupported_version');
    keys(root,['format','version','exportedAt','conversations'],true,[]); epoch(root.exportedAt,admissionTime);
    adapter = 'portable-v1'; entries = arr(root.conversations);
  }
  if (!entries.length) fail('empty_conversation'); if (entries.length > L.conversations) fail('too_large');
  let totalNodes = 0, bytes = 0;
  const identities = new Map<string, NormalizedItem[]>();
  const items = entries.map((entry,ordinal): NormalizedItem => {
    const warnings: ImportWarning[] = [], c = counts(); let conversation: PortableConversation|null = null, errorCode: string|null = null;
    try {
      conversation = adapter === 'mapping-v1' ? mapping(entry,admissionTime,warnings,c) : portable(entry,admissionTime,warnings,c);
      const size = Buffer.byteLength(JSON.stringify(conversation));
      const storedBytes = conversation.messages.reduce((n,m)=>n+Buffer.byteLength(JSON.stringify(storedContent(m))),0)+Buffer.byteLength(conversation.title ?? '');
      if (Math.max(size,storedBytes) > L.conversationBytes) fail('too_large'); bytes += size;
    } catch (e) { if (!(e instanceof ImportFailure)) throw e; conversation = null; errorCode = e.code; }
    totalNodes += c.sourceNodes;
    const item = {ordinal,conversation,errorCode,warnings,counts:c};
    // Even an invalid occurrence invalidates another occurrence of its declared identity.
    try { const o = obj(entry); const source = adapter === 'mapping-v1' ? {namespace:adapter,id:id(o.id ?? o.conversation_id)} : obj(o.source); const key = `${str(source.namespace)}:${id(source.id)}`; const group = identities.get(key) ?? []; group.push(item); identities.set(key,group); } catch { /* Invalid identity already rejects the item. */ }
    return item;
  });
  if (totalNodes > L.totalNodes || bytes > L.stagingBytes) fail('too_large');
  for (const group of identities.values()) if (group.length > 1) for (const item of group) { item.conversation = null; item.errorCode = 'duplicate_source'; }
  return {adapter,items};
}
