import { CheckIcon, CodeIcon, CopyIcon, DownloadIcon, EyeIcon, FileSpreadsheetIcon, FileTextIcon, Loader2Icon, RotateCwIcon, WrapTextIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ArtifactVersion, DocumentArtifactKind } from "@shared/types";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useHighlightedCode } from "@/components/ui/code-block";
import { SimpleMarkdown } from "@/components/ui/simple-markdown";
import { Select } from "@/components/ui/select";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { motionAllowed, useAppearance } from "@/state/appearance";
import { useArtifactPanel } from "@/state/artifacts";
import { useBackClose } from "@/hooks/use-back-close";
import { useCurrentThreadId } from "@/state/thread-meta";
import { DocumentPreview } from "./DocumentPreview";
import { artifactFilename, FRAME_SANDBOX, frameDocument } from "./frame";

const WIDTH_KEY = "okaychat:artifact-width";

type OpenArtifact = { threadId: string; id: string; version?: number };

/** Matches the close transition, so the panel unmounts after it has slid away. */
function panelExitMs() {
  if (!motionAllowed("transitions")) return 0;
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

async function downloadFile(name: string, url: string) {
  const blob = await fetch(url).then((r) => r.blob());
  const href = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

const isDocument = (kind: ArtifactVersion["kind"]): kind is DocumentArtifactKind => kind === "pdf" || kind === "docx" || kind === "xlsx";

// highlight.js grammar for each artifact's source. PDF/DOCX sources are HTML, XLSX sources JSON.
function sourceLanguage(version: ArtifactVersion): string {
  switch (version.kind) {
    case "code": return version.language ?? "";
    case "react": return "tsx";
    case "markdown": return "markdown";
    case "xlsx": return "json";
    default: return "xml";
  }
}

function ArtifactSource({ version, wrap }: { version: ArtifactVersion; wrap: boolean }) {
  const html = useHighlightedCode(version.content, sourceLanguage(version));
  // aui-code-block supplies the wrap rules and token colors shared with chat code blocks.
  return (
    <div className="aui-code-block h-full" data-wrap={wrap}>
      <pre className="h-full overflow-auto p-4 font-mono text-xs leading-relaxed">
        {html === null ? <code>{version.content}</code> : (
          // highlight() escapes source text; only its generated token spans become markup.
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </pre>
    </div>
  );
}

function ResizeHandle({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const clamp = (w: number) => Math.round(Math.min(window.innerWidth * 0.75, Math.max(320, w)));
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => onResize(clamp(window.innerWidth - ev.clientX));
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
  // A focusable separator, so arrow keys resize the panel too (Shift for bigger steps).
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 80 : 20;
        const next = e.key === "ArrowLeft" ? width + step : e.key === "ArrowRight" ? width - step : null;
        if (next === null) return;
        e.preventDefault();
        onResize(clamp(next));
      }}
      className="hover:bg-primary/40 focus-visible:bg-primary/40 absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize outline-none transition-colors duration-(--motion-fast) max-md:hidden"
    />
  );
}

/**
 * Phones: the full-screen panel closes with a swipe right from its left edge, like
 * a pushed screen in a native app. A strip catches the touch because the preview
 * iframe would swallow it. The panel follows the finger and, on release, slides
 * the rest of the way out or back with the class transition.
 */
function EdgeSwipeClose({ onClose }: { onClose: () => void }) {
  const drag = useRef<{ x: number; lastX: number; lastT: number; velocity: number; dx: number } | null>(null);
  const panel = (el: Element) => el.closest<HTMLElement>(".shell-artifact-inner");
  return (
    <div
      aria-hidden
      className="absolute inset-y-0 left-0 z-20 w-5 touch-none md:hidden"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, lastX: event.clientX, lastT: event.timeStamp, velocity: 0, dx: 0 };
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        const el = panel(event.currentTarget);
        if (!d || !el) return;
        const dt = event.timeStamp - d.lastT;
        if (dt > 0) d.velocity = (event.clientX - d.lastX) / dt;
        d.lastX = event.clientX;
        d.lastT = event.timeStamp;
        d.dx = Math.max(0, event.clientX - d.x);
        el.style.transition = "none";
        el.style.transform = `translateX(${d.dx}px)`;
      }}
      onPointerUp={(event) => {
        const d = drag.current;
        drag.current = null;
        const el = panel(event.currentTarget);
        if (!d || !el) return;
        el.style.removeProperty("transition");
        if (d.velocity > 0.35 || (d.velocity > -0.35 && d.dx > el.offsetWidth / 2)) {
          // Held until the slide ends, when the closed class has the same position.
          el.style.transform = "translateX(100%)";
          el.addEventListener("transitionend", () => el.style.removeProperty("transform"), { once: true });
          onClose();
        } else {
          el.style.removeProperty("transform");
        }
      }}
      onPointerCancel={(event) => {
        drag.current = null;
        const el = panel(event.currentTarget);
        el?.style.removeProperty("transition");
        el?.style.removeProperty("transform");
      }}
    />
  );
}

/** Side panel for the artifact selected in the open thread. */
export function ArtifactPanel() {
  const open = useArtifactPanel((s) => s.open);
  const close = useArtifactPanel((s) => s.close);
  const threadId = useCurrentThreadId();
  const visible = !!open && open.threadId === threadId;
  // On phones the panel covers the chat, so back closes it.
  useBackClose(visible, close, "(max-width: 767px)");
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
  const defaultWrap = useAppearance((s) => s.wordWrap);
  const [wrapOverride, setWrapOverride] = useState<boolean | null>(null);
  const wrap = wrapOverride ?? defaultWrap;
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
  const docKind = current && isDocument(current.kind) ? current.kind : null;
  const doc = current ? frameDocument(current.kind, current.content) : null;
  const hasCode = !!current && (!docKind || !!current.content);
  const hasPreview = current?.kind !== "code";
  const showCode = !hasPreview || (view === "code" && hasCode);
  const base = current && threadId ? `/api/threads/${threadId}/artifacts/${encodeURIComponent(id)}` : "";
  const fileUrl = current ? `${base}/file?version=${current.version}` : "";
  const previewUrl = current ? `${base}/preview?version=${current.version}` : "";

  return (
    <aside
      data-open={revealed}
      style={{ "--artifact-width": `${width}px` } as React.CSSProperties}
      className={cn(
        "shell-artifact bg-background relative flex h-full shrink-0 flex-col overflow-hidden max-md:safe-top max-md:safe-bottom max-md:fixed max-md:inset-0 max-md:z-40",
        revealed ? "md:w-(--artifact-width)" : "md:w-0",
        "max-md:w-full",
        !revealed && "pointer-events-none",
      )}
    >
      {/* Fixed width inside: the panel's own content never reflows while the shell width animates. */}
      <div className="shell-artifact-inner flex h-full w-full shrink-0 flex-col border-l md:w-(--artifact-width)">
        <ResizeHandle width={width} onResize={resize} />
        <EdgeSwipeClose onClose={onClose} />
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{current?.title ?? id}</p>
            {current && (
              <p className="text-muted-foreground flex items-center gap-1 text-xs">
                {docKind ? docKind === "xlsx" ? <FileSpreadsheetIcon className="size-3" /> : <FileTextIcon className="size-3" /> : null}
                {current.kind === "code" ? (current.language ?? "code") : current.kind}
                {current.size ? ` · ${Math.max(1, Math.round(current.size / 1024))} KB` : ""}
              </p>
            )}
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
          {hasPreview && hasCode && (
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
          {showCode && (
            <TooltipIconButton
              tooltip={wrap ? "Disable line wrapping" : "Enable line wrapping"}
              aria-label="Wrap code"
              aria-pressed={wrap}
              className="aria-pressed:bg-accent aria-pressed:text-accent-foreground"
              onClick={() => setWrapOverride(!wrap)}
            >
              <WrapTextIcon />
            </TooltipIconButton>
          )}
          {(doc || docKind === "docx") && view === "preview" && (
            <TooltipIconButton tooltip="Reload" onClick={() => setReloadKey((k) => k + 1)}>
              <RotateCwIcon />
            </TooltipIconButton>
          )}
          <TooltipIconButton tooltip={isCopied ? "Copied" : "Copy"} disabled={!hasCode} onClick={() => current && hasCode && copyToClipboard(current.content)}>
            {isCopied ? <CheckIcon /> : <CopyIcon />}
          </TooltipIconButton>
          <TooltipIconButton
            tooltip="Download"
            disabled={!current}
            onClick={() => {
              if (!current) return;
              const name = artifactFilename(current.title, current.kind, current.language);
              if (docKind) void downloadFile(name, fileUrl);
              else download(name, current.content, current.kind === "html" ? "text/html" : current.kind === "svg" ? "image/svg+xml" : "text/plain");
            }}
          >
            <DownloadIcon />
          </TooltipIconButton>
          <TooltipIconButton tooltip="Close" command="chat.artifact" onClick={onClose}>
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
            <ArtifactSource version={current} wrap={wrap} />
          ) : docKind ? (
            <DocumentPreview
              key={`${current.version}-${reloadKey}`}
              kind={docKind}
              fileUrl={fileUrl}
              previewUrl={previewUrl}
              title={current.title}
            />
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
