// Settings of the browser worker, all from its own environment. It never reads the app's environment or data:
// in the container it gets none of them, and in dev `npm run dev:browser` starts it with this list only.

const number = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export type Role = "all" | "dispatch" | "render" | "fetch";

export const config = {
  /**
   * all: one process does everything (dev and tests). In the container: dispatch is the authenticated job API and
   * runs no browser; render is one slot (one job at a time, its own uid); fetch runs Scrapling (its own uid).
   */
  role: (["dispatch", "render", "fetch"].includes(process.env.BROWSER_ROLE ?? "") ? process.env.BROWSER_ROLE : "all") as Role,
  /** dispatch: the render slots and the fetch server, on loopback. */
  slots: (process.env.BROWSER_SLOTS ?? "").split(",").filter(Boolean),
  fetchUrl: process.env.BROWSER_FETCH_URL ?? "",
  /** render slots: exit after each job, so no browser or process memory outlives it (the supervisor restarts it). */
  exitAfterJob: process.env.BROWSER_EXIT_AFTER_JOB === "1",
  port: number(process.env.BROWSER_PORT, 8080),
  host: process.env.BROWSER_HOST ?? "0.0.0.0",
  /** Written by the app; the bearer token every job must carry. */
  tokenFile: process.env.BROWSER_TOKEN_FILE ?? "",
  /** Set by the container entrypoint once the firewall is in place. Reported by /health, never assumed. */
  egressEnforced: process.env.BROWSER_EGRESS_ENFORCED === "1",
  /** The egress proxy, a separate process in the container. Unset in dev: the worker starts one in-process. */
  egressProxy: process.env.BROWSER_EGRESS_PROXY ?? "",
  /** Scrapling's MCP server, started over stdio as a child of the fetch process (same user). */
  scraplingCommand: process.env.OKAYCHAT_SCRAPLING_COMMAND ?? "scrapling",
  /** Whether Scrapling may fall back to its stealth browser (the image installs Chromium only when built so). */
  scraplingBrowser: process.env.OKAYCHAT_SCRAPLING_BROWSER === "true",
  chromiumPath: process.env.OKAYCHAT_CHROMIUM_PATH ?? "",
  jobTimeoutMs: number(process.env.BROWSER_JOB_TIMEOUT_MS, 25_000),
  maxJobs: number(process.env.BROWSER_MAX_JOBS, 2),
  /** How long a job may wait for a free slot before the worker answers busy. */
  queueMs: number(process.env.BROWSER_QUEUE_MS, 30_000),
  maxFetches: number(process.env.BROWSER_MAX_FETCHES, 2),
};
