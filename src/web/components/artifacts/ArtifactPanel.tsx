import { CheckIcon, CodeIcon, CopyIcon, DownloadIcon, EyeIcon, Loader2Icon, RotateCwIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ArtifactVersion } from "@shared/types";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Select } from "@/components/ui/select";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useArtifactPanel } from "@/state/artifacts";
import { useCurrentThreadId } from "@/state/thread-meta";
import { artifactFilename, FRAME_SANDBOX, frameDocument } from "./frame";

const WIDTH_KEY = "okaychat:artifact-width";

const MARKDOWN_CLASSES =
  "text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:bg-muted [&_code]:rounded [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:font-semibold [&_hr]:my-4 [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_pre]:bg-muted/60 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-3 [&_table]:w-full [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6";

function useArtifact(threadId: string, id: string, revision: number) {
  const [versions, setVersions] = useState<ArtifactVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api<ArtifactVersion[]>(`/threads/${threadId}/artifacts/${encodeURIComponent(id)}`)
      .then((v) => !cancelled && setVersions(v))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [threadId, id, revision]);
  return { versions, error };
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ResizeHandle({ onResize }: { onResize: (width: number) => void }) {
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => onResize(Math.min(window.innerWidth * 0.75, Math.max(320, window.innerWidth - ev.clientX)));
    const up = () => {
      document.body.style.removeProperty("cursor");
      document.querySelectorAll("iframe").forEach((f) => f.style.removeProperty("pointer-events"));
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
    };
    document.body.style.cursor = "col-resize";
    // Iframes swallow pointer events mid-drag.
    document.querySelectorAll("iframe").forEach((f) => (f.style.pointerEvents = "none"));
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  return <div onPointerDown={onPointerDown} className="hover:bg-primary/40 absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize max-md:hidden" aria-hidden />;
}

/** Side panel for the artifact selected in the open thread. */
export function ArtifactPanel() {
  const open = useArtifactPanel((s) => s.open);
  const threadId = useCurrentThreadId();
  const close = useArtifactPanel((s) => s.close);
  // Switching threads hides the panel instead of showing another thread's artifact.
  if (!open || open.threadId !== threadId) return null;
  return <ArtifactPanelBody key={`${open.threadId}/${open.id}`} threadId={open.threadId} id={open.id} pinned={open.version} onClose={close} />;
}

function ArtifactPanelBody({ threadId, id, pinned, onClose }: { threadId: string; id: string; pinned?: number; onClose: () => void }) {
  const revision = useArtifactPanel((s) => s.revision);
  const { versions, error } = useArtifact(threadId, id, revision);
  const [selected, setSelected] = useState<number | null>(pinned ?? null);
  const [view, setView] = useState<"preview" | "code">("preview");
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || Math.round(window.innerWidth * 0.45));
  const [reloadKey, setReloadKey] = useState(0);
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const lastRevision = useRef(revision);

  // A new version from the model or a card click selects that version (or the latest).
  useEffect(() => {
    if (lastRevision.current !== revision) {
      lastRevision.current = revision;
      setSelected(pinned ?? null);
    }
  }, [revision, pinned]);

  const resize = (w: number) => {
    setWidth(w);
    localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
  };

  const current = versions?.find((v) => v.version === selected) ?? versions?.at(-1);
  const doc = current ? frameDocument(current.kind, current.content) : null;
  const hasPreview = current?.kind !== "code";
  const showCode = view === "code" || !hasPreview;

  return (
    <aside
      style={{ "--artifact-width": `${width}px` } as React.CSSProperties}
      className="bg-background relative flex h-full shrink-0 flex-col border-l max-md:fixed max-md:inset-0 max-md:z-40 md:w-(--artifact-width)"
    >
      <ResizeHandle onResize={resize} />
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{current?.title ?? id}</p>
          {current && <p className="text-muted-foreground text-xs">{current.kind === "code" ? (current.language ?? "code") : current.kind}</p>}
        </div>
        {versions && versions.length > 1 && (
          <Select
            aria-label="Version"
            className="h-7 w-20 text-xs"
            value={String(current?.version)}
            onValueChange={(v) => setSelected(Number(v))}
            options={versions.map((v) => ({ value: String(v.version), label: `v${v.version}` })).reverse()}
          />
        )}
        {hasPreview && (
          <div className="bg-muted flex rounded-lg p-0.5">
            {(["preview", "code"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={cn("text-muted-foreground flex h-6 items-center gap-1 rounded-md px-2 text-xs", view === v && "bg-background text-foreground shadow-sm")}
              >
                {v === "preview" ? <EyeIcon className="size-3.5" /> : <CodeIcon className="size-3.5" />}
                <span className="max-sm:hidden">{v === "preview" ? "Preview" : "Code"}</span>
              </button>
            ))}
          </div>
        )}
        {doc && view === "preview" && (
          <TooltipIconButton tooltip="Reload" onClick={() => setReloadKey((k) => k + 1)}>
            <RotateCwIcon />
          </TooltipIconButton>
        )}
        <TooltipIconButton tooltip={isCopied ? "Copied" : "Copy"} disabled={!current} onClick={() => current && copyToClipboard(current.content)}>
          {isCopied ? <CheckIcon /> : <CopyIcon />}
        </TooltipIconButton>
        <TooltipIconButton
          tooltip="Download"
          disabled={!current}
          onClick={() => current && download(artifactFilename(current.title, current.kind, current.language), current.content, current.kind === "html" ? "text/html" : current.kind === "svg" ? "image/svg+xml" : "text/plain")}
        >
          <DownloadIcon />
        </TooltipIconButton>
        <TooltipIconButton tooltip="Close" onClick={onClose}>
          <XIcon />
        </TooltipIconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {error ? (
          <p className="text-muted-foreground p-4 text-sm">{error}</p>
        ) : !current ? (
          <div className="text-muted-foreground flex h-full items-center justify-center">
            <Loader2Icon className="size-5 animate-spin" />
          </div>
        ) : showCode ? (
          <pre className="h-full overflow-auto p-4 font-mono text-xs leading-relaxed">{current.content}</pre>
        ) : doc ? (
          <iframe key={`${current.version}-${reloadKey}`} title={current.title} sandbox={FRAME_SANDBOX} srcDoc={doc} className="h-full w-full border-0 bg-white" />
        ) : (
          <div className={cn("h-full overflow-auto px-6 py-4", MARKDOWN_CLASSES)}>
            <Markdown remarkPlugins={[remarkGfm]}>{current.content}</Markdown>
          </div>
        )}
      </div>
    </aside>
  );
}
