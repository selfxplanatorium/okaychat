import { defineToolkit } from "@assistant-ui/react";
import { BookOpenIcon, ChevronDownIcon, FileTextIcon, GlobeIcon, Loader2Icon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
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
});
