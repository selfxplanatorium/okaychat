import { useAui } from "@assistant-ui/react";
import { AppWindowIcon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { api, ApiError } from "@/lib/api";

// MCP Apps (the `io.modelcontextprotocol/ui` extension): a tool names a `ui://` HTML resource, the chat
// renders it with the call's input and result, and the page talks to the host over postMessage JSON-RPC.
// The frame is a null-origin srcdoc sandbox (no `allow-same-origin`), like artifacts, so it cannot read the
// app's cookies or DOM, and no third-party frame host is involved. Every request it makes goes through our
// API on the user's own MCP connection.

type AppRef = { serverId: string; resourceUri: string };
type AppResource = { uri: string; html: string; meta?: { prefersBorder?: boolean; csp?: Record<string, unknown> } };
type JsonRpc = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: Record<string, unknown> };

const PROTOCOL_VERSION = "2026-01-26";
const MAX_HEIGHT = 800;

/** A tool result carrying an MCP App: the `{ text, app, result }` shape the server sends. */
export function mcpAppOf(result: unknown): { app: AppRef; result: unknown } | null {
  const r = result as { app?: AppRef; result?: unknown } | null;
  return r?.app && typeof r.app.serverId === "string" && typeof r.app.resourceUri === "string" && r.app.resourceUri.startsWith("ui://")
    ? { app: r.app, result: r.result }
    : null;
}

const resources = new Map<string, Promise<AppResource>>();
function loadResource(app: AppRef): Promise<AppResource> {
  const key = `${app.serverId} ${app.resourceUri}`;
  let pending = resources.get(key);
  if (!pending) {
    pending = api<AppResource>(`/mcp/${app.serverId}/app/resource`, { method: "POST", json: { uri: app.resourceUri } });
    // A failed load is retried on the next mount instead of being cached.
    pending.catch(() => resources.delete(key));
    resources.set(key, pending);
  }
  return pending;
}

/** Origins only, https (and wss for connections), with no characters that could break out of the policy. */
function origins(values: unknown, sockets = false): string[] {
  if (!Array.isArray(values)) return [];
  const scheme = sockets ? /^(https|wss):\/\/[^\s;'"`,]+$/i : /^https:\/\/[^\s;'"`,]+$/i;
  return [...new Set(values.filter((v): v is string => typeof v === "string" && scheme.test(v)))];
}

/**
 * The app may load from the domains its server declared and connect only to those it listed for
 * connections. Without declarations it gets no network at all. Meta CSPs only tighten, so markup later in
 * the document cannot loosen this.
 */
function withCsp(html: string, csp: Record<string, unknown> = {}): string {
  const load = origins(csp.resourceDomains).join(" ");
  const connect = origins(csp.connectDomains, true).join(" ");
  const frames = origins(csp.frameDomains).join(" ");
  const policy = [
    "default-src 'none'",
    `script-src 'unsafe-inline' blob: ${load}`,
    `style-src 'unsafe-inline' ${load}`,
    `img-src data: blob: ${load}`,
    `font-src data: ${load}`,
    `media-src data: blob: ${load}`,
    `connect-src ${connect || "'none'"}`,
    `frame-src ${frames || "'none'"}`,
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  const doctype = html.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? "";
  return doctype + meta + html.slice(doctype.length);
}

const theme = () => (document.documentElement.classList.contains("dark") ? "dark" : "light");
const hostContext = () => ({ theme: theme(), displayMode: "inline", availableDisplayModes: ["inline"], platform: "web" });

const messageText = (params: Record<string, unknown> | undefined) => {
  const content = params?.content;
  const parts = Array.isArray(content) ? content : content ? [content] : [];
  return parts.map((p: { type?: string; text?: string }) => (p?.type === "text" ? (p.text ?? "") : "")).filter(Boolean).join("\n\n");
};

export function McpAppCard({ app, toolName, input, result }: { app: AppRef; toolName: string; input: unknown; result: unknown }) {
  const aui = useAui();
  const frame = useRef<HTMLIFrameElement>(null);
  const [resource, setResource] = useState<AppResource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(240);
  const [confirm, setConfirm] = useState<{ message: string; answer: (ok: boolean) => void } | null>(null);
  // The bridge reads the latest values without re-creating the listener.
  const live = useRef({ input, result });
  live.current = { input, result };

  useEffect(() => {
    let active = true;
    loadResource(app).then(
      (r) => active && setResource(r),
      (e: Error) => active && setError(e.message),
    );
    return () => {
      active = false;
    };
  }, [app.serverId, app.resourceUri]);

  useEffect(() => {
    if (!resource) return;
    const post = (message: object) => frame.current?.contentWindow?.postMessage({ jsonrpc: "2.0", ...message }, "*");
    const notify = (method: string, params: unknown) => post({ method, params });

    const callTool = async (params: Record<string, unknown>, confirmed = false): Promise<unknown> => {
      try {
        return await api(`/mcp/${app.serverId}/app/call`, { method: "POST", json: { name: params.name, arguments: params.arguments ?? {}, confirmed } });
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 409 || confirmed) throw e;
        const ok = await new Promise<boolean>((answer) => setConfirm({ message: e.message, answer }));
        setConfirm(null);
        if (!ok) throw new Error("The user declined this action.");
        return callTool(params, true);
      }
    };

    const handle = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      switch (method) {
        case "ui/initialize":
          return {
            protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
            hostInfo: { name: "okaychat", version: "1" },
            hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, message: { text: {} }, logging: {} },
            hostContext: hostContext(),
          };
        case "ping":
          return {};
        case "tools/call":
          if (typeof params.name !== "string") throw new Error("tools/call needs a name");
          return callTool(params);
        case "resources/read":
          if (typeof params.uri !== "string") throw new Error("resources/read needs a uri");
          return api(`/mcp/${app.serverId}/app/read`, { method: "POST", json: { uri: params.uri } });
        case "ui/open-link": {
          const url = typeof params.url === "string" ? params.url : "";
          if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) links open");
          window.open(url, "_blank", "noopener,noreferrer");
          return {};
        }
        case "ui/message": {
          // Never sent on the app's behalf: the text lands in the composer for the user to send.
          const text = messageText(params);
          if (text) {
            // The thread's composer: inside a message, `aui.composer()` is that message's edit composer.
            const composer = aui.thread().composer();
            const current = composer.getState().text.trim();
            composer.setText(current ? `${current}\n\n${text}` : text);
          }
          return {};
        }
        case "ui/request-display-mode":
          return { mode: "inline" };
        default:
          throw Object.assign(new Error(`Unsupported method: ${method}`), { code: -32601 });
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const msg = event.data as JsonRpc;
      if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return;
      if (msg.id === undefined) {
        if (msg.method === "ui/notifications/initialized") {
          notify("ui/notifications/tool-input", { arguments: live.current.input ?? {} });
          if (live.current.result) notify("ui/notifications/tool-result", live.current.result);
        } else if (msg.method === "ui/notifications/size-changed") {
          const h = Number(msg.params?.height);
          if (Number.isFinite(h) && h > 0) setHeight(Math.min(Math.ceil(h), MAX_HEIGHT));
        }
        return;
      }
      handle(msg.method, msg.params).then(
        (value) => post({ id: msg.id, result: value ?? {} }),
        (e: Error & { code?: number }) => post({ id: msg.id, error: { code: e.code ?? -32603, message: e.message } }),
      );
    };
    window.addEventListener("message", onMessage);

    // Follow theme switches.
    const observer = new MutationObserver(() => notify("ui/notifications/host-context-changed", hostContext()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      window.removeEventListener("message", onMessage);
      observer.disconnect();
    };
  }, [resource, app.serverId, aui]);

  return (
    <div className="animate-rise-in my-2 flex flex-col gap-1.5">
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <AppWindowIcon className="size-3.5" />
        <span className="truncate font-mono">{toolName}</span>
      </div>
      {error ? (
        <p className="text-error text-xs">{t("tools.appLoadFailed", { error })}</p>
      ) : !resource ? (
        <div className="bg-muted/40 flex h-24 items-center justify-center rounded-xl border">
          <Loader2Icon className="text-muted-foreground size-4 animate-spin" />
        </div>
      ) : (
        <iframe
          ref={frame}
          title={toolName}
          sandbox="allow-scripts"
          srcDoc={withCsp(resource.html, resource.meta?.csp)}
          style={{ height }}
          className={resource.meta?.prefersBorder === false ? "w-full border-0" : "w-full rounded-xl border"}
        />
      )}
      {confirm && (
        <div className="bg-muted/40 animate-rise-in flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs">
          <span>{confirm.message}</span>
          <span className="flex shrink-0 gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => confirm.answer(false)}>
              {t("tools.deny")}
            </Button>
            <Button size="sm" onClick={() => confirm.answer(true)}>
              {t("tools.allow")}
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}
