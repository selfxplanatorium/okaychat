import type { UIMessage } from 'ai';
import { wrapUntrusted } from '../prompt-injection.js';

/** Only server-built provenance is persisted by the importer; native appends strip this namespace. */
export function transcriptKind(message: UIMessage): string | null {
  const metadata = message.metadata as {custom?:{importedTranscript?:{version?:unknown;kind?:unknown}}}|undefined;
  const value = metadata?.custom?.importedTranscript;
  return value?.version === 1 && typeof value.kind === 'string' ? value.kind : null;
}
export function envelopeTranscript(messages: UIMessage[]): UIMessage[] {
  return messages.flatMap((message) => {
    const kind = transcriptKind(message);
    if (kind === 'quarantine' || message.parts.some((part)=>part.type === 'data-imported-quarantine')) return [];
    if (!kind) return [message];
    const text = message.parts.map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'data-imported-tool' || part.type === 'data-imported-missing-attachment') return JSON.stringify((part as {data?:unknown}).data ?? {});
      return '';
    }).filter(Boolean).join('\n');
    // Remove the marker from the derived projection, making repeat projections idempotent.
    const metadata = message.metadata as {custom?:Record<string,unknown>}|undefined;
    const custom = {...metadata?.custom}; delete custom.importedTranscript;
    return [{...message,role:message.role === 'user' ? 'user' as const : 'assistant' as const,metadata:{...metadata,custom},parts:[{type:'text' as const,text:wrapUntrusted(text,{kind:'past_chat',name:'imported conversation'}).text}]}];
  });
}
