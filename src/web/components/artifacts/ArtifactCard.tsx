import { AppWindowIcon, CodeIcon, FileSpreadsheetIcon, FileTextIcon, ImageIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ArtifactKind, ArtifactToolResult } from "@shared/types";
import { t } from "@/i18n";
import { formatBytes } from "@/i18n/format";
import { cn } from "@/lib/utils";
import { useArtifactPanel } from "@/state/artifacts";
import { useCurrentThreadId } from "@/state/thread-meta";

const ICONS: Record<ArtifactKind, typeof CodeIcon> = {
  html: AppWindowIcon,
  react: AppWindowIcon,
  svg: ImageIcon,
  markdown: FileTextIcon,
  code: CodeIcon,
  pdf: FileTextIcon,
  docx: FileTextIcon,
  xlsx: FileSpreadsheetIcon,
};

const isDocument = (kind: ArtifactKind | undefined) => kind === "pdf" || kind === "docx" || kind === "xlsx";

type Args = { id?: string; title?: string; kind?: ArtifactKind; content?: string; edits?: unknown[]; docx_ops?: unknown[]; xlsx_ops?: unknown[]; pdf_ops?: unknown[] };

/** Inline card for create_artifact / update_artifact calls. Opens the side panel. */
export function ArtifactCard({ args, result, status, action }: { args: unknown; result: unknown; status: { type: string } | undefined; action: "create" | "update" }) {
  const threadId = useCurrentThreadId();
  const show = useArtifactPanel((s) => s.show);
  const a = (args ?? {}) as Args;
  const r = result as ArtifactToolResult | undefined;
  const running = status?.type === "running";
  const failed = status?.type === "incomplete" || (!running && typeof result === "string");
  const title = r?.title ?? a.title ?? a.id ?? t("artifacts.fallbackTitle");
  const Icon = ICONS[r?.kind ?? a.kind ?? "code"] ?? CodeIcon;

  // Open the panel when a call finishes live. History loads mount already complete and stay closed.
  const sawRunning = useRef(running);
  useEffect(() => {
    if (running) sawRunning.current = true;
    else if (sawRunning.current && r?.id && threadId) {
      sawRunning.current = false;
      show(threadId, r.id);
    }
  }, [running, r?.id, threadId, show]);

  const ops = a.docx_ops ?? a.xlsx_ops ?? a.pdf_ops;
  const edits = a.edits?.length || ops?.length || 0;
  const detail = running
    ? isDocument(a.kind)
      ? t("artifacts.building")
      : a.content
        ? t("artifacts.lines", { count: a.content.split("\n").length })
        : edits
          ? t("artifacts.edits", { count: edits })
          : "…"
    : failed
      ? typeof result === "string"
        ? result
        : t("artifacts.failed")
      : isDocument(r?.kind)
        ? t(action === "create" ? "artifacts.documentCreated" : "artifacts.documentUpdated", { kind: r!.kind.toUpperCase(), size: formatBytes(r!.size ?? 0) })
        : t(action === "create" ? "artifacts.created" : "artifacts.updated", { version: r?.version ?? "" });

  return (
    <button
      data-command="artifact.open"
      type="button"
      disabled={running || !r?.id || !threadId}
      onClick={() => r && threadId && show(threadId, r.id, r.version)}
      className="shell-artifact-card hover:bg-muted/60 animate-rise-in my-2 flex w-full max-w-md items-center gap-3 rounded-xl border px-3 py-2.5 text-left hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:shadow-none"
    >
      <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
        {running ? <Loader2Icon className="size-4 animate-spin" /> : failed ? <TriangleAlertIcon className="text-warning size-4" /> : <Icon className="size-4" />}
      </span>
      <span className="min-w-0">
        <span className={cn("block truncate text-sm font-medium", running && "shimmer")}>{title}</span>
        <span className="text-muted-foreground line-clamp-2 text-xs">{detail}</span>
      </span>
    </button>
  );
}
