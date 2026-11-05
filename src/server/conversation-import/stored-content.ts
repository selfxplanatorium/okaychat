import type { PortableMessage } from '../../shared/chat-import.js';

/** The only stored part vocabulary produced by the text importer. No executable tool shapes. */
export function storedContent(message: PortableMessage) {
  const kind = message.role === 'quarantine' ? 'quarantine' : message.role === 'tool' ? 'tool' : 'transcript';
  const parts = message.parts.map((part) => {
    if (kind === 'quarantine') {
      return {type:'data-imported-quarantine',data:{
        originalRole:message.originalRole,
        text:'text' in part ? part.text : '',
        ...(part.type === 'missing-attachment' ? {missingAttachment:{kind:part.kind,name:part.name}} : {}),
      }};
    }
    return part.type === 'text' ? part
      : part.type === 'missing-attachment' ? {type:'data-imported-missing-attachment',data:{kind:part.kind,name:part.name}}
      : {type:'data-imported-tool',data:{name:part.name,input:null,output:part.text,state:'interrupted',references:[]}};
  });
  return {role:message.role === 'user' ? 'user' : 'assistant',parts,metadata:{custom:{importedTranscript:{version:1,sourceMessageId:message.id,kind,originalRole:message.originalRole}}}};
}
