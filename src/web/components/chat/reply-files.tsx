import { DownloadIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AudioPlayer } from "@/components/assistant-ui/elements/media-player";
import { t } from "@/i18n";
import { formatBytes } from "@/i18n/format";
import { api } from "@/lib/api";
import { useCurrentThreadId } from "@/state/thread-meta";

export type RunFile = { path: string; size: number; url: string; image: boolean; fileId?: string };

const AUDIO = /\.(mp3|wav|ogg|oga|opus|flac|m4a)$/i;

/** A run can write many files; past this many the chips collapse behind a toggle. */
const FILES_SHOWN = 12;

/** Images inline, a player per audio file, and a download chip per file. */
export function RunFiles({ files, className }: { files: readonly RunFile[]; className?: string }) {
  const [all, setAll] = useState(false);
  if (!files.length) return null;
  const images = files.filter((f) => f.image);
  const audio = files.filter((f) => AUDIO.test(f.path));
  return (
    <div className={className}>
      {images.map((f) => (
        <img key={f.path} src={f.url} alt={f.path} className="animate-blur-in my-2 h-auto max-h-[28rem] w-auto max-w-full rounded-xl border bg-white" />
      ))}
      {audio.map((f) => (
        <div key={f.path} className="my-2 max-w-md">
          <AudioPlayer src={f.url} title={f.path} />
        </div>
      ))}
      <div className="flex flex-wrap gap-1.5">
        {(all ? files : files.slice(0, FILES_SHOWN)).map((f) => (
          <a key={f.path} href={f.url} download={f.path.split("/").pop()} className="hover:bg-muted/60 text-muted-foreground hover:text-foreground flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition-colors duration-(--motion-fast) ease-out-quart">
            <DownloadIcon className="size-3.5 shrink-0" />
            <span className="truncate">{f.path}</span>
            <span className="shrink-0 opacity-70">{formatBytes(f.size)}</span>
          </a>
        ))}
        {files.length > FILES_SHOWN && (
          <button type="button" onClick={() => setAll(!all)} className="hover:bg-muted/60 text-muted-foreground hover:text-foreground rounded-lg border px-2 py-1 text-xs transition-colors duration-(--motion-fast) ease-out-quart">
            {all ? t("tools.showFewer") : t("tools.showMoreFiles", { count: files.length - FILES_SHOWN })}
          </button>
        )}
      </div>
    </div>
  );
}

type Part = { type: string; toolName?: string; args?: unknown; result?: unknown; isError?: boolean };

/**
 * What a reply's runs left for the user: every file any run wrote (the latest copy per path), minus files a
 * later run deleted, which the server drops too. Files imported as artifacts already have their card.
 */
export function replyFiles(parts: readonly Part[]): RunFile[] {
  const files = new Map<string, RunFile>();
  const imported = new Set<string>();
  for (const part of parts) {
    if (part.type !== "tool-call") continue;
    // Only a successful import has an artifact card; a failed one leaves the file here as its only link.
    if (part.toolName === "import_document" && !part.isError && typeof (part.result as { id?: unknown } | undefined)?.id === "string") {
      const id = (part.args as { file_id?: unknown } | undefined)?.file_id;
      if (typeof id === "string") imported.add(id);
    }
    if (part.toolName !== "run_code" || typeof part.result !== "object" || part.result === null) continue;
    const r = part.result as { files?: RunFile[]; deleted?: string[] };
    for (const f of r.files ?? []) files.set(f.path, f);
    for (const p of r.deleted ?? []) files.delete(p);
  }
  return [...files.values()].filter((f) => !f.fileId || !imported.has(f.fileId));
}

// Every finished reply of a chat asks at once when the chat opens, so one answer serves them all.
const outputs = new Map<string, { at: number; paths: Promise<Set<string> | null> }>();
function storedOutputs(threadId: string): Promise<Set<string> | null> {
  const hit = outputs.get(threadId);
  if (hit && Date.now() - hit.at < 5000) return hit.paths;
  const paths = api<{ paths: string[] }>(`/sandbox/${encodeURIComponent(threadId)}/outputs`).then((r) => new Set(r.paths), () => null);
  outputs.set(threadId, { at: Date.now(), paths });
  return paths;
}

/**
 * The files block of a finished reply. Run cards fold into the work log, so this is where outputs live.
 * With `verify`, files no longer stored (deleted in the Library, or drafts that older versions pruned) are
 * left out. A reply that finished while the reader watched skips the check: its files were just stored.
 */
export function ReplyFiles({ parts, verify }: { parts: readonly Part[]; verify: boolean }) {
  const threadId = useCurrentThreadId();
  const files = useMemo(() => replyFiles(parts), [parts]);
  const [stored, setStored] = useState<Set<string> | null>(null);
  const wanted = files.map((f) => f.path).join("\n");
  useEffect(() => {
    if (!verify || !threadId || !wanted) return;
    let live = true;
    void storedOutputs(threadId).then((paths) => live && setStored(paths));
    return () => {
      live = false;
    };
  }, [verify, threadId, wanted]);
  const shown = stored ? files.filter((f) => stored.has(f.path)) : files;
  return <RunFiles files={shown} className="my-2" />;
}
