import { t, type PlainMessageKey } from "@/i18n";
import type { MissingKind } from "@shared/chat-import";
const MISSING:Record<MissingKind,PlainMessageKey>={image:"conversationImport.missing_image",file:"conversationImport.missing_file",audio:"conversationImport.missing_audio",video:"conversationImport.missing_video",unknown:"conversationImport.missing_unknown"};
export function ImportedMissingAttachment({data}:{data:unknown}) {
  const record=(data??{}) as {kind?:unknown;name?:unknown};
  const kind=typeof record.kind==="string" && Object.hasOwn(MISSING,record.kind) ? record.kind as MissingKind : "unknown";
  return <span className="text-muted-foreground my-1 block break-words text-sm" data-imported-missing-attachment>{t(MISSING[kind])}{typeof record.name==="string" && record.name ? <span className="ms-2">{record.name}</span> : null}</span>;
}
/** Historical instructions are escaped text with no Markdown, URL, tool or action renderers. */
export function ImportedQuarantineRecord({data}:{data:unknown}) {
  const record=(data??{}) as {originalRole?:unknown;text?:unknown;missingAttachment?:unknown};
  return <details className="border-border/60 my-2 rounded-lg border text-sm" data-imported-quarantine>
    <summary className="min-h-11 cursor-pointer break-words px-3 py-3 font-medium focus-visible:ring-2 focus-visible:ring-ring">{t("conversationImport.quarantine")}</summary>
    <div className="space-y-2 px-3 pb-3">
      {typeof record.originalRole==="string" && <p className="text-muted-foreground break-words text-xs">{t("conversationImport.originalRole",{role:record.originalRole})}</p>}
      {typeof record.text==="string" && <p className="whitespace-pre-wrap break-words">{record.text}</p>}
      {record.missingAttachment ? <ImportedMissingAttachment data={record.missingAttachment} /> : null}
    </div>
  </details>;
}
