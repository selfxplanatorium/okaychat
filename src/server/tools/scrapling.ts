import { spawnSync } from "node:child_process";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";

// Scrapling 0.5 runs as one shared stdio MCP server (`scrapling mcp`). It only fetches public URLs and holds
// no user data, so sharing it across users is safe. Tool names changed in 0.5; see docs/research/scrapling.md.

const COMMAND = process.env.OKAYCHAT_SCRAPLING_COMMAND ?? "scrapling";
// The image installs Chromium only when built with SCRAPLING_BROWSER=true.
const BROWSER = process.env.OKAYCHAT_SCRAPLING_BROWSER === "true";
const IDLE_MS = 5 * 60_000;

let available: boolean | null = null;
let client: Promise<MCPClient> | null = null;
let idleTimer: NodeJS.Timeout | null = null;

function isAvailable(): boolean {
  if (available === null) {
    available = spawnSync(COMMAND, ["--help"], { stdio: "ignore", timeout: 10_000 }).status === 0;
  }
  return available;
}

function getClient(): Promise<MCPClient> {
  client ??= createMCPClient({
    clientName: "okaychat",
    // Scrapling's Python MCP server rejects the client's fallback handshake after discovery. See docs/research/mcp.md.
    protocolVersionDiscovery: false,
    initializationOptions: { timeout: 30_000 },
    // The stdio transport passes only an env allowlist (PATH, HOME, ...), so forward Playwright's browser path.
    transport: new Experimental_StdioMCPTransport({
      command: COMMAND,
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

async function call(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ScraplingResponse | null> {
  try {
    const c = await getClient();
    touch();
    const result = (await c.callTool({ name, arguments: args, options: { timeout: timeoutMs } })) as {
      isError?: boolean;
      structuredContent?: ScraplingResponse;
      content?: Array<{ type: string; text?: string }>;
    };
    if (result.isError) return null;
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.find((p) => p.type === "text")?.text;
    return text ? (JSON.parse(text) as ScraplingResponse) : null;
  } catch (error) {
    // A dead process is restarted on the next call.
    if (/closed|ECONNRESET|EPIPE/i.test(String(error))) client = null;
    return null;
  }
}

const usable = (r: ScraplingResponse | null) => !!r && (r.status ?? 0) < 400 && (r.content ?? []).join("").trim().length > 200;

/** Fetch a page Node's fetch could not read: TLS-impersonated HTTP first, then a stealth browser if installed. */
export async function scraplingFetch(url: string): Promise<{ title: string; content: string } | null> {
  if (!isAvailable()) return null;
  let response = await call("make_request", { url, extraction_type: "markdown", main_content_only: true, impersonate: "chrome", stealthy_headers: true }, 45_000);
  if (!usable(response) && BROWSER) {
    response = await call(
      "browser_fetch_once",
      { url, extraction_type: "markdown", main_content_only: true, headless: true, network_idle: true, solve_cloudflare: true, disable_resources: true },
      120_000,
    );
  }
  if (!usable(response)) return null;
  const content = response!.content!.join("\n\n").trim();
  const heading = content.match(/^#\s+(.+)$/m)?.[1];
  return { title: heading ?? url, content };
}
