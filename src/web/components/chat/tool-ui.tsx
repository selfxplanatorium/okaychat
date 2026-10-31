import { defineToolkit, type ToolCallMessagePartComponent } from "@assistant-ui/react";
import type { InjectionReport } from "@shared/types";
import { BookOpenIcon, BotIcon, CheckIcon, ChevronDownIcon, CircleDashedIcon, CircleMinusIcon, DownloadIcon, EyeIcon, FileTextIcon, GlobeIcon, ImageIcon, Loader2Icon, SearchIcon, SquareTerminalIcon, TelescopeIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { SimpleMarkdown } from "@/components/ui/simple-markdown";
import { t } from "@/i18n";
import { formatBytes, formatCost, formatList, formatNumber } from "@/i18n/format";
import { Trans } from "@/i18n/react";
import { useData } from "@/state/data";
import { useKnowledgeCitationStore } from "@/state/chat-knowledge";
import { RunFiles, type RunFile } from "./reply-files";
import { cn } from "@/lib/utils";

type SearchResult = { title: string; url: string; snippet: string };

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function Favicon() {
  // A local icon, not a remote favicon service: a crafted host would otherwise be sent upstream.
  return <GlobeIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />;
}

/** Quiet advisory badge on the real tool row. Never a modal and never a block. */
export function InjectionBadge({ report, className }: { report?: InjectionReport; className?: string }) {
  if (!report?.flagged) return null;
  return (
    <span
      data-slot="tool-injection-badge"
      title={t("tools.injectionBadgeHint")}
      className={cn("text-muted-foreground inline-flex max-w-full items-center gap-1.5 text-xs", className)}
    >
      <TriangleAlertIcon aria-hidden className="text-warning size-3.5 shrink-0" />
      <span className="truncate">{t("tools.injectionBadge")}</span>
    </span>
  );
}

function ToolShell({ icon, label, running, error, injection, children }: { icon: ReactNode; label: ReactNode; running: boolean; error?: string; injection?: InjectionReport; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2 text-sm">
      <button type="button" onClick={() => setOpen(!open)} className="text-muted-foreground hover:text-foreground flex max-w-full items-center gap-2 transition-colors duration-(--motion-fast) ease-out-quart" disabled={!children}>
        {/* The spinner and the result icon share a slot so completion crossfades. */}
        <span className="relative size-4 shrink-0">
          <Loader2Icon className={cn("absolute inset-0 size-4 transition-[opacity,scale] duration-(--motion-fast) ease-out-quart motion-reduce:animate-none", running ? "scale-100 animate-spin opacity-100" : "scale-50 opacity-0")} />
          <span className={cn("absolute inset-0 flex items-center justify-center transition-[opacity,scale] duration-(--motion-base) ease-spring", running ? "scale-50 opacity-0" : "scale-100 opacity-100")}>
            {error ? <TriangleAlertIcon className="text-warning size-4" /> : icon}
          </span>
        </span>
        <span className={cn("truncate", running && "shimmer")}>{label}</span>
        {children && <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform duration-(--motion-base) ease-out-expo", open && "rotate-180")} />}
      </button>
      {injection?.flagged ? <InjectionBadge report={injection} className="mt-1 ml-6" /> : null}
      {error && <p className="text-muted-foreground animate-rise-in mt-1 ml-6 text-xs">{error}</p>}
      {open && children && <div className="animate-rise-in mt-2 ml-6">{children}</div>}
    </div>
  );
}

export const toolkit = defineToolkit({
  web_search: {
    type: "backend",
    render: ({ args, result, status }) => {
      const r = result as { engine?: string; results?: SearchResult[]; injection?: InjectionReport } | undefined;
      const results = r?.results ?? [];
      const running = status?.type === "running";
      const error = status?.type === "incomplete" ? t("tools.searchFailed") : undefined;
      const query = (args as { query?: string })?.query ?? "";
      return (
        <ToolShell icon={<SearchIcon className="size-4" />} running={running} error={error} injection={r?.injection} label={running ? t("tools.searching", { query }) : t("tools.searched", { query, count: results.length })}>
          {results.length > 0 && (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {results.map((res) => (
                <a key={res.url} href={res.url} target="_blank" rel="noreferrer" className="hover:bg-muted/60 flex flex-col gap-0.5 rounded-lg border px-2.5 py-2">
                  <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <Favicon /> {host(res.url)}
                  </span>
                  <span className="line-clamp-1 font-medium">{res.title}</span>
                  {res.snippet && <span className="text-muted-foreground line-clamp-2 text-xs">{res.snippet}</span>}
                </a>
              ))}
            </div>
          )}
        </ToolShell>
      );
    },
  },
  web_fetch: {
    type: "backend",
    render: ({ args, result, status }) => {
      const url = (args as { url?: string })?.url ?? "";
      const r = result as { title?: string; via?: string; pages?: number; content?: string; injection?: InjectionReport } | undefined;
      const running = status?.type === "running";
      const error = status?.type === "incomplete" ? t("tools.pageReadFailed") : undefined;
      return (
        <ToolShell
          icon={<FileTextIcon className="size-4" />}
          running={running}
          error={error}
          injection={r?.injection}
          label={
            <>
              <Trans
                k={r?.via === "scrapling" ? (running ? "tools.readingViaScrapling" : "tools.readViaScrapling") : running ? "tools.reading" : "tools.read"}
                params={{
                  page: (
                    <a href={url} target="_blank" rel="noreferrer" className="hover:underline" onClick={(e) => e.stopPropagation()}>
                      {r?.title || host(url)}
                    </a>
                  ),
                }}
              />
            </>
          }
        >
          {r?.content && <pre className="bg-muted/40 max-h-64 overflow-auto rounded-lg p-3 font-sans text-xs whitespace-pre-wrap">{r.content.slice(0, 4000)}</pre>}
        </ToolShell>
      );
    },
  },
  create_artifact: {
    type: "backend",
    render: ({ args, result, status }) => <ArtifactCard args={args} result={result} status={status} action="create" />,
  },
  update_artifact: {
    type: "backend",
    render: ({ args, result, status }) => <ArtifactCard args={args} result={result} status={status} action="update" />,
  },
  read_artifact: {
    type: "backend",
    render: ({ args, result, status }) => (
      <ToolShell
        icon={<BookOpenIcon className="size-4" />}
        running={status?.type === "running"}
        injection={(result as { injection?: InjectionReport } | undefined)?.injection}
        label={t("tools.readArtifact", { id: (args as { id?: string })?.id ?? "" })}
      />
    ),
  },
  create_document: {
    type: "backend",
    render: ({ args, result, status }) => <ArtifactCard args={args} result={result} status={status} action="create" />,
  },
  edit_document: {
    type: "backend",
    render: ({ args, result, status }) => <ArtifactCard args={args} result={result} status={status} action="update" />,
  },
  import_document: {
    type: "backend",
    render: ({ args, result, status }) => <ArtifactCard args={args} result={result} status={status} action="create" />,
  },
  read_document: {
    type: "backend",
    render: ({ args, result, status }) => (
      <ToolShell
        icon={<BookOpenIcon className="size-4" />}
        running={status?.type === "running"}
        injection={(result as { injection?: InjectionReport } | undefined)?.injection}
        label={t("tools.readDocument", { id: (args as { id?: string })?.id ?? "" })}
      />
    ),
  },
  view_artifact: {
    type: "backend",
    render: ({ args, result, status }) => {
      const a = (args ?? {}) as { id?: string; page?: number; sheet?: string };
      const r = (result ?? {}) as { capture?: string; width?: number; height?: number };
      const running = status?.type === "running";
      const target = a.sheet ?? t("tools.pageNumber", { page: a.page || 1 });
      return (
        <ToolShell
          icon={<EyeIcon className="size-4" />}
          running={running}
          label={
            running
              ? t("tools.lookingAt", { id: a.id ?? t("tools.artifact") })
              : t("tools.lookedAt", { id: a.id ?? t("tools.artifact"), target: r.capture ?? target })
          }
        />
      );
    },
  },
  deep_research: {
    type: "backend",
    render: ({ result, status }) => <ResearchCard result={result} running={status?.type === "running"} />,
  },
  delegate_task: {
    type: "backend",
    render: ({ args, result, status }) => <SubagentCard args={args} result={result} running={status?.type === "running"} />,
  },
  generate_image: {
    type: "backend",
    render: ({ args, result, status }) => <GeneratedImage args={args} result={result} running={status?.type === "running"} />,
  },
  run_code: {
    type: "backend",
    render: ({ args, result, status }) => <RunCodeCard args={args} result={result} running={status?.type === "running"} />,
  },
  search_knowledge: {
    type: "backend",
    render: ({ args, result, status }) => {
      const r = result as { hits?: Array<{ chunkId: string; title: string; text: string; offset: number }>; mode?: string; injection?: InjectionReport } | undefined;
      const hits = r?.hits ?? [];
      const running = status?.type === "running";
      const query = (args as { query?: string })?.query ?? "";
      return (
        <ToolShell
          icon={<BookOpenIcon className="size-4" />}
          running={running}
          error={status?.type === "incomplete" ? t("tools.knowledgeSearchFailed") : undefined}
          injection={r?.injection}
          label={running ? t("tools.knowledgeSearching", { query }) : t("tools.knowledgeSearched", { query, count: hits.length })}
        >
          {hits.length > 0 && (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {hits.map((hit) => (
                <button
                  key={hit.chunkId}
                  type="button"
                  onClick={() => useKnowledgeCitationStore.getState().open(hit.chunkId)}
                  className="hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-ring flex min-w-0 flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-start pointer-coarse:min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <span className="text-muted-foreground text-xs">{t("knowledge.citationOffset", { start: formatNumber(hit.offset), end: formatNumber(hit.offset + hit.text.length) })}</span>
                  <span className="line-clamp-1 font-medium">{hit.title}</span>
                  <span className="text-muted-foreground line-clamp-2 text-xs">{hit.text}</span>
                </button>
              ))}
            </div>
          )}
        </ToolShell>
      );
    },
  },
  read_knowledge_chunk: {
    type: "backend",
    render: ({ result, status }) => {
      const r = result as { chunkId?: string; title?: string; text?: string; injection?: InjectionReport } | undefined;
      const running = status?.type === "running";
      return (
        <ToolShell icon={<BookOpenIcon className="size-4" />} running={running} injection={r?.injection} label={t("tools.knowledgeRead")}>
          {r?.chunkId && r.text ? (
            <button type="button" onClick={() => useKnowledgeCitationStore.getState().open(r.chunkId!)} className="text-primary hover:underline rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-6">
              {t("knowledge.openPassage")}
            </button>
          ) : null}
        </ToolShell>
      );
    },
  },
});

// generative-frame renders its helper tools as nothing, which leaves an empty row in the reasoning group.
export const widgetHelperRenders: Record<string, ToolCallMessagePartComponent> = {
  read_me: ({ status }) => {
    const running = status?.type === "running";
    return <ToolShell icon={<BookOpenIcon className="size-4" />} running={running} label={running ? t("tools.readingWidgetGuide") : t("tools.readWidgetGuide")} />;
  },
  preview_widget: ({ status }) => {
    const running = status?.type === "running";
    return <ToolShell icon={<EyeIcon className="size-4" />} running={running} label={running ? t("tools.previewingWidget") : t("tools.previewedWidget")} />;
  },
};

type RunCodeResult = {
  language: "python" | "bash";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stopped: string | null;
  durationMs: number;
  files: RunFile[];
  tooLarge?: Array<{ path: string; size: number }>;
  injection?: InjectionReport;
};

function RunCodeCard({ args, result, running }: { args: unknown; result: unknown; running: boolean }) {
  const a = (args ?? {}) as { language?: "python" | "bash"; code?: string };
  const r = typeof result === "object" && result ? (result as RunCodeResult) : undefined;
  const language = (r?.language ?? a.language) === "bash" ? "Bash" : "Python";
  const failed = !running && (typeof result === "string" || (r ? r.exitCode !== 0 : false));
  const seconds = r ? t("tools.seconds", { s: formatNumber(r.durationMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) : "";
  const label = running
    ? t("tools.running", { language })
    : typeof result === "string" || !r
      ? t("tools.couldNotRun", { language })
      : r.stopped
        ? t("tools.stopped", { language, reason: r.stopped })
        : r.exitCode === 0
          ? t("tools.ran", { language, seconds })
          : t("tools.exited", { language, code: r.exitCode ?? "", seconds });
  return (
    <div className="my-2">
      <ToolShell icon={<SquareTerminalIcon className="size-4" />} running={running} error={failed && typeof result === "string" ? result : undefined} injection={r?.injection} label={label}>
        <div className="flex flex-col gap-2">
          {a.code && <pre className="bg-muted/40 max-h-80 overflow-auto rounded-lg p-3 font-mono text-xs">{a.code}</pre>}
          {r?.stdout && <pre className="max-h-80 overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap">{r.stdout}</pre>}
          {r?.stderr && <pre className={cn("max-h-80 overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap", failed ? "text-warning" : "text-muted-foreground")}>{r.stderr}</pre>}
          {r && !r.stdout && !r.stderr && <p className="text-muted-foreground text-xs">{t("tools.noOutput")}</p>}
        </div>
      </ToolShell>
      {r && <RunFiles files={r.files} className="ml-6" />}
      {r?.tooLarge?.length ? (
        <p className="text-muted-foreground ml-6 mt-1.5 text-xs">
          {t("tools.notSaved", { files: formatList(r.tooLarge.map((f) => `${f.path} (${formatBytes(f.size)})`)) })}
        </p>
      ) : null}
    </div>
  );
}

function GeneratedImage({ args, result, running }: { args: unknown; result: unknown; running: boolean }) {
  const prompt = (args as { prompt?: string })?.prompt ?? "";
  const image = result as { id?: string; url?: string; mime?: string; width?: number; height?: number } | string | undefined;
  if (running || !image) {
    return (
      <div className="bg-muted/40 my-2 flex aspect-square w-full max-w-sm flex-col items-center justify-center gap-2 rounded-xl border p-4 text-center">
        <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
        <span className="shimmer text-sm">{t("tools.generatingImage")}</span>
        <span className="text-muted-foreground line-clamp-3 text-xs">{prompt}</span>
      </div>
    );
  }
  if (typeof image === "string" || !image.url) {
    return <ToolShell icon={<ImageIcon className="size-4" />} running={false} error={typeof image === "string" ? image : t("tools.noImage")} label={t("tools.imageFailed")} />;
  }
  return (
    <figure className="group/img animate-blur-in relative my-2 w-fit max-w-full">
      <a href={image.url} target="_blank" rel="noreferrer">
        <img
          src={image.url}
          alt={prompt}
          width={image.width}
          height={image.height}
          className="h-auto max-h-[32rem] w-auto max-w-full rounded-xl border"
        />
      </a>
      <a
        href={image.url}
        download={`${image.id}.${image.mime?.split("/")[1]?.replace("jpeg", "jpg") ?? "png"}`}
        aria-label={t("tools.downloadImage")}
        className="surface-glass text-muted-foreground hover:text-foreground absolute top-2 right-2 rounded-lg border p-1.5 opacity-0 transition-opacity duration-(--motion-fast) ease-out-quart group-hover/img:opacity-100 focus-visible:opacity-100"
      >
        <DownloadIcon className="size-4" />
      </a>
    </figure>
  );
}

type SubagentProgress = { model: string; status: "running" | "done"; text: string; steps: number; tools: string[]; cost?: number; injection?: InjectionReport };

function SubagentCard({ args, result, running }: { args: unknown; result: unknown; running: boolean }) {
  const [open, setOpen] = useState(false);
  const models = useData((s) => s.models);
  const a = (args ?? {}) as { task?: string; model?: string };
  const r = typeof result === "object" && result ? (result as SubagentProgress) : undefined;
  const failed = !running && typeof result === "string";
  const busy = running || r?.status === "running";
  const ref = r?.model ?? a.model;
  const name = models.find((m) => m.ref === ref)?.name ?? ref?.split("/").pop() ?? t("tools.subagent");
  const detail = [
    r?.steps ? t("tools.steps", { count: r.steps }) : null,
    r?.tools.length ? t("tools.toolCalls", { count: r.tools.length }) : null,
    r?.cost ? formatCost(r.cost) : null,
  ]
    .filter(Boolean)
    .join(t("tools.detailSeparator"));
  return (
    <div className="my-2 rounded-xl border text-sm">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-(--motion-fast) ease-out-quart hover:bg-muted/40">
        <span className="bg-muted relative flex size-8 shrink-0 items-center justify-center rounded-lg">
          <Loader2Icon className={cn("absolute size-4 transition-[opacity,scale] duration-(--motion-fast) ease-out-quart motion-reduce:animate-none", busy ? "scale-100 animate-spin opacity-100" : "scale-50 opacity-0")} />
          <span className={cn("absolute inset-0 flex items-center justify-center transition-[opacity,scale] duration-(--motion-base) ease-spring", busy ? "scale-50 opacity-0" : "scale-100 opacity-100")}>
            {failed ? <TriangleAlertIcon className="text-warning size-4" /> : <BotIcon className="size-4" />}
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate font-medium", busy && "shimmer")}>{busy ? t("tools.working", { name }) : failed ? t("tools.failed", { name }) : t("tools.finished", { name })}</span>
          <span className="text-muted-foreground block truncate text-xs">{failed ? (result as string) : detail || a.task}</span>
        </span>
        <ChevronDownIcon className={cn("text-muted-foreground size-4 shrink-0 transition-transform duration-(--motion-base) ease-out-expo", open && "rotate-180")} />
      </button>
      <InjectionBadge report={r?.injection} className="px-3 pb-2 -mt-0.5" />
      {open && (
        <div className="animate-rise-in flex flex-col gap-3 border-t px-3 py-3">
          {a.task && (
            <div>
              <p className="text-muted-foreground mb-1 text-xs font-medium">{t("tools.task")}</p>
              <p className="text-muted-foreground text-xs whitespace-pre-wrap">{a.task}</p>
            </div>
          )}
          {r?.text && (
            <div>
              <p className="text-muted-foreground mb-1 text-xs font-medium">{t("tools.report")}</p>
              <SimpleMarkdown className="max-h-96 overflow-auto">{r.text}</SimpleMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type ResearchQuestion = { question: string; round: number; status: "queued" | "running" | "done" | "failed" | "skipped"; error?: string };
type ResearchProgress = {
  phase: "planning" | "researching" | "reviewing" | "done";
  objective: string;
  questions: ResearchQuestion[];
  sources: Array<{ url: string; title: string }>;
  conflicts: string[];
  gaps: string[];
  searches: number;
  limited?: "searches" | "steps";
  cost?: number;
  injection?: InjectionReport;
};

function QuestionStatus({ status }: { status: ResearchQuestion["status"] }) {
  const className = "mt-0.5 size-3.5 shrink-0";
  if (status === "running") return <Loader2Icon className={cn(className, "animate-spin motion-reduce:animate-none")} />;
  if (status === "done") return <CheckIcon className={cn(className, "text-primary")} />;
  if (status === "failed") return <TriangleAlertIcon className={cn(className, "text-warning")} />;
  if (status === "skipped") return <CircleMinusIcon className={cn(className, "text-muted-foreground")} />;
  return <CircleDashedIcon className={cn(className, "text-muted-foreground")} />;
}

/** Live progress of a deep research run. Open while it works, so the questions are visible as they finish. */
function ResearchCard({ result, running }: { result: unknown; running: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const r = typeof result === "object" && result ? (result as ResearchProgress) : undefined;
  const failed = !running && (typeof result === "string" || r?.phase !== "done");
  const busy = !failed && (running || r?.phase !== "done");
  const open = userOpen ?? busy;
  const questions = r?.questions ?? [];
  const done = questions.filter((q) => q.status === "done").length;
  const label = failed
    ? t("tools.researchFailed")
    : !r || r.phase === "planning"
      ? t("tools.researchPlanning")
      : r.phase === "reviewing"
        ? t("tools.researchReviewing")
        : r.phase === "researching"
          ? t("tools.researchWorking", { done, count: questions.length })
          : t("tools.researchDone", { count: questions.length });
  const detail = [
    r?.searches ? t("tools.researchSearches", { count: r.searches }) : null,
    r?.sources.length ? t("tools.researchPages", { count: r.sources.length }) : null,
    r?.cost ? formatCost(r.cost) : null,
  ]
    .filter(Boolean)
    .join(t("tools.detailSeparator"));
  const section = "text-muted-foreground mb-1.5 text-xs font-medium";
  return (
    <div className="my-2 rounded-xl border text-sm">
      <button type="button" aria-expanded={open} onClick={() => setUserOpen(!open)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-(--motion-fast) ease-out-quart hover:bg-muted/40">
        <span className="bg-muted relative flex size-8 shrink-0 items-center justify-center rounded-lg">
          <Loader2Icon className={cn("absolute size-4 transition-[opacity,scale] duration-(--motion-fast) ease-out-quart motion-reduce:animate-none", busy ? "scale-100 animate-spin opacity-100" : "scale-50 opacity-0")} />
          <span className={cn("absolute inset-0 flex items-center justify-center transition-[opacity,scale] duration-(--motion-base) ease-spring", busy ? "scale-50 opacity-0" : "scale-100 opacity-100")}>
            {failed ? <TriangleAlertIcon className="text-warning size-4" /> : <TelescopeIcon className="size-4" />}
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate font-medium", busy && "shimmer")}>{label}</span>
          <span className="text-muted-foreground block truncate text-xs">{typeof result === "string" ? result : detail || r?.objective}</span>
        </span>
        <ChevronDownIcon className={cn("text-muted-foreground size-4 shrink-0 transition-transform duration-(--motion-base) ease-out-expo", open && "rotate-180")} />
      </button>
      <InjectionBadge report={r?.injection} className="px-3 pb-2 -mt-0.5" />
      {open && r && (
        <div className="animate-rise-in flex flex-col gap-4 border-t px-3 py-3">
          {r.objective && (
            <div>
              <p className={section}>{t("tools.researchObjective")}</p>
              <p className="text-pretty">{r.objective}</p>
            </div>
          )}
          {questions.length > 0 && (
            <div>
              <p className={section}>{t("tools.researchQuestions")}</p>
              <ol className="flex flex-col gap-1.5">
                {questions.map((q, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <QuestionStatus status={q.status} />
                    <span className="min-w-0 flex-1">
                      <span className={cn("text-pretty", q.status === "running" && "shimmer")}>{q.question}</span>
                      {q.round > 1 && <span className="bg-muted text-muted-foreground ml-1.5 rounded px-1.5 py-px text-[0.6875rem] whitespace-nowrap">{t("tools.researchFollowUp")}</span>}
                      {q.status === "failed" && q.error && <span className="text-muted-foreground block text-xs">{q.error}</span>}
                      {q.status === "skipped" && <span className="text-muted-foreground block text-xs">{t("tools.researchSkipped")}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {r.conflicts.length > 0 && (
            <div>
              <p className={section}>{t("tools.researchConflicts")}</p>
              <ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-4 text-xs">
                {r.conflicts.map((item, i) => <li key={i}>{item}</li>)}
              </ul>
            </div>
          )}
          {r.phase === "done" && r.gaps.length > 0 && (
            <div>
              <p className={section}>{t("tools.researchOpen")}</p>
              <ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-4 text-xs">
                {r.gaps.map((item, i) => <li key={i}>{item}</li>)}
              </ul>
            </div>
          )}
          {r.limited && <p className="text-muted-foreground text-xs">{t(r.limited === "searches" ? "tools.researchLimitSearches" : "tools.researchLimitSteps")}</p>}
          {r.sources.length > 0 && (
            <div>
              <p className={section}>{t("tools.researchSources")}</p>
              <ul className="grid gap-x-3 gap-y-1 sm:grid-cols-2">
                {r.sources.map((source) => (
                  <li key={source.url} className="min-w-0">
                    <a href={source.url} target="_blank" rel="noreferrer" className="hover:bg-muted/60 flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs">
                      <Favicon />
                      <span className="truncate">{source.title}</span>
                      <span className="text-muted-foreground shrink-0">{host(source.url)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
