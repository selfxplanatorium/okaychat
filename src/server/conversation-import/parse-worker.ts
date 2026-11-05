import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { IMPORT_LIMITS, type PortableFile } from '../../shared/chat-import.js';
import { parseJson, ImportFailure, fail } from './json.js';
import { normalizeFile } from './formats.js';

// The entry has no database, filesystem, network, model, or tool imports.
try {
  const request = workerData as { mode: 'parse' | 'export'; bytes: Uint8Array; admissionTime: number };
  const parsed = parseJson(request.bytes);
  const normalized = normalizeFile(parsed,request.admissionTime);
  if (request.mode === 'parse') parentPort!.postMessage({ok:true,value:normalized});
  else {
    if (normalized.items.some((item)=>!item.conversation)) fail('invalid_conversation');
    const file: PortableFile = {format:'okaychat.conversations',version:1,exportedAt:request.admissionTime,conversations:normalized.items.map((item)=>item.conversation!)};
    const bytes = new TextEncoder().encode(JSON.stringify(file));
    if (bytes.length > IMPORT_LIMITS.inputBytes) fail('export_too_large');
    const identities=file.conversations.map((c)=>({namespace:c.source.namespace,id:c.source.id,hash:createHash('sha256').update(JSON.stringify(c)).digest('hex')}));
    parentPort!.postMessage({ok:true,value:{bytes,identities}},[bytes.buffer]);
  }
} catch (error) {
  parentPort!.postMessage({ok:false,code:error instanceof ImportFailure ? error.code : 'internal_error'});
}
