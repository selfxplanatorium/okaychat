import { CheckIcon, CodeIcon, CopyIcon, DownloadIcon, EyeIcon, Loader2Icon, RotateCwIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ArtifactVersion } from "@shared/types";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { SimpleMarkdown } from "@/components/ui/simple-markdown";
import { Select } from "@/components/ui/select";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useArtifactPanel } from "@/state/artifacts";
import { useCurrentThreadId } from "@/state/thread-meta";
import { artifactFilename, FRAME_SANDBOX, frameDocument } from "./frame";

const WIDTH_KEY = "okaychat:artifact-width";

type OpenArtifact = { threadId: string; id: string; version?: number };

/** Matches the close transition, so the panel unmounts after it has slid away. */
function panelExitMs() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--panel-animation-duration").trim();
  const ms = raw ? Number.parseFloat(raw) : 240;
  return Number.isFinite(ms) ? ms : 240;
}

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
  return <div onPointerDown={onPointerDown} className="hover:bg-primary/40 absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize transition-colors duration-(--motion-fast) max-md:hidden" aria-hidden />;
}

/** Side panel for the artifact selected in the open thread. */
export function ArtifactPanel() {
  const open = useArtifactPanel((s) => s.open);
  const close = useArtifactPanel((s) => s.close);
  const threadId = useCurrentThreadId();
  const visible = !!open && open.threadId === threadId;
  // A closed panel stays mounted until its slide-out ends; another thread's
  // artifact is hidden immediately instead of animating in the wrong thread.
  const lastOpen = useRef<OpenArtifact | null>(null);
  const wasVisible = useRef(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (visible) lastOpen.current = open;
    else if (open) lastOpen.current = null;
  }, [visible, open]);

  useEffect(() => {
    wasVisible.current = visible;
  }, [visible]);

  const target: OpenArtifact | null =
    open && open.threadId === threadId ? open : open === null && lastOpen.current?.threadId === threadId ? lastOpen.current : null;
  // A fresh open animates; swapping artifacts inside an open panel does not.
  const enter = visible && !wasVisible.current;

  useEffect(() => {
    if (open !== null) {
      setHidden(false);
      return;
    }
    if (!lastOpen.current) return;
    const exitMs = panelExitMs();
    // A little past the transition so the last frame is not clipped.
    const timer = window.setTimeout(() => setHidden(true), exitMs ? exitMs + 40 : 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!target || (hidden && !visible)) return null;
  return (
    <ArtifactPanelBody
      key={`${target.threadId}/${target.id}`}
      threadId={target.threadId}
      id={target.id}
      pinned={target.version}
      open={visible}
      enter={enter}
      onClose={close}
    />
  );
}

function ArtifactPanelBody({
  threadId,
  id,
  pinned,
  open,
  enter,
  onClose,
}: {
  threadId: string;
  id: string;
  pinned?: number;
  open: boolean;
  enter: boolean;
  onClose: () => void;
}) {
  const revision = useArtifactPanel((s) => s.revision);
  const { versions, error } = useArtifact(threadId, id, revision);
  const [selected, setSelected] = useState<number | null>(pinned ?? null);
  const [view, setView] = useState<"preview" | "code">("preview");
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || Math.round(window.innerWidth * 0.45));
  const [reloadKey, setReloadKey] = useState(0);
  // Mount closed, then reveal on the next frame so the width and slide animate.
  const [revealed, setRevealed] = useState(() => open && !enter);
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const lastRevision = useRef(revision);

  useEffect(() => {
    if (!open) {
      setRevealed(false);
      return;
    }
    const frame = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(frame);
  }, [open]);

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
      data-open={revealed}
      style={{ "--artifact-width": `${width}px` } as React.CSSProperties}
      className={cn(
        "shell-artifact bg-background relative flex h-full shrink-0 flex-col overflow-hidden max-md:fixed max-md:inset-0 max-md:z-40",
        revealed ? "md:w-(--artifact-width)" : "md:w-0",
        "max-md:w-full",
        !revealed && "pointer-events-none",
      )}
    >
      {/* Fixed width inside: the panel's own content never reflows while the shell width animates. */}
      <div className="shell-artifact-inner flex h-full w-full shrink-0 flex-col border-l md:w-(--artifact-width)">
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
                  className={cn(
                    "text-muted-foreground flex h-6 items-center gap-1 rounded-md px-2 text-xs transition-colors duration-(--motion-fast) ease-out-quart",
                    view === v && "bg-background text-foreground shadow-sm",
                  )}
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
        <div key={`${current?.version ?? "loading"}-${view}`} className="animate-fade-in min-h-0 flex-1 overflow-hidden">
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
            <SimpleMarkdown className="h-full overflow-auto px-6 py-4">{current.content}</SimpleMarkdown>
          )}
        </div>
      </div>
    </aside>
  );
}
