import { spawnSync } from "node:child_process";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { config } from "./config.js";
import { localEgressProxy } from "./egress-proxy.js";

// Scrapling 0.5 is the web_fetch fallback for pages that block plain HTTP or need JavaScript. It fetches only
// public URLs, through the egress proxy. It runs over stdio as a child of the fetch process, under the same user
// (`scrape` in the container), so there is no port or token another local process could use. See
// docs/implementation/scrapling.md.

const IDLE_MS = 5 * 60_000;

let available: boolean | null = null;
let client: Promise<MCPClient> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let active = 0;

function isAvailable(): boolean {
  available ??= spawnSync(config.scraplingCommand, ["--help"], { stdio: "ignore", timeout: 10_000 }).status === 0;
  return available;
}

function getClient(): Promise<MCPClient> {
  client ??= createMCPClient({
    clientName: "okaychat",
    // Scrapling's Python MCP server rejects the client's fallback handshake after discovery. See docs/implementation/mcp.md.
    protocolVersionDiscovery: false,
    initializationOptions: { timeout: 30_000 },
    // The stdio transport passes only an env allowlist (PATH, HOME, ...), so forward Playwright's browser path.
    transport: new Experimental_StdioMCPTransport({
      command: config.scraplingCommand,
      args: ["mcp"],
      stderr: "ignore",
      env: process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : undefined,
    }),
  }).catch((error) => {
    client = null;
    throw error;
  });
  return client;
}

function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const current = client;
    client = null;
    void current?.then((c) => c.close()).catch(() => {});
  }, IDLE_MS);
  idleTimer.unref();
}

interface ScraplingResponse {
  status?: number;
  content?: string[];
  url?: string;
}

async function call(name: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<ScraplingResponse | null> {
  try {
    const c = await getClient();
    touch();
    const result = (await c.callTool({ name, arguments: args, options: { timeout: timeoutMs, signal } })) as {
      isError?: boolean;
      structuredContent?: ScraplingResponse;
      content?: Array<{ type: string; text?: string }>;
    };
    if (result.isError) return null;
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.find((p) => p.type === "text")?.text;
    return text ? (JSON.parse(text) as ScraplingResponse) : null;
  } catch (error) {
    // A dead process or connection is reopened on the next call.
    if (/closed|ECONNRESET|EPIPE|ECONNREFUSED|fetch failed/i.test(String(error))) client = null;
    return null;
  }
}

const usable = (r: ScraplingResponse | null) => !!r && (r.status ?? 0) < 400 && (r.content ?? []).join("").trim().length > 200;

/** Longest page text handed back to the app. web_fetch truncates further for the model. */
const MAX_CONTENT = 2_000_000;

export const scraplingReady = () => isAvailable();

/** Fetch a page Node's fetch could not read: TLS-impersonated HTTP first, then a stealth browser if installed. */
export async function scraplingFetch(url: string, signal?: AbortSignal): Promise<{ title: string; content: string } | null> {
  if (!isAvailable()) return null;
  if (active >= config.maxFetches) return null;
  active++;
  try {
    // Scrapling connects on its own; the proxy applies the public-address check to every hop it makes. In the
    // container the firewall also stops any connection that does not go through it.
    const proxy = config.egressProxy || (await localEgressProxy());
    let response = await call("make_request", { url, proxy, extraction_type: "markdown", main_content_only: true, impersonate: "chrome", stealthy_headers: true }, 45_000, signal);
    if (!usable(response) && config.scraplingBrowser && !signal?.aborted) {
      response = await call(
        "browser_fetch_once",
        { url, proxy, extraction_type: "markdown", main_content_only: true, headless: true, network_idle: true, solve_cloudflare: true, disable_resources: true },
        120_000,
        signal,
      );
    }
    if (!usable(response)) return null;
    const content = response!.content!.join("\n\n").trim().slice(0, MAX_CONTENT);
    const heading = content.match(/^#\s+(.+)$/m)?.[1];
    return { title: heading ?? url, content };
  } finally {
    active--;
  }
}
