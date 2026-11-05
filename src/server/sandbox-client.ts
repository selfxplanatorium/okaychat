import { readCapped } from "./public-fetch.js";
import { newId, sha256 } from "./crypto.js";
import { env } from "./env.js";
import { assertServiceAvailable, reportServiceFailure, reportServiceSuccess, serviceUnavailable } from "./services.js";

// Internal authenticated transport for the sandbox container. The existing run_code tool and the new
// one-shot Python function mode share this: availability, the bearer token, timeouts, and failure
// reporting. Workspace, thread and persistence policy stay in the callers.

export const sandboxConfigured = () => !!env.sandboxUrl && env.sandboxToken.length >= 32;

/** The runner's /health (no token). 503 means it is up but refuses every run because isolation failed. */
export async function sandboxHealthy(signal: AbortSignal): Promise<boolean> {
  const res = await fetch(`${env.sandboxUrl}/health`, { signal });
  await res.body?.cancel().catch(() => {});
  return res.ok;
}

/** A non-2xx answer that the caller must interpret: 409/422 are request/code failures, 429 capacity. */
export class SandboxHttpError extends Error {
  constructor(readonly status: number, readonly body: { error?: string }) {
    super(body.error ?? `Sandbox request failed (${status}).`);
    this.name = "SandboxHttpError";
  }
}

/**
 * One request to the runner. `guarded: false` is for cleanup (cancel, workspace delete) and the health
 * check, which must still reach a runner the registry has just marked down. Transport failures mark the
 * service down unless the caller's signal aborted first.
 */
export async function sandboxCall(
  route: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
  signal?: AbortSignal,
  guarded = true,
): Promise<Response> {
  if (guarded) assertServiceAvailable("sandbox");
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${env.sandboxUrl}${route}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${env.sandboxToken}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw new Error("Cancelled.");
    if (timeout.aborted) throw new Error("The code sandbox did not answer in time.", { cause: error });
    reportServiceFailure("sandbox");
    throw serviceUnavailable("sandbox");
  }
  if (res.status === 503) {
    await res.body?.cancel().catch(() => {});
    reportServiceFailure("sandbox");
    throw serviceUnavailable("sandbox");
  }
  if (res.ok) {
    reportServiceSuccess("sandbox");
    return res;
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  // 400/409/422/429 are this call's problem (validation, code, capacity), not a service outage.
  reportServiceSuccess("sandbox");
  throw new SandboxHttpError(res.status, body);
}

export interface SandboxFunctionResult {
  exitCode: number | null;
  stopped: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutOverflow: boolean;
  stderrOverflow: boolean;
}

export interface SandboxFunctionOptions {
  runId: string;
  code: string;
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** A one-use workspace id derived from the run id, never from anything the client sends. */
export const functionWorkspace = (runId: string) => sha256(`custom-function:${runId}`).slice(0, 32);

/**
 * One Python function execution. There is no queue beyond the worker's short slot wait: a busy worker
 * answers 429. The app's deadline includes transport and cleanup, and an abort sends the job's cancel.
 */
export async function runSandboxFunction(opts: SandboxFunctionOptions): Promise<SandboxFunctionResult> {
  if (!sandboxConfigured()) throw serviceUnavailable("sandbox");
  const ws = functionWorkspace(opts.runId);
  const job = newId("cfn");
  const cancel = () => void sandboxCall(`/workspaces/${ws}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job }),
  }, 5_000, undefined, false).catch(() => {});
  opts.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const res = await sandboxCall(
      `/workspaces/${ws}/function`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job, code: opts.code, input: opts.input, timeoutMs: opts.timeoutMs }) },
      opts.timeoutMs + 7_000,
      opts.signal,
    );
    const bytes = await readCapped(res, 256 * 1024, "The sandbox response was too large.");
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Partial<SandboxFunctionResult>;
    if (typeof parsed.stdout !== "string" || typeof parsed.stderr !== "string") throw new Error("The sandbox returned an invalid result.");
    return {
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : null,
      stopped: typeof parsed.stopped === "string" ? parsed.stopped : null,
      durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : 0,
      stdout: parsed.stdout,
      stderr: parsed.stderr,
      stdoutOverflow: parsed.stdoutOverflow === true,
      stderrOverflow: parsed.stderrOverflow === true,
    };
  } finally {
    opts.signal?.removeEventListener("abort", cancel);
  }
}
