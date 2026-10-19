import { ChevronRightIcon, KeyRoundIcon, Loader2Icon, PencilIcon, PlusIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import type { McpApproval, McpServerConfig, McpServerInfo, McpTransport } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { SettingsPage, SettingsSection } from "./SettingsUI";

type ServerView = McpServerInfo & { authorizationUrl?: string };

// Keyless remote servers that work out of the box.
const PRESETS: Array<{ name: string; url: string; note: string }> = [
  { name: "Context7", url: "https://mcp.context7.com/mcp", note: "Up-to-date library docs" },
  { name: "DeepWiki", url: "https://mcp.deepwiki.com/mcp", note: "Ask questions about GitHub repos" },
];

const STATUS: Record<McpServerInfo["status"], { label: string; dot: string }> = {
  connected: { label: "Connected", dot: "bg-success" },
  connecting: { label: "Connecting", dot: "bg-warning animate-pulse" },
  idle: { label: "Idle (connects on use)", dot: "bg-muted-foreground/50" },
  error: { label: "Error", dot: "bg-error" },
  "needs-auth": { label: "Needs authorization", dot: "bg-warning" },
  disabled: { label: "Disabled", dot: "bg-muted-foreground/30" },
};

const toLines = (rec?: Record<string, string>) => Object.entries(rec ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
const fromLines = (text: string, sep: "=" | ":") =>
  Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(sep);
        return i === -1 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );

function ServerForm({ initial, onDone }: { initial?: ServerView; onDone: () => void }) {
  const isAdmin = useData((s) => s.me?.role === "admin");
  const refresh = useData((s) => s.refreshMcp);
  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(initial?.transport ?? "http");
  const [url, setUrl] = useState(initial?.config.url ?? "");
  const [headers, setHeaders] = useState(toLines(initial?.config.headers).replaceAll("=", ": "));
  const [command, setCommand] = useState([initial?.config.command, ...(initial?.config.args ?? [])].filter(Boolean).join(" "));
  const [env, setEnv] = useState(toLines(initial?.config.env));
  const [timeout, setTimeoutSec] = useState(String((initial?.config.timeoutMs ?? 120_000) / 1000));
  const [approval, setApproval] = useState<McpApproval>(initial?.config.approval ?? "destructive");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const [cmd, ...args] = command.trim().split(/\s+/);
    const config: McpServerConfig =
      transport === "stdio"
        ? { command: cmd, args, env: fromLines(env, "="), timeoutMs: Number(timeout) * 1000, approval }
        : { url, headers: fromLines(headers, ":"), timeoutMs: Number(timeout) * 1000, approval };
    try {
      const body = { name, transport, enabled: initial?.enabled ?? true, config };
      if (initial) await api(`/mcp/${initial.id}`, { method: "PUT", json: body });
      else await api("/mcp", { method: "POST", json: body });
      await refresh();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="animate-rise-in flex flex-col gap-3 px-4 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <Input placeholder="Name (e.g. github)" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        <Select
          value={transport}
          onValueChange={setTransport}
          aria-label="Transport"
          options={[
            { value: "http", label: "Streamable HTTP" },
            { value: "sse", label: "SSE (legacy)" },
            ...(isAdmin ? [{ value: "stdio" as const, label: "stdio (local command)" }] : []),
          ]}
        />
      </div>
      {transport === "stdio" ? (
        <>
          <Input placeholder="Command, e.g. npx -y @modelcontextprotocol/server-everything" value={command} onChange={(e) => setCommand(e.target.value)} required />
          <Textarea placeholder={"Environment, one per line\nAPI_KEY=..."} value={env} onChange={(e) => setEnv(e.target.value)} className="min-h-20 font-mono text-xs" />
          <p className="text-muted-foreground text-xs">Runs inside the okaychat container as the server user. Only admins can add stdio servers.</p>
        </>
      ) : (
        <>
          <Input placeholder="https://example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} type="url" required />
          <Textarea
            placeholder={"Headers, one per line (optional)\nAuthorization: Bearer ..."}
            value={headers}
            onChange={(e) => setHeaders(e.target.value)}
            className="min-h-16 font-mono text-xs"
          />
          <p className="text-muted-foreground text-xs">Servers that use OAuth show an Authorize button after you add them.</p>
        </>
      )}
      <label className="text-muted-foreground flex items-center gap-2 text-xs">
        Tool timeout
        <Input className="h-7 w-20" type="number" min={1} max={3600} value={timeout} onChange={(e) => setTimeoutSec(e.target.value)} />
        seconds
      </label>
      <label className="text-muted-foreground flex items-center gap-2 text-xs">
        Ask before running
        <Select
          className="h-7 w-auto"
          value={approval}
          onValueChange={setApproval}
          aria-label="Approval"
          options={[
            { value: "destructive", label: "Tools marked destructive" },
            { value: "always", label: "Every tool" },
            { value: "never", label: "Never" },
          ]}
        />
      </label>
      {error && <p className="text-error settings-error text-xs">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2Icon className="animate-spin" />}
          {initial ? "Save" : "Add server"}
        </Button>
      </div>
    </form>
  );
}

function ServerRow({ server, index }: { server: ServerView; index: number }) {
  const refresh = useData((s) => s.refreshMcp);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = STATUS[server.status];

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (editing) return <ServerForm initial={server} onDone={() => setEditing(false)} />;

  return (
    <div className="stagger animate-rise-in px-4 py-3" style={{ "--i": index } as CSSProperties}>
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronRightIcon className={cn("text-muted-foreground size-4 transition-transform duration-(--motion-fast) ease-out-quart", open && "rotate-90")} />
          <span className={cn("size-2 shrink-0 rounded-full transition-colors duration-(--motion-base)", status.dot)} />
          <span className="truncate text-sm font-medium">{server.name}</span>
          <span className="text-muted-foreground truncate text-xs">
            {server.transport} · {status.label}
            {server.tools.length ? ` · ${server.tools.filter((t) => t.enabled).length}/${server.tools.length} tools` : ""}
          </span>
        </button>
        {server.status === "needs-auth" && server.authorizationUrl && (
          <Button
            size="sm"
            onClick={() => {
              window.open(server.authorizationUrl, "okaychat-mcp-oauth", "width=520,height=720");
            }}
          >
            <KeyRoundIcon /> Authorize
          </Button>
        )}
        <Button size="icon-sm" variant="ghost" aria-label="Reconnect" disabled={busy} onClick={() => act(() => api(`/mcp/${server.id}/test`, { method: "POST" }))}>
          <RefreshCwIcon className={cn(busy && "animate-spin")} />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Edit" onClick={() => setEditing(true)}>
          <PencilIcon />
        </Button>
        <Switch
          checked={server.enabled}
          aria-label={`Enable ${server.name}`}
          onCheckedChange={(enabled) =>
            act(() => api(`/mcp/${server.id}`, { method: "PUT", json: { name: server.name, transport: server.transport, enabled, config: server.config } }))
          }
        />
        <Button size="icon-sm" variant="ghost" aria-label="Delete" onClick={() => act(() => api(`/mcp/${server.id}`, { method: "DELETE" }))}>
          <TrashIcon />
        </Button>
      </div>
      {server.error && server.status === "error" && <p className="text-error animate-fade-in mt-2 ml-10 text-xs">{server.error}</p>}
      {open && (
        <div className="settings-collapse mt-3 ml-10">
          <div className="flex flex-col gap-1">
            {server.tools.length === 0 && <p className="text-muted-foreground text-xs">No tools yet. Reconnect to list them.</p>}
            {server.tools.map((tool) => (
              <label key={tool.name} className="hover:bg-muted/50 flex items-start gap-3 rounded-lg px-2 py-1.5 transition-colors duration-(--motion-fast)">
                <Switch
                  className="mt-0.5"
                  checked={tool.enabled}
                  onCheckedChange={(enabled) => {
                    const disabled = server.tools.filter((t) => (t.name === tool.name ? !enabled : !t.enabled)).map((t) => t.name);
                    void act(() => api(`/mcp/${server.id}/tools`, { method: "PATCH", json: { disabledTools: disabled } }));
                  }}
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 font-mono text-xs">
                    {tool.name}
                    {tool.needsApproval && <span className="bg-warning/12 text-warning rounded px-1 py-px font-sans text-[10px] font-medium">asks first</span>}
                  </span>
                  {tool.description && <span className="text-muted-foreground line-clamp-2 block text-xs">{tool.description}</span>}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function McpSettings() {
  const servers = useData((s) => s.mcp);
  const refresh = useData((s) => s.refreshMcp);
  const [adding, setAdding] = useState(false);

  // The OAuth popup posts back when it finishes.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin && (e.data as { type?: string })?.type === "okaychat:mcp-oauth") void refresh();
    };
    window.addEventListener("message", onMessage);
    void refresh();
    return () => window.removeEventListener("message", onMessage);
  }, [refresh]);

  const installed = new Set(servers.map((s) => s.name.toLowerCase()));

  return (
    <SettingsPage
      title="MCP servers"
      description="Connect Model Context Protocol servers to give models tools. Connections open on first use, time out per call, reconnect once on failure, and close when idle."
    >
      <SettingsSection
        title="Your servers"
        action={
          !adding && (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon /> Add server
            </Button>
          )
        }
      >
        {adding && <ServerForm onDone={() => setAdding(false)} />}
        {servers.map((s, index) => (
          <ServerRow key={s.id} server={s} index={index} />
        ))}
        {!adding && servers.length === 0 && <p className="text-muted-foreground animate-fade-in px-4 py-6 text-center text-sm">No servers yet.</p>}
      </SettingsSection>
      <SettingsSection title="Quick add" description="Public servers that need no key.">
        {PRESETS.filter((p) => !installed.has(p.name.toLowerCase())).map((p, index) => (
          <div key={p.name} className="stagger animate-rise-in flex items-center justify-between gap-3 px-4 py-3" style={{ "--i": index } as CSSProperties}>
            <div>
              <div className="text-sm font-medium">{p.name}</div>
              <div className="text-muted-foreground text-xs">{p.note}</div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await api("/mcp", { method: "POST", json: { name: p.name, transport: "http", enabled: true, config: { url: p.url } } });
                await refresh();
              }}
            >
              <PlusIcon /> Add
            </Button>
          </div>
        ))}
      </SettingsSection>
    </SettingsPage>
  );
}
