import { defineToolkit } from "@assistant-ui/react";
import { BookOpenIcon, BotIcon, ChevronDownIcon, DownloadIcon, FileTextIcon, GlobeIcon, ImageIcon, Loader2Icon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { SimpleMarkdown } from "@/components/ui/simple-markdown";
import { formatCost } from "@/lib/api";
import { useData } from "@/state/data";
import { cn } from "@/lib/utils";

type SearchResult = { title: string; url: string; snippet: string };

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function Favicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <GlobeIcon className="text-muted-foreground size-3.5 shrink-0" />;
  return <img src={`https://icons.duckduckgo.com/ip3/${host(url)}.ico`} alt="" className="size-3.5 shrink-0 rounded-sm" onError={() => setFailed(true)} />;
}

function ToolShell({ icon, label, running, error, children }: { icon: ReactNode; label: ReactNode; running: boolean; error?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2 text-sm">
      <button type="button" onClick={() => setOpen(!open)} className="text-muted-foreground hover:text-foreground flex max-w-full items-center gap-2" disabled={!children}>
        {running ? <Loader2Icon className="size-4 animate-spin" /> : error ? <TriangleAlertIcon className="text-warning size-4" /> : icon}
        <span className={cn("truncate", running && "shimmer")}>{label}</span>
        {children && <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />}
      </button>
      {error && <p className="text-muted-foreground mt-1 ml-6 text-xs">{error}</p>}
      {open && children && <div className="mt-2 ml-6">{children}</div>}
    </div>
  );
}

export const toolkit = defineToolkit({
  web_search: {
    type: "backend",
    render: ({ args, result, status }) => {
      const r = result as { engine?: string; results?: SearchResult[] } | undefined;
      const results = r?.results ?? [];
      const running = status?.type === "running";
      const error = status?.type === "incomplete" ? "Search failed" : undefined;
      const query = (args as { query?: string })?.query ?? "";
      return (
        <ToolShell icon={<SearchIcon className="size-4" />} running={running} error={error} label={running ? `Searching “${query}”` : `Searched “${query}” · ${results.length} results`}>
          {results.length > 0 && (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {results.map((res) => (
                <a key={res.url} href={res.url} target="_blank" rel="noreferrer" className="hover:bg-muted/60 flex flex-col gap-0.5 rounded-lg border px-2.5 py-2">
                  <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <Favicon url={res.url} /> {host(res.url)}
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
      const r = result as { title?: string; via?: string; pages?: number; content?: string } | undefined;
      const running = status?.type === "running";
      const error = status?.type === "incomplete" ? "Could not read the page" : undefined;
      return (
        <ToolShell
          icon={<FileTextIcon className="size-4" />}
          running={running}
          error={error}
          label={
            <>
              {running ? "Reading " : "Read "}
              <a href={url} target="_blank" rel="noreferrer" className="hover:underline" onClick={(e) => e.stopPropagation()}>
                {r?.title || host(url)}
              </a>
              {r?.via === "scrapling" && " (via Scrapling)"}
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
    render: ({ args, status }) => (
      <ToolShell icon={<BookOpenIcon className="size-4" />} running={status?.type === "running"} label={`Read artifact ${(args as { id?: string })?.id ?? ""}`} />
    ),
  },
  delegate_task: {
    type: "backend",
    render: ({ args, result, status }) => <SubagentCard args={args} result={result} running={status?.type === "running"} />,
  },
  generate_image: {
    type: "backend",
    render: ({ args, result, status }) => <GeneratedImage args={args} result={result} running={status?.type === "running"} />,
  },
});

function GeneratedImage({ args, result, running }: { args: unknown; result: unknown; running: boolean }) {
  const prompt = (args as { prompt?: string })?.prompt ?? "";
  const image = result as { id?: string; url?: string; width?: number; height?: number } | string | undefined;
  if (running || !image) {
    return (
      <div className="bg-muted/40 my-2 flex aspect-square w-full max-w-sm flex-col items-center justify-center gap-2 rounded-xl border p-4 text-center">
        <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
        <span className="shimmer text-sm">Generating image…</span>
        <span className="text-muted-foreground line-clamp-3 text-xs">{prompt}</span>
      </div>
    );
  }
  if (typeof image === "string" || !image.url) {
    return <ToolShell icon={<ImageIcon className="size-4" />} running={false} error={typeof image === "string" ? image : "No image"} label="Image generation failed" />;
  }
  return (
    <figure className="group/img relative my-2 w-fit max-w-full">
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
        download={`${image.id}.png`}
        aria-label="Download image"
        className="surface-glass text-muted-foreground hover:text-foreground absolute top-2 right-2 rounded-lg border p-1.5 opacity-0 transition-opacity group-hover/img:opacity-100"
      >
        <DownloadIcon className="size-4" />
      </a>
    </figure>
  );
}

type SubagentProgress = { model: string; status: "running" | "done"; text: string; steps: number; tools: string[]; cost?: number };

function SubagentCard({ args, result, running }: { args: unknown; result: unknown; running: boolean }) {
  const [open, setOpen] = useState(false);
  const models = useData((s) => s.models);
  const a = (args ?? {}) as { task?: string; model?: string };
  const r = typeof result === "object" && result ? (result as SubagentProgress) : undefined;
  const failed = !running && typeof result === "string";
  const busy = running || r?.status === "running";
  const ref = r?.model ?? a.model;
  const name = models.find((m) => m.ref === ref)?.name ?? ref?.split("/").pop() ?? "Sub-agent";
  const detail = [
    r?.steps ? `${r.steps} step${r.steps === 1 ? "" : "s"}` : null,
    r?.tools.length ? `${r.tools.length} tool call${r.tools.length === 1 ? "" : "s"}` : null,
    r?.cost ? formatCost(r.cost) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="my-2 rounded-xl border text-sm">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
        <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-lg">
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : failed ? <TriangleAlertIcon className="text-warning size-4" /> : <BotIcon className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate font-medium", busy && "shimmer")}>{busy ? `${name} is working` : failed ? `${name} failed` : `${name} finished`}</span>
          <span className="text-muted-foreground block truncate text-xs">{failed ? (result as string) : detail || a.task}</span>
        </span>
        <ChevronDownIcon className={cn("text-muted-foreground size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t px-3 py-3">
          {a.task && (
            <div>
              <p className="text-muted-foreground mb-1 text-xs font-medium">Task</p>
              <p className="text-muted-foreground text-xs whitespace-pre-wrap">{a.task}</p>
            </div>
          )}
          {r?.text && (
            <div>
              <p className="text-muted-foreground mb-1 text-xs font-medium">Report</p>
              <SimpleMarkdown className="max-h-96 overflow-auto">{r.text}</SimpleMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
